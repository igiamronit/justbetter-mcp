import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { spawnSync } from "child_process";
import { loadConfig, isPlaceholderApiKey } from "./config.js";
import type { Config } from "./config.js";
import { searchTools, markToolInjected, getToolByName } from "./catalog.js";
import type { IndexedTool } from "./catalog.js";
import { advertiseTools, advertisedSchemas, advertisedCount, ADVERTISED_LIMIT } from "./advertised.js";
import { embed } from "./embeddings.js";
import { startLlmProxy } from "./llm-proxy.js";
import { validateToolCall } from "./gates/hallucination.js";
import { requireUserApproval } from "./gates/approval.js";
import { resolveGroupedCall } from "./grouping.js";
import { startDashboard, broadcastEvent } from "./dashboard/server.js";
import { activeUpstreams, connectAllUpstreams } from "./upstream.js";
import { passesPreconditions } from "./gates/precondition.js";
import { resolveConfigPath } from "./paths.js";

// Silence background logs if running under the TUI.
//
// console.warn was missing here, and console.warn writes to stderr. The gateway runs as a
// child of the TUI, so anything it prints lands in the middle of the live region and shoves
// ink's cursor down a line, stranding the frame that was already there. The rate-limit
// retry notice in fetch-retry.ts is a console.warn, which is why a rate-limited turn left a
// trail of "Thinking" lines behind it: one per retry, at 0s, 2s, 6s and 14s.
if (process.env.SILENCE_LOGS === "1") {
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  console.info = () => {};
  console.debug = () => {};
}

/** How long a shutdown may take before this process leaves anyway. */
const SHUTDOWN_GRACE_MS = 3000;
/** How often to check that the process that started this one still exists. */
const PARENT_WATCH_MS = 2000;

/** Whether a pid still exists. Signal 0 tests for the process without touching it. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but belongs to someone else, which still counts as alive.
    return e?.code === 'EPERM';
  }
}

/**
 * Leaves, and takes the upstream servers with it.
 *
 * The bundled servers are started through npx, which on Windows means a cmd.exe wrapper
 * around a node process; killing the wrapper leaves the node process behind. Those strays
 * are what pile up over a few sessions, so the whole tree goes at once.
 */
function hardExit(): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(process.pid)], { stdio: 'ignore' });
    } catch {
      /* fall through to exit */
    }
  }
  process.exit(0);
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
  description: "Execute one or more tools sequentially in a single turn. Accepts any tool name returned by request_tools, including tools your client has not listed yet, so this always works as a fallback when a discovered tool is not directly callable.",
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
 * Whether the stdio client has ever asked for tools/list.
 *
 * This is what tells the two clients apart. Claude Desktop, Cursor and every other
 * generic MCP client list at initialize and build the model's function list from the
 * result. The bundled TUI never lists at all -- in Mode 1 it gets schemas from the HTTP
 * proxy and uses stdio purely for execution. So a client that has listed is a client
 * whose tool surface we are responsible for, and only then does advertising mean
 * anything. Gating on it also keeps Mode 1's injection-window trust exactly as it was.
 */
