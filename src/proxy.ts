import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { loadConfig, isPlaceholderApiKey } from "./config.js";
import type { Config } from "./config.js";
import { searchTools, markToolInjected } from "./catalog.js";
import { embed } from "./embeddings.js";
import { startLlmProxy } from "./llm-proxy.js";
import { validateToolCall } from "./gates/hallucination.js";
import { requireUserApproval } from "./gates/approval.js";
import { resolveGroupedCall } from "./grouping.js";
import { startDashboard, broadcastEvent } from "./dashboard/server.js";
import { activeUpstreams, connectAllUpstreams } from "./upstream.js";
import { passesPreconditions } from "./gates/precondition.js";
import { resolveConfigPath } from "./paths.js";

// Silence background logs if running under the TUI
if (process.env.SILENCE_LOGS === "1") {
  console.log = () => {};
  console.error = () => {};
}

const REQUEST_TOOLS_MCP_SCHEMA = {
  name: "request_tools",
  description: "If none of your current tools can fulfill the user's request, call this with a precise description of what capability you need. The system will search for and provide matching tools.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "A clear description of the tool capability you need"
      }
    },
    required: ["query"]
  }
};

const BATCH_CALL_MCP_SCHEMA = {
  name: "batch_call",
  description: "Execute multiple tools sequentially in a single turn to save time.",
  inputSchema: {
    type: "object" as const,
    properties: {
      calls: {
        type: "array",
        description: "List of tools to execute",
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            args: { type: "object" }
          },
          required: ["tool", "args"]
        }
      }
    },
    required: ["calls"]
  }
};

/** Resolves once the initial upstream connect-and-index pass has settled. */
let upstreamsReady: Promise<void> = Promise.resolve();

/**
 * Executes a single tool call through the full security and dispatch pipeline.
 * This is used for both standard calls and sub-calls inside a batch_call.
 */
async function executeSingleTool(toolName: string, args: any, config: Config) {
  // --- Phase 5B Grouping Resolution Seam ---
  const { resolvedToolName, resolvedArgs } = resolveGroupedCall(toolName, args);

  // --- Phase 4 Security Gates ---
  const gateResult = validateToolCall(resolvedToolName, resolvedArgs, config);
  if (!gateResult.allowed) {
    return {
      content: [{ type: "text", text: `Error: ${gateResult.error}` }],
      isError: true,
    };
  }

  if (config.destructiveTools && config.destructiveTools.includes(resolvedToolName)) {
    const approved = await requireUserApproval(resolvedToolName, resolvedArgs);
    if (!approved) {
      return {
        content: [{ type: "text", text: "Error: Execution denied by user in the terminal." }],
        isError: true,
      };
    }
  }

  // Route to the exact server the gate validated against. Searching activeUpstreams by
  // tool name instead would let the first-registered server win whenever two upstreams
  // expose the same name, so the schema checked and the server called could differ.
  const targetServer = gateResult.tool?.server_name;
  const upstream = targetServer
    ? activeUpstreams.find(u => u.name === targetServer)
    : activeUpstreams.find(u => u.tools.some(t => t.name === resolvedToolName));

  if (!upstream) {
    throw new Error(`Tool ${resolvedToolName} not found in any upstream server.`);
  }

  try {
    return await upstream.client.callTool({
      name: resolvedToolName,
      arguments: resolvedArgs
    });
  } catch (e: any) {
    console.error(`[executeSingleTool Error] Tool: ${resolvedToolName}`, e.stack || e);
    throw e;
  }
}

