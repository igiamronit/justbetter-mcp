import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "./config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { indexTools } from "./catalog.js";

export interface UpstreamServer {
  name: string;
  client: Client;
  tools: Tool[];
}

export const activeUpstreams: UpstreamServer[] = [];
export const serverStatuses: Record<string, 'connected' | 'failed'> = {};

export async function connectSingleUpstream(serverConfig: any): Promise<void> {
  console.error(`Connecting to upstream server: ${serverConfig.name}...`);
  
  try {
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: { ...process.env, ...(serverConfig.env || {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: "justbetter-mcp-gateway", version: "1.0.0" },
      { capabilities: {} }
    );

    // The transport connect might throw or emit error if process fails to spawn
    await client.connect(transport);
    
    const toolsResponse = await client.listTools();
    
    activeUpstreams.push({
      name: serverConfig.name,
      client,
      tools: toolsResponse.tools,
    });
    
    serverStatuses[serverConfig.name] = 'connected';
    console.error(`Connected to ${serverConfig.name} - found ${toolsResponse.tools.length} tools.`);

    // Auto-index Phase 2
    await indexTools(serverConfig.name, toolsResponse.tools);

  } catch (error: any) {
    console.error(`\n⚠️ Failed to connect to server '${serverConfig.name}': ${error.message}`);
    serverStatuses[serverConfig.name] = 'failed';
  }
}

export async function connectAllUpstreams(config: Config): Promise<void> {
  for (const serverConfig of config.upstreamServers) {
    await connectSingleUpstream(serverConfig);
  }
}

export async function removeUpstream(name: string): Promise<void> {
  const index = activeUpstreams.findIndex(u => u.name === name);
  if (index !== -1) {
    const upstream = activeUpstreams[index]!;
    try {
      await upstream.client.close();
    } catch (e) {
      // ignore
    }
    activeUpstreams.splice(index, 1);
  }
  delete serverStatuses[name];
  console.error(`[Upstream Manager] Removed server: ${name}`);
}
