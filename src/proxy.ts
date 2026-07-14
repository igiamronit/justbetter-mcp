import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { indexTools, searchTools } from "./catalog.js";
import { embed } from "./embeddings.js";
import { startLlmProxy } from "./llm-proxy.js";
import { validateToolCall } from "./gates/hallucination.js";
import { requireUserApproval } from "./gates/approval.js";
import { markToolInjected } from "./session.js";
import { resolveGroupedCall } from "./grouping.js";
import { startDashboard, broadcastEvent } from "./dashboard/server.js";
import { activeUpstreams, connectAllUpstreams } from "./upstream.js";

// The request_tools schema exposed via MCP tools/list
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
    return { tools: [REQUEST_TOOLS_MCP_SCHEMA] };
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
        const schema = JSON.parse(r.full_schema_json);
        // Mark each discovered tool as injected so the Hallucination Gate allows calling them
        markToolInjected(r.tool_name);
        return `Tool: ${r.tool_name} (score: ${r.score.toFixed(3)})\nDescription: ${r.description}\nParameters: ${JSON.stringify(schema.inputSchema || schema.parameters, null, 2)}`;
      }).join('\n\n---\n\n');

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

    // --- Phase 5B Grouping Resolution Seam ---
    // Translates grouped meta-tools into raw upstream tools. 
    // If not a group, it acts as a transparent passthrough.
    const { resolvedToolName, resolvedArgs } = resolveGroupedCall(toolName, request.params.arguments);

    // --- Phase 4 Security Gates ---
    
    // 1. Hallucination & Schema Validation Gate
    // We MUST validate the ORIGINAL toolName (the group), because that's what was injected and what the args match.
    const gateResult = validateToolCall(toolName, request.params.arguments);
    if (!gateResult.allowed) {
      return {
        content: [{ type: "text", text: `Error: ${gateResult.error}` }],
        isError: true,
      };
    }

    // 2. Human-in-the-Loop Confirmation Gate
    // We MUST check the RESOLVED tool name, so hidden underlying destructive tools trigger approval.
    if (config.destructiveTools && config.destructiveTools.includes(resolvedToolName)) {
      const approved = await requireUserApproval(resolvedToolName, resolvedArgs);
      if (!approved) {
        return {
          content: [{ type: "text", text: "Error: Execution denied by user in the terminal." }],
          isError: true,
        };
      }
    }

    // Normal tool call — find which upstream owns the RESOLVED tool
    const upstream = activeUpstreams.find(u => u.tools.some(t => t.name === resolvedToolName));

    if (!upstream) {
      throw new Error(`Tool ${resolvedToolName} not found in any upstream server.`);
    }

    // Forward the call to the upstream server
    const result = await upstream.client.callTool({
      name: resolvedToolName,
      arguments: resolvedArgs,
    });

    return result;
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
