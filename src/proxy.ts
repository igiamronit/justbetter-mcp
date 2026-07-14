import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { indexTools, searchTools, markToolInjected } from "./catalog.js";
import { embed } from "./embeddings.js";
import { startLlmProxy } from "./llm-proxy.js";
import { validateToolCall } from "./gates/hallucination.js";
import { requireUserApproval } from "./gates/approval.js";
import { resolveGroupedCall } from "./grouping.js";
import { startDashboard, broadcastEvent } from "./dashboard/server.js";
import { activeUpstreams, connectAllUpstreams } from "./upstream.js";
import { passesPreconditions } from "./gates/precondition.js";

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

/**
 * Executes a single tool call through the full security and dispatch pipeline.
 * This is used for both standard calls and sub-calls inside a batch_call.
 */
async function executeSingleTool(toolName: string, args: any, config: any) {
  // --- Phase 5B Grouping Resolution Seam ---
  const { resolvedToolName, resolvedArgs } = resolveGroupedCall(toolName, args);

  // --- Phase 4 Security Gates ---
  const gateResult = validateToolCall(toolName, args);
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

  const upstream = activeUpstreams.find(u => u.tools.some(t => t.name === resolvedToolName));
  if (!upstream) {
    throw new Error(`Tool ${resolvedToolName} not found in any upstream server.`);
  }

  return await upstream.client.callTool({
    name: resolvedToolName,
    arguments: resolvedArgs,
  });
}

async function main() {
  const configPath = process.argv[2] || "config.json";
  
  // 1. Boot the Dashboard FIRST so it's always accessible
  const dashboardServer = startDashboard(configPath);
  
  // 2. Load config and connect to upstreams (soft-failing on errors)
  const config = loadConfig(configPath);
  await connectAllUpstreams(config);

  // Phase 3: Start the LLM API Proxy (if configured)
  const llmProxyServer = startLlmProxy(config);

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

      // Embed the LLM's refined query and search with a wider net (lower threshold)
      const queryVector = await embed(query);
      const results = searchTools(queryVector, 0.15, 10);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matching tools found for your query. Try rephrasing with more specific terms." }],
        };
      }

      // Return the matching tool schemas so the LLM knows what's available
      const toolDescriptions = results.map(r => {
        if (!passesPreconditions(r.tool_name, r.server_name, config)) {
          return null; // Skip returning this tool if it fails preconditions
        }
        
        const schema = JSON.parse(r.full_schema_json);
        // Mark each discovered tool as injected so the Hallucination Gate allows calling them
        markToolInjected(r.tool_name);
        return `Tool: ${r.tool_name} (score: ${r.score.toFixed(3)})\nDescription: ${r.description}\nParameters: ${JSON.stringify(schema.inputSchema || schema.parameters, null, 2)}`;
      }).filter(Boolean).join('\n\n---\n\n');

      console.error(`[request_tools] Returning ${results.length} tools to LLM (and marking as injectable)`);

      broadcastEvent({
        type: 'discovery_trace',
        prompt: `Fallback request: "${query}"`,
        matchedTools: results.map(r => ({ name: r.tool_name, score: r.score })),
        tokensSaved: 0,
        isFallback: true
      });

      return {
        content: [{ type: "text", text: `Found ${results.length} matching tools:\n\n${toolDescriptions}` }],
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

  // Handle graceful shutdown
  const cleanup = async () => {
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
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
