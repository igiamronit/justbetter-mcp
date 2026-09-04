import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "./config.js";
import { resolveServerEnv, UpstreamServerSchema } from "./config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { indexTools } from "./catalog.js";
import { PACKAGE_ROOT } from "./paths.js";
import path from "path";
import fs from "fs";
import os from "os";

export interface UpstreamServer {
  name: string;
  client: Client;
  tools: Tool[];
}

export const activeUpstreams: UpstreamServer[] = [];
export const serverStatuses: Record<string, 'connected' | 'failed'> = {};

/**
 * Node launchers are batch shims on Windows ("npx.cmd") and bare executables
 * everywhere else. A config written on one OS therefore fails to spawn a single
 * upstream on the other. Normalising at connect time repairs configs copied
 * between machines, which happens the moment two people share a setup.
 */
const SHIMMED_COMMANDS = ["npx", "npm", "yarn", "pnpm", "bunx"];

export function normaliseCommand(command: string): string {
  const bare = command.toLowerCase().endsWith(".cmd") ? command.slice(0, -4) : command;
  if (!SHIMMED_COMMANDS.includes(bare.toLowerCase())) return command;
  return process.platform === "win32" ? bare + ".cmd" : bare;
}

/**
 * Upstream args are often written relative to the gateway ("tsx", "src/terminal-server.ts").
 * Those used to resolve because the child was spawned with the package root as its cwd --
 * which on Windows pins a handle on the install directory and makes `npm install -g` fail
 * with EBUSY while any server is alive. Resolving the paths here keeps those configs
 * working while the child runs somewhere disposable.
 *
 * Only an arg naming something that really exists in the package is rewritten, so flags
 * ("-y") and package names ("@modelcontextprotocol/server-filesystem") pass through.
 */
export function resolveServerArgs(args: string[]): string[] {
  return args.map(arg => {
    if (!arg || arg.startsWith("-") || path.isAbsolute(arg)) return arg;
    const candidate = path.resolve(PACKAGE_ROOT, arg);
    return fs.existsSync(candidate) ? candidate : arg;
  });
}

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
      command: normaliseCommand(serverConfig.command),
      args: resolveServerArgs(serverConfig.args),
      cwd: serverConfig.cwd ?? os.tmpdir(),
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
