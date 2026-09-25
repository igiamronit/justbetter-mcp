import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Config } from "./config.js";
import { resolveServerEnv, UpstreamServerSchema } from "./config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { indexTools } from "./catalog.js";
import { PACKAGE_ROOT, invocationCwd, resolveTsxPath } from "./paths.js";
import path from "path";
import fs from "fs";
import os from "os";

export interface UpstreamServer {
  name: string;
  client: Client;
  tools: Tool[];
}

export const activeUpstreams: UpstreamServer[] = [];
export const serverStatuses: Record<string, 'connected' | 'failed' | 'skipped'> = {};

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
 * Tokens that let a config start one of the servers bundled inside this package without
 * knowing where it was installed.
 *
 * `${JUSTBETTER_NODE}` is the interpreter already running the gateway, and
 * `${JUSTBETTER_TSX}` is the tsx CLI beside it. Together they replace `npx tsx <file>`,
 * which only works in a git checkout -- see resolveTsxPath() for why.
 */
export const NODE_TOKEN = "${JUSTBETTER_NODE}";
export const TSX_TOKEN = "${JUSTBETTER_TSX}";

export function resolveServerCommand(command: string): string {
  if (command.trim() === NODE_TOKEN) return process.execPath;
  return normaliseCommand(command);
}

/**
 * Args that mean "the folders the user wants the agent to work in". A bare "." reads as
 * that to anyone writing a config, but it used to resolve against the package root --
 * so a global install confined the agent to node_modules/justbetter-mcp and every file
 * operation on the user's actual project failed. A "." is only ever correct by accident,
 * so it is treated as the placeholder rather than as a real relative path.
 */
const WORKSPACE_TOKENS = new Set([".", "./", ".\\", "${JUSTBETTER_WORKSPACE}"]);

/**
 * Upstream args are often written relative to the gateway ("tsx", "src/terminal-server.ts").
 * Those used to resolve because the child was spawned with the package root as its cwd --
 * which on Windows pins a handle on the install directory and makes `npm install -g` fail
 * with EBUSY while any server is alive. Resolving the paths here keeps those configs
 * working while the child runs somewhere disposable.
 *
 * Only an arg naming something that really exists in the package is rewritten, so flags
 * ("-y") and package names ("@modelcontextprotocol/server-filesystem") pass through.
 *
 * A workspace token expands to every allowed directory, which is why this returns a
 * flatMap: the filesystem server takes any number of paths, so one placeholder in the
 * config can grant access to several folders.
 */
export function resolveServerArgs(args: string[], allowedDirectories: string[] = []): string[] {
  const workspace = allowedDirectories.length > 0
    ? allowedDirectories.map(dir => path.resolve(dir))
    : [invocationCwd()];

  return args.flatMap(arg => {
    if (WORKSPACE_TOKENS.has(arg)) return workspace;
    // Checked before the generic branch below: the token names no path that exists, so it
    // would otherwise pass through verbatim and the server would fail to start.
    if (arg.trim() === TSX_TOKEN) {
      const tsx = resolveTsxPath();
      return [tsx ?? arg];
    }
    if (!arg || arg.startsWith("-") || path.isAbsolute(arg)) return [arg];
    const candidate = path.resolve(PACKAGE_ROOT, arg);
    return [fs.existsSync(candidate) ? candidate : arg];
  });
}

/**
 * Names any ${NAME} placeholder that resolveServerEnv could not fill in.
 *
 * A server configured with a credential it never receives still starts, still advertises
 * its tools, and still gets them indexed and injected -- so the model picks one and gets a
 * 401. Hiding those tools is more honest than offering them: the whole point of this
 * gateway is putting the *usable* tools in front of the model.
 */
function unresolvedSecrets(env?: Record<string, string>, headers?: Record<string, string>): string[] {
  const check = (rec?: Record<string, string>) => {
    const resolved = resolveServerEnv(rec);
    if (!resolved) return [];
    const missing: string[] = [];
    for (const value of Object.values(resolved)) {
      const matches = value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
      for (const match of matches) {
        if (match[1]) missing.push(match[1]);
      }
    }
    return missing;
  };
  return [...check(env), ...check(headers)];
}

