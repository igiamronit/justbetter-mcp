import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { connectUpstreams } from "./upstream.js";
import { indexTools, searchTools } from "./catalog.js";
import { embed } from "./embeddings.js";
import { startLlmProxy } from "./llm-proxy.js";

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
  const config = loadConfig("./config.json");
  const upstreams = await connectUpstreams(config);

  // Phase 2: Index all discovered tools into SQLite vector catalog
  console.error("Initializing semantic catalog...");
  for (const upstream of upstreams) {
    await indexTools(upstream.name, upstream.tools);
  }

  // Phase 3: Start the LLM API Proxy (if configured)
  startLlmProxy(config);

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
        return `Tool: ${r.tool_name} (score: ${r.score.toFixed(3)})\nDescription: ${r.description}\nParameters: ${JSON.stringify(schema.inputSchema || schema.parameters, null, 2)}`;
      }).join('\n\n---\n\n');

      console.error(`[request_tools] Returning ${results.length} tools to LLM`);

      return {
        content: [{ type: "text", text: `Found ${results.length} matching tools:\n\n${toolDescriptions}` }],
      };
    }

    // Normal tool call — find which upstream owns this tool
    const upstream = upstreams.find(u => u.tools.some(t => t.name === toolName));

    if (!upstream) {
      throw new Error(`Tool ${toolName} not found in any upstream server.`);
    }

    // Forward the call to the upstream server
    const result = await upstream.client.callTool({
      name: toolName,
      arguments: request.params.arguments,
    });

    return result;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("JustBetter MCP Gateway is running."); // Using stderr to avoid breaking stdio MCP transport
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