async function main() {
  // Resolved against the launch directory once, so every later read/write of the config
  // hits the same file even though the dashboard and upstreams run with their own cwd.
  const configPath = resolveConfigPath(process.argv[2]);

  // 1. Load config first, then boot the Dashboard before the slow upstream connect
  //    so the management UI is reachable while servers are still coming up.
  const config = loadConfig(configPath);

  // Name the file in play. An installed copy reads ~/.justbetter-mcp/config.json,
  // not the config.json in a checkout, and the only symptom of editing the wrong one
  // is an "invalid API key" error from the provider that points nowhere.
  console.error(`[Proxy] Config: ${configPath}`);
  if (config.llmProxy?.enabled !== false && isPlaceholderApiKey(config)) {
    console.error(`[Proxy] No usable ${config.apiProvider} API key in that file.`);
    console.error(`[Proxy] Mode 1 (chat) will fail until llmProxy.${config.apiProvider}ApiKey is set. Mode 2 (tool discovery) is unaffected.`);
  }

  const dashboardServer = config.dashboard?.enabled === false
    ? undefined
    : startDashboard(configPath, config);

  // Phase 3: Start the LLM API Proxy (Mode 1). Mode 2 clients never touch it, so a
  // config can switch it off rather than holding a port and an API key for nothing.
  // Neither this nor the dashboard depends on upstreams, so both come up first.
  const llmProxyServer = config.llmProxy?.enabled === false ? undefined : startLlmProxy(config);

  const server = new Server(
    { name: "justbetter-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Phase 3: tools/list returns ONLY request_tools (the fallback safety net).
  // The LLM API Proxy handles injecting the real tool schemas dynamically.
  // This keeps the MCP client's static tool list minimal.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [REQUEST_TOOLS_MCP_SCHEMA, BATCH_CALL_MCP_SCHEMA] };
  });

  // Phase 3: Forward tool calls to the correct upstream, with request_tools fallback
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    // Handle the request_tools fallback
    if (toolName === "request_tools") {
      const query = (request.params.arguments as any)?.query;
      if (!query || typeof query !== 'string') {
        return {
          content: [{ type: "text", text: "Error: Please provide a 'query' string describing what tool capability you need." }],
        };
      }

      console.error(`[request_tools] Fallback triggered with query: "${query}"`);

      // First call on a cold start can land while upstreams are still indexing.
      // Waiting is correct; returning "nothing found" would train the model to stop asking.
      await upstreamsReady;

      // Embed the LLM's refined query and search without a threshold restriction, just taking top 4 matches
      const queryVector = await embed(query);
      const connectedServers = activeUpstreams.map(u => u.name);

      // Mode 1 re-injects pinned tools into every request, so excluding them here keeps
      // the four discovery slots for capabilities the model does not already hold.
      // Mode 2 has no such path: request_tools is the only route by which a pinned tool
      // can ever be surfaced to Claude Desktop or Cursor, so it must not filter them out.
      const excludedFromDiscovery = config.semanticPromptInjection ? config.pinnedTools : [];
      const results = searchTools(queryVector, connectedServers, excludedFromDiscovery, -1.0, 4);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matching tools found for your query. Try rephrasing with more specific terms." }],
        };
      }

      // Extract tool names and mark them as injected
      const injectedToolNames: string[] = [];
      for (const r of results) {
        if (passesPreconditions(r.tool_name, r.server_name, config)) {
          markToolInjected(r.tool_name);
          injectedToolNames.push(r.tool_name);
        }
      }

      console.error(`[request_tools] Returning ${results.length} tools to LLM (and marking as injectable)`);

      broadcastEvent({
        type: 'discovery_trace',
        prompt: `Fallback request: "${query}"`,
        matchedTools: results.map(r => ({ name: r.tool_name, score: r.score })),
        tokensSaved: 0,
        isFallback: true
      });

      return {
        content: [{ type: "text", text: `Success: Found ${injectedToolNames.length} matching tools (${injectedToolNames.join(', ')}). They have been seamlessly added to your environment. You may now call them natively on the next turn.` }],
      };
    }

    // Handle the batch_call loop
    if (toolName === "batch_call") {
      const calls = (request.params.arguments as any)?.calls || [];
      if (!Array.isArray(calls)) {
        return { content: [{ type: "text", text: "Error: 'calls' must be an array." }], isError: true };
      }

      console.error(`[batch_call] Executing ${calls.length} batched tools...`);
      const results = [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        try {
          console.error(`  - Step ${i + 1}/${calls.length}: ${call.tool}`);
          const res = await executeSingleTool(call.tool, call.args, config);
          
          if (res.isError) {
            const errorText = (res as any).content?.[0]?.text || "Unknown error";
            console.error(`  - Step ${i + 1}/${calls.length}: ${call.tool} FAILED: ${errorText}`);
            results.push({ tool: call.tool, status: "error", error: errorText });
            break; // Stop execution on first failure to prevent cascading errors
          }
          
          results.push({ tool: call.tool, status: "success", result: res });
        } catch (err: any) {
          console.error(`  - Step ${i + 1}/${calls.length}: ${call.tool} FAILED: ${err.message}`);
          results.push({ tool: call.tool, status: "error", error: err.message });
          // Stop execution on first failure to prevent cascading errors
          break;
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
      };
    }

    // Normal single tool execution
    return await executeSingleTool(toolName, request.params.arguments, config);
  });

  // Handle graceful shutdown. Guarded because several signals fire for one exit
  // (stdin 'close' and 'end' both arrive when an MCP client disconnects).
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("\n[Proxy] Shutting down gracefully...");
    try { await server.close(); } catch (e) {}
    if (dashboardServer) dashboardServer.close();
    if (llmProxyServer) llmProxyServer.close();
    
    // Close upstream clients (which terminates their child processes via the SDK)
    for (const u of activeUpstreams) {
      try { await u.client.close(); } catch (e) {}
    }
    
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.stdin.on('close', cleanup);
  process.stdin.on('end', cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("JustBetter MCP Gateway is running."); // Using stderr to avoid breaking stdio MCP transport

  // Upstream connection is deliberately started AFTER the transport is live and is
  // not awaited here. On a cold install, indexing downloads an ~80MB embedding model
  // and takes far longer than an MCP client's initialize timeout -- so a client that
  // waited for it would give up and report the gateway as failed to start.
  // tools/list is static, so it can be answered immediately; request_tools awaits
  // this promise instead, which is the only handler that needs a populated catalog.
  upstreamsReady = connectAllUpstreams(config).catch(err => {
    console.error("[Proxy] Upstream connection failed:", err?.message ?? err);
  });
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
