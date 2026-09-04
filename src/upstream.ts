import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "./config.js";
import { resolveServerEnv, UpstreamServerSchema } from "./config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { indexTools } from "./catalog.js";
import { PACKAGE_ROOT } from "./paths.js";

export interface UpstreamServer {
  name: string;
  client: Client;
  tools: Tool[];
}

export const activeUpstreams: UpstreamServer[] = [];
export const serverStatuses: Record<string, 'connected' | 'failed'> = {};

export async function connectSingleUpstream(rawServerConfig: any): Promise<void> {
  // Validate before spawning. This function turns config into a child process, so it
  // is the last place to reject a malformed (or attacker-supplied) server entry.
  const serverConfig = UpstreamServerSchema.parse(rawServerConfig);

  console.error(`Connecting to upstream server: ${serverConfig.name}...`);

  try {
    // Spawn from the gateway's own package root unless the entry says otherwise.
    // Without this, an upstream configured with a relative script path ("tsx
    // src/terminal-server.ts") only starts when the gateway happens to have been
    // launched from the repo — so those servers vanish under Claude Desktop or Cursor.
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      cwd: serverConfig.cwd ?? PACKAGE_ROOT,
      env: { ...process.env, ...(resolveServerEnv(serverConfig.env) || {}) } as Record<string, string>,
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