let clientUsesToolList = false;

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
    // listChanged is declared because the advertised set grows during a session: every
    // request_tools that finds something new makes tools/list return more than it did a
    // moment ago. A client that is not told the list can change has no reason to re-read it.
    { capabilities: { tools: { listChanged: true } } }
  );

  /**
   * Tells the client the tool list moved. Best-effort on purpose: not every client
   * honours the notification, and the ones that do not are covered by batch_call, which
   * is statically advertised and routes any tool name. A failure here must never take
   * down the call that triggered it.
   */
  async function notifyToolListChanged(reason: string) {
    if (!clientUsesToolList) return;
    try {
      await server.sendToolListChanged();
      console.error(`[Proxy] tools/list_changed sent (${reason}); advertising ${advertisedCount()} tools.`);
    } catch (err: any) {
      console.error(`[Proxy] Could not send tools/list_changed: ${err?.message ?? err}`);
    }
  }

  /**
   * Puts the configured pinned tools on the advertised surface.
   *
   * Pinned tools are the deterministic floor: the ones that should be reachable without
   * the model having to guess that a discovery step exists. Mode 1 re-injects them on
   * every request, but over stdio nothing had ever advertised them, so a Claude Desktop
   * session started with no file or terminal access at all.
   *
   * Never awaits the upstream pass -- see the note at the end of main() for why tools/list
   * has to stay answerable on a cold start.
   */
  function syncPinnedAdvertisements(): string[] {
    if (!clientUsesToolList) return [];
    const connectedServers = activeUpstreams.map(u => u.name);
    if (connectedServers.length === 0) return [];

    const resolved: IndexedTool[] = [];
    for (const name of config.pinnedTools) {
      const tool = getToolByName(name, connectedServers);
      if (!tool) continue;
      if (!passesPreconditions(tool.tool_name, tool.server_name, config)) continue;
      resolved.push(tool);
    }
    return advertiseTools(resolved, { sticky: true });
  }

  // tools/list is the whole tool surface a generic MCP client ever sees: it builds the
  // model's function list from this and from nothing else. It starts at the two discovery
  // primitives plus the pinned floor, and grows only by what request_tools actually found.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const firstList = !clientUsesToolList;
    clientUsesToolList = true;
    // On a cold start the client lists before indexing finishes, so this comes back empty
    // and the post-connect pass below advertises the pinned tools with a notification.
    syncPinnedAdvertisements();

    const tools = [REQUEST_TOOLS_MCP_SCHEMA, BATCH_CALL_MCP_SCHEMA, ...advertisedSchemas()];
    if (firstList) {
      console.error(`[Proxy] Client uses tools/list; serving ${tools.length} tools (cap ${ADVERTISED_LIMIT} discovered).`);
    }
    return { tools };
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

      // Mark as callable, and hand the client the real schemas. Marking alone was the
      // original bug: it made the gate let the call through, but the model was never
      // given a schema to build the call from, and the client never learned the function
      // existed. A prose "these are now available" cannot register a tool definition.
      const usable: IndexedTool[] = [];
      for (const r of results) {
        if (passesPreconditions(r.tool_name, r.server_name, config)) {
          // The model asked for this one by name, so it outranks routine injections.
          markToolInjected(r.tool_name, { requested: true });
          usable.push(r);
        }
      }

      if (usable.length === 0) {
        return {
          content: [{ type: "text", text: `Found ${results.length} tools matching "${query}", but none are usable right now (their server is disconnected or a required credential is missing). Try a different capability.` }],
        };
      }

      // Only a client that reads tools/list has a tool surface for us to grow. In Mode 1
      // the TUI gets its schemas from the HTTP proxy, and quietly widening the gate's trust
      // there would loosen the injection window for no benefit.
      const newlyAdvertised = clientUsesToolList ? advertiseTools(usable) : [];
      const toolNames = usable.map(r => r.tool_name);
      console.error(`[request_tools] Returning ${usable.length} tools (${newlyAdvertised.length} newly advertised)`);

      broadcastEvent({
        type: 'discovery_trace',
        prompt: `Fallback request: "${query}"`,
        matchedTools: results.map(r => ({ name: r.tool_name, score: r.score })),
        tokensSaved: 0,
        isFallback: true
      });

      if (newlyAdvertised.length > 0) {
        await notifyToolListChanged(`request_tools: ${newlyAdvertised.join(', ')}`);
      }

      // Mode 1 already has these schemas: the HTTP proxy injected them before the model
      // ever saw the prompt, so a short acknowledgement is all that is needed and repeating
      // every schema here would just pay for them twice.
      if (!clientUsesToolList) {
        return {
          content: [{ type: "text", text: `Found ${usable.length} matching tool(s): ${toolNames.join(", ")}. They are available to call now.` }],
        };
      }

      // Over stdio the schemas go in the result text as well as into tools/list. Clients
      // differ on whether they act on tools/list_changed -- some re-read immediately, some
      // only on restart -- and the model cannot wait for a restart. Text arrives in this
      // turn's context unconditionally, so together with batch_call below the discovered
      // tool is callable straight away whatever the client does about the notification.
      const schemaBlock = usable
        .map(r => JSON.stringify(JSON.parse(r.full_schema_json), null, 2))
        .join('\n\n');

      const example = toolNames[0];
      const guidance = [
        `Found ${usable.length} tool(s) for "${query}": ${toolNames.join(", ")}.`,
        '',
        'Schemas:',
        schemaBlock,
        '',
        "These are now part of this server's tool list, so you may be able to call them directly.",
        `If your client has not picked them up yet and ${example} is not available as a function,`,
        'call it through batch_call instead, which accepts any tool name listed above:',
        `  batch_call({"calls": [{"tool": "${example}", "args": { ... }}]})`
      ].join('\n');

      return {
        content: [{ type: "text", text: guidance }],
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

    // Exit on a deadline whatever happens below. Awaiting every upstream close with no bound
    // meant one that never resolved -- an npx wrapper on Windows that ignores SIGTERM is
    // enough -- kept this process alive for good, still holding the LLM proxy port and still
    // answering as though it were the current session's gateway.
    const deadline = setTimeout(hardExit, SHUTDOWN_GRACE_MS);
    try {
      try { await server.close(); } catch (e) {}
      if (dashboardServer) dashboardServer.close();
      if (llmProxyServer) llmProxyServer.close();

      // Close upstream clients (which terminates their child processes via the SDK)
      for (const u of activeUpstreams) {
        try { await u.client.close(); } catch (e) {}
      }
    } finally {
      clearTimeout(deadline);
      hardExit();
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.stdin.on('close', cleanup);
  process.stdin.on('end', cleanup);

  // Orphan watchdog.
  //
  // This process is a grandchild: the TUI spawns bin/cli.js, which spawns this with inherited
  // stdio. Two things follow from that. Killing the middle process on Windows is a
  // TerminateProcess, so none of its handlers run and it cannot pass anything on. And because
  // the stdio here is the TUI's own pipe, a gateway restart leaves that pipe open -- the TUI
  // is still alive -- so stdin never ends and none of the handlers above ever fire. The result
  // was a gateway that outlived the session that started it, kept port 4141, and served the
  // next session with the provider, key and model it had loaded hours earlier.
  //
  // Watching the parent covers all of it, including a force-kill and a closed terminal window,
  // neither of which delivers anything that could be handled.
  // Only the launcher sets this, so a gateway started any other way -- by an MCP client, or
  // by hand -- is left alone. Guessing from ppid would mean deciding to exit on the strength
  // of a process tree this code knows nothing about.
  const parentPid = Number(process.env.JUSTBETTER_PARENT_PID ?? 0);
  if (parentPid > 1) {
    const watch = setInterval(() => {
      if (!isProcessAlive(parentPid)) void cleanup();
    }, PARENT_WATCH_MS);
    // No reason for the watchdog itself to hold the process open.
    watch.unref();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("JustBetter MCP Gateway is running."); // Using stderr to avoid breaking stdio MCP transport

  // Upstream connection is deliberately started AFTER the transport is live and is
  // not awaited here. On a cold install, indexing downloads an ~80MB embedding model
  // and takes far longer than an MCP client's initialize timeout -- so a client that
  // waited for it would give up and report the gateway as failed to start.
  // tools/list is static, so it can be answered immediately; request_tools awaits
  // this promise instead, which is the only handler that needs a populated catalog.
  upstreamsReady = connectAllUpstreams(config)
    .catch(err => {
      console.error("[Proxy] Upstream connection failed:", err?.message ?? err);
    })
    .then(async () => {
      // The client almost always listed while this was still running, so the pinned floor
      // was not in the catalog yet and its tools/list came back with only the two
      // primitives. Advertise them now and tell the client the list moved.
      const pinned = syncPinnedAdvertisements();
      if (pinned.length > 0) {
        await notifyToolListChanged(`pinned tools ready: ${pinned.join(', ')}`);
      }
    });
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
