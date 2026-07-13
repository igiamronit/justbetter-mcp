import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "./config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface UpstreamServer {
  name: string;
  client: Client;
  tools: Tool[];
}

export async function connectUpstreams(config: Config): Promise<UpstreamServer[]> {
  const upstreams: UpstreamServer[] = [];

  for (const serverConfig of config.upstreamServers) {
    console.error(`Connecting to upstream server: ${serverConfig.name}...`);
    
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: { ...process.env, ...(serverConfig.env || {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: "justbetter-mcp-gateway", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    
    const toolsResponse = await client.listTools();
    
    upstreams.push({
      name: serverConfig.name,
      client,
      tools: toolsResponse.tools,
    });
    console.error(`Connected to ${serverConfig.name} - found ${toolsResponse.tools.length} tools.`);
  }

  return upstreams;
}
