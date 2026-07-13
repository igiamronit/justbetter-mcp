import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { connectUpstreams } from "./upstream.js";

async function main() {
  const config = loadConfig("./config.json");
  const upstreams = await connectUpstreams(config);

  const server = new Server(
    { name: "justbetter-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Phase 1: Dumb Proxy - Return all tools from all upstreams
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = upstreams.flatMap(u => u.tools);
    return { tools: allTools };
  });

  // Phase 1: Dumb Proxy - Forward tool calls to the correct upstream
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    
    // Find which upstream owns this tool
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