export async function connectSingleUpstream(rawServerConfig: any, allowedDirectories: string[] = [], connectionTimeoutMs: number = 20_000): Promise<void> {
  // Validate before spawning or dialing. This function turns config into a live
  // connection, so it is the last place to reject a malformed (or attacker-supplied)
  // server entry.
  const serverConfig = UpstreamServerSchema.parse(rawServerConfig);

  // Checked before spawning or dialing: an unusable server costs a process or network
  // roundtrip, an index pass, and a catalog entry, and the precondition gate hides its
  // tools anyway once it is not marked connected.
  const missingSecrets = unresolvedSecrets(serverConfig.env, serverConfig.headers);
  if (missingSecrets.length > 0) {
    serverStatuses[serverConfig.name] = 'skipped';
    console.error(
      `[Upstream Manager] Skipping '${serverConfig.name}': ${missingSecrets.join(', ')} not set. ` +
      `Set it in the environment or in ~/.justbetter-mcp/secrets.json to enable these tools.`
    );
    return;
  }

  // A bundled TypeScript server cannot start without the tsx runtime. Saying so beats
  // spawning node with an unexpanded "${JUSTBETTER_TSX}" argument and reporting whatever
  // error that produces, which names nothing the user can act on.
  if (serverConfig.args?.some(arg => arg.trim() === TSX_TOKEN) && !resolveTsxPath()) {
    serverStatuses[serverConfig.name] = 'skipped';
    console.error(
      `[Upstream Manager] Skipping '${serverConfig.name}': the tsx runtime could not be found, ` +
      `so the bundled server cannot be started. Reinstalling justbetter-mcp should restore it.`
    );
    return;
  }

  if (serverConfig.url) {
    const headers: Record<string, string> = { ...(resolveServerEnv(serverConfig.headers) ?? {}) };
    console.error(`Connecting to upstream HTTP server: ${serverConfig.name} (${serverConfig.url})...`);

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(serverConfig.url),
        { requestInit: { headers } }
      );

      const client = new Client(
        { name: "justbetter-mcp-gateway", version: "1.0.0" },
        { capabilities: {} }
      );

      let timerHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerHandle = setTimeout(() => {
          client.close().catch(() => {});
          reject(new Error(`connection timed out after ${connectionTimeoutMs}ms`));
        }, connectionTimeoutMs);
      });

      try {
        await Promise.race([
          client.connect(transport as Transport),
          timeoutPromise
        ]);
      } finally {
        if (timerHandle) clearTimeout(timerHandle);
      }

      const toolsResponse = await client.listTools();

      activeUpstreams.push({
        name: serverConfig.name,
        client,
        tools: toolsResponse.tools,
      });

      serverStatuses[serverConfig.name] = 'connected';
      console.error(`Connected to ${serverConfig.name} - found ${toolsResponse.tools.length} tools.`);

      await indexTools(serverConfig.name, toolsResponse.tools);
    } catch (error: any) {
      console.error(`\n⚠️ Failed to connect to HTTP server '${serverConfig.name}': ${error.message}`);
      serverStatuses[serverConfig.name] = 'failed';
    }
    return;
  }

  console.error(`Connecting to upstream server: ${serverConfig.name}...`);

  try {
    // Spawn from the gateway's own package root unless the entry says otherwise.
    // Without this, an upstream configured with a relative script path ("tsx
    // src/terminal-server.ts") only starts when the gateway happens to have been
    // launched from the repo — so those servers vanish under Claude Desktop or Cursor.
    const transport = new StdioClientTransport({
      command: resolveServerCommand(serverConfig.command!),
      args: resolveServerArgs(serverConfig.args, allowedDirectories),
      cwd: serverConfig.cwd ?? os.tmpdir(),
      stderr: 'pipe',
      env: { ...process.env, ...(resolveServerEnv(serverConfig.env) || {}) } as Record<string, string>,
    });

    // Capture the child's stderr so it does not leak to the parent terminal
    // (the default 'inherit' would send it straight to opencode's display).
    const childStderr = transport.stderr;
    if (childStderr) {
      childStderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) console.error(`[${serverConfig.name}] ${line.trim()}`);
        }
      });
    }

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
  const allowed = config.allowedDirectories ?? [];
  const timeout = config.upstreamConnectionTimeoutMs ?? 20_000;
  // Worth printing: when a file tool refuses a path, this is the line that explains it.
  console.error(`[Upstream Manager] Agent workspace: ${(allowed.length > 0 ? allowed : [invocationCwd()]).join(", ")}`);
  for (const serverConfig of config.upstreamServers) {
    await connectSingleUpstream(serverConfig, allowed, timeout);
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
