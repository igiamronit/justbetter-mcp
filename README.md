<div align="center">
  <h1>JustBetter MCP</h1>
  <p><em>An MCP gateway with dynamic, retrieval-based tool injection.</em></p>
  <p>
    <a href="https://www.npmjs.com/package/justbetter-mcp"><img src="https://img.shields.io/npm/v/justbetter-mcp?color=cb3837&logo=npm" alt="npm version" /></a>
    <img src="https://img.shields.io/npm/l/justbetter-mcp?color=blue" alt="MIT license" />
    <img src="https://img.shields.io/badge/TypeScript-5.0-blue" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Node.js-18+-green" alt="Node" />
    <img src="https://img.shields.io/badge/ONNX-MiniLM-orange" alt="ONNX" />
    <img src="https://img.shields.io/badge/sqlite--vec-Vector_DB-blueviolet" alt="SQLite Vec" />
  </p>
</div>

<br/>

> **The Problem:** 
> Connecting an LLM to standard Model Context Protocol (MCP) servers (like a file system, a web searcher, and a database) dumps dozens or hundreds of tools into the LLM's context window. 
>
> This token-bloat problem leads to `node_modules` blowups, context limits being breached, and severely degraded tool selection accuracy.

> **The Solution:** 
> JustBetter MCP solves this by acting as a gateway/proxy. Instead of dumping every connected server's tools into every request, it uses dynamic, retrieval-based tool injection to limit the tools sent to the LLM. 
>
> It operates in two main modes: **Mode 2** is essentially equivalent to Anthropic's MCP Tool Search or OpenAI Codex's tool search, where the LLM reactively asks for tools mid-conversation. **Mode 1** is our custom approach that performs semantic retrieval on the raw prompt *before* the first LLM call.
>
> **Measured results: [Token Usage Analysis](#token-usage-analysis) ↓**

---

## Install

```bash
npx justbetter-mcp
```

The first run opens a setup wizard: pick a provider, paste an API key (verified against the
provider before it is saved), choose a model, and choose which folder the agent is allowed to
read and write. There is no JSON to hand-author.

**Mode 2 — Claude Desktop, Cursor, or any MCP client.** Add this to the client's MCP config:

```json
{
  "mcpServers": {
    "justbetter": {
      "command": "npx",
      "args": ["-y", "justbetter-mcp", "gateway"]
    }
  }
}
```

The client starts with `request_tools`, `batch_call` and your pinned tools. Everything else is
retrieved on demand: when `request_tools` finds something, its schema is added to the server's
tool list and the client is notified — that is the whole point.

> **Mode 1 needs a client that lets you set an OpenAI-compatible base URL.** The bundled TUI is
> the reference client and always works. Cline, Roo, Continue, aider and Zed accept a custom base
> URL; Cursor is inconsistent across versions; **Claude Desktop cannot, and is Mode 2 only.**

State lives in `~/.justbetter-mcp` — config, tool catalog, and the embedding model. Nothing is
written into the directory you run from. Full reference: [Setup & Quickstart](#setup--quickstart).

---

### Quick Links
- [Install](#install)
- [Token Usage Analysis](#token-usage-analysis)
- [Architecture & How It Works](#architecture--how-it-works)
- [Setup & How to Use](#setup--quickstart)

---

## Token Usage Analysis

Three ways of getting tools to the model, eight tasks, one run each. Every task has a verifier that
checks the workspace afterwards, so pass and fail are decided by code rather than by another model.
24 runs, 916,359 tokens, nothing abandoned or retried.

| | |
|---|---|
| Model | `nemotron-3-super` (Ollama Cloud, OpenAI-compatible endpoint) |
| Decoding | `temperature: 0`, `reasoning_effort: low`, no seed |
| Catalog | 26 tools — `filesystem` + `terminal` + `memory` |
| Turn cap | 20 per task, 1 run per cell |

<div align="center">
  <img src="./charts/bench_mean_tokens.svg" alt="Mean tokens per run: Mode 1 27,251 (-42.6% against the inject-all baseline), Mode 2 39,798 (-16.2%), Mode 3 47,496" width="820" />
</div>

Mode 1 is the cheapest of the three: **42.6% under the inject-all baseline** on the mean, 38.1% on
the median. Mode 3 costs the most and is also the least reliable, passing 5 of 8 tasks against 7 of 8
for both retrieval modes — it was the only arm that reported sending an email with no email tool
installed.

### Where the saving comes from

Not from where we assumed. The original argument was that Mode 1 spares the model from working out
which tool to search for, so it should spend fewer completion tokens. It does not: per turn, Mode 2's
completion cost is slightly *lower* than Mode 1's. About 97% of the bill is prompt tokens, and every
turn re-sends the whole transcript plus whatever tools are attached, so what you actually pay for is
the number of turns.

<div align="center">
  <img src="./charts/bench_turn_economics.svg" alt="Tokens per turn: Mode 1 4,542 (-25.9%), Mode 2 4,752 (-22.5%), Mode 3 6,129. Turns per run: Mode 1 6.0 (-22.6%), Mode 2 8.4 (+8.1%), Mode 3 7.8" width="820" />
</div>

Per turn the two retrieval modes are within 4.6% of each other. Mode 1 wins because it finishes in
fewer turns. Mode 2 needs **more** turns than the baseline does (+8.1%), because it spends turns
asking for tools; it still comes out cheaper overall since each of its turns is 22.5% smaller, but it
gives part of the saving back.

### Caveats

- **One run per cell.** Cost per task varies 4–7× inside a single arm. `t1` under Mode 1 cost 10,788
  tokens in 4 turns on one run and 65,539 in 10 turns on another — same code, same input,
  `temperature: 0`. The model emits reasoning and no seed was set. Read the ordering as a direction,
  not as a measurement.
- **Retrieval is wider than it needs to be.** Mode 1 carries about 15 schemas per turn and calls 3.
  81% of what it sends is never used, against 88% for Mode 3. Breadth was left at the shipped
  defaults instead of being tuned for the run, so there is room here.
- **Tokens, not cost.** Prompt caching is on but not measured. Mode 3 has the most static prefix and
  caches best, so its real bill is lower than its token count suggests.
- **One model, eight filesystem-and-shell tasks**, written by the same person who wanted the result.
  The tasks and their verifiers are in `benchmark/tasks.ts` if you want to argue with them.
- **Output quality is untested.** This measures tokens and whether the task got done. Both retrieval
  modes passed 7 of 8, so nothing here says Mode 1 gives better answers — only that it costs less and
  is no less reliable.

```bash
node benchmark/catalog.mjs      # measure the tool catalog, no API tokens
npx tsx benchmark/run.ts        # the full suite
node benchmark/status.mjs       # progress, safe to run mid-suite
node benchmark/charts.mjs       # redraw the charts from raw.jsonl
```

---

## Architecture & How It Works

JustBetter MCP operates in two distinct modes depending on your configuration and client ecosystem.

### Mode 1: Semantic Prompt Injection (JustBetter CLI)

When using the JustBetter CLI with semantic injection enabled (`"semanticPromptInjection": true`), the gateway acts as a dual-proxy. It intercepts the HTTP chat request, performs a semantic search on the prompt, and silently injects the exact tools needed into the payload *before* it reaches the LLM.

#### Flowchart Style
```mermaid
graph TD
    User["User Prompt"] --> CLI["JustBetter CLI"]
    
    subgraph "Prompt Interception (HTTP)"
        CLI -->|"1. Chat Request"| APIProxy["LLM API Proxy (:4141)"]
        APIProxy <-->|"2. Semantic Search"| Catalog[("Tool Catalog (sqlite-vec)")]
        APIProxy -->|"3. Inject Schemas"| LLM["Real LLM API"]
        LLM -->|"4. Response"| APIProxy
        APIProxy -->|"5. Return JSON"| CLI
    end
    
    subgraph "Tool Execution (MCP)"
        CLI -->|"6. Execute Tool"| MCPProxy["MCP Gateway Proxy"]
        MCPProxy -->|"7. Security Gates"| Gates["Hallucination/Approval Gate"]
        Gates -->|"Pass"| Upstream["Upstream MCP Servers"]
        Upstream -->|"8. Tool Result"| MCPProxy
        MCPProxy -->|"9. Return"| CLI
    end
```

#### Sequence Diagram Style
```mermaid
sequenceDiagram
    actor User
    participant CLI as JustBetter CLI
    participant Proxy as LLM API Proxy
    participant DB as Tool Catalog
    participant LLM as Real LLM API
    participant MCP as MCP Gateway
    participant Upstream as Upstream Servers

    User->>CLI: Sends Prompt
    
    note over CLI,LLM: 1. Prompt Interception (HTTP)
    CLI->>Proxy: Chat Request
    Proxy->>DB: Semantic Search
    DB-->>Proxy: Top K Schemas
    Proxy->>LLM: Inject Schemas & Forward
    LLM-->>Proxy: Returns Tool Call JSON
    Proxy-->>CLI: Returns Response
    
    note over CLI,Upstream: 2. Tool Execution (MCP stdio)
    CLI->>MCP: Execute Tool
    MCP->>MCP: Hallucination/Approval Gate
    MCP->>Upstream: Route to Upstream Server
    Upstream-->>MCP: Tool Result
    MCP-->>CLI: Returns Result
```

### Mode 2: Reactive Tool Discovery (Cursor, Claude Desktop & CLI)

This mode is used natively by third-party clients like Claude Desktop and Cursor, and can be enabled in the JustBetter CLI by setting `"semanticPromptInjection": false`.

In this mode, the gateway employs a reactive approach. It hides the massive catalog of upstream tools to prevent token bloat and advertises only the `request_tools` and `batch_call` primitives plus your pinned tools. The AI explicitly asks the Gateway for tools mid-conversation when needed; the matched schemas are returned in the response *and* added to the gateway's `tools/list`, which is re-announced with a `notifications/tools/list_changed`. This mirrors the behavior of Anthropic's MCP Tool Search and OpenAI Codex's tool search, trading one extra round-trip for massive context savings.

The advertised set is capped (24 discovered tools) and evicted oldest-first, so a long session cannot quietly grow back into the dump-everything baseline. Clients vary in how they react to `tools/list_changed` — some re-read immediately, some only on restart — so the discovered schemas also come back in the `request_tools` result, and `batch_call` accepts any of those names. A discovered tool is therefore callable in the same turn regardless of what the client does with the notification.

#### Flowchart Style
```mermaid
graph TD
    User["User Prompt"] --> Client["Claude Desktop / Cursor"]
    Client -->|"1. Direct Request"| LLM["Anthropic/OpenAI API"]
    LLM -->|"2. 'I need tools!'"| Client
    
    subgraph "Reactive Tool Discovery (MCP stdio)"
        Client -->|"3. call_tool('request_tools', query)"| MCPProxy["MCP Gateway Proxy"]
        MCPProxy <-->|"4. Semantic Search"| Catalog[("Tool Catalog (sqlite-vec)")]
        MCPProxy -->|"5. Return Schemas + Advertise via tools/list_changed"| Client
    end
    
    Client -->|"6. Next Turn: Execute Tool"| MCPProxy
    MCPProxy -->|"7. Security Gates"| Upstream["Upstream MCP Servers"]
    Upstream -->|"8. Tool Result"| MCPProxy
    MCPProxy -->|"9. Return"| Client
```

#### Sequence Diagram Style
```mermaid
sequenceDiagram
    actor User
    participant Client as Claude Desktop/Cursor
    participant LLM as Anthropic/OpenAI API
    participant MCP as MCP Gateway
    participant DB as Tool Catalog
    participant Upstream as Upstream Servers

    User->>Client: Sends Prompt
    
    note over Client,LLM: 1. Initial Request
    Client->>LLM: Direct Chat Request
    LLM-->>Client: "I need tools!"
    
    note over Client,DB: 2. Reactive Tool Discovery
    Client->>MCP: call_tool('request_tools')
    MCP->>DB: Semantic Search
    DB-->>MCP: Top K Schemas
    MCP-->>Client: Return Schemas + notifications/tools/list_changed
    
    note over Client,Upstream: 3. Tool Execution
    Client->>LLM: Next Turn (with Schemas)
    LLM-->>Client: Execute Actual Tool
    Client->>MCP: Execute Tool
    MCP->>Upstream: Route to Upstream Server
    Upstream-->>MCP: Tool Result
    MCP-->>Client: Returns Result
```

### Tool Retention: what stays available between turns

Retrieval alone is not enough. A tool found on turn 3 has to still be there on turn 6, or the model
rediscovers it and pays for the discovery twice. Both modes therefore keep a bounded working set
across turns — Mode 1 as a carry-over window added to each turn's fresh matches, Mode 2 as the
advertised `tools/list`. Two rules govern that set:

- **Ordered by true recency.** Retention uses a monotonic per-injection sequence number, not the
  `injected_at` wall-clock column. SQLite's `CURRENT_TIMESTAMP` resolves only to the second, so
  every tool injected within the same turn shared one timestamp and the ordering silently
  collapsed to its tiebreak — alphabetical by tool name. A tool late in the alphabet, `write_file`
  among them, could never survive the window. It now survives on the basis the design always
  claimed.
- **What the model asked for outranks what the gateway guessed.** A tool the model obtained
  through `request_tools` is marked as *requested* and sorts ahead of the routine per-turn
  injections, stickily for the rest of the session. Without this, a dozen-odd speculative
  injections per turn could evict the one tool the model had deliberately gone looking for.

The set stays capped either way (24 advertised tools in Mode 2, 8 carry-over slots in Mode 1), so a
long session cannot quietly grow back into the dump-everything baseline. In benchmarking, these two
rules were worth more than the entire difference between the three modes — see
[Token Usage Analysis](#token-usage-analysis).

### Core Pipeline Security
Regardless of which mode you use, all tool executions pass through strict safety mechanisms:
- **Hallucination Gate:** Blocks the LLM from calling any tool that wasn't explicitly injected or requested.
- **Precondition Gate:** Skips and hides tools whose upstream server is disconnected or lacking required auth scopes.
- **Quarantine Mechanism:** Uses schema fingerprinting (SHA-256) to flag upstream tool changes. If a tool's schema unexpectedly changes, it's quarantined until human approval.

---

## Setup & Quickstart

### Minimum Requirements
- **Node.js** (v18+)
- **npm**, **yarn**, or **pnpm**

### Configuration
Create a `config.json` in the project root, or let the first run seed one. This is the shipped default, which is what you get if you never touch it:

```json
{
  "semanticPromptInjection": true,
  "injectAllTools": false,
  "apiProvider": "gemini",
  "allowedDirectories": [],
  "upstreamServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "${JUSTBETTER_WORKSPACE}"
      ]
    },
    {
      "name": "terminal",
      "command": "${JUSTBETTER_NODE}",
      "args": [
        "${JUSTBETTER_TSX}",
        "src/terminal-server.ts"
      ]
    },
    {
      "name": "websearch",
      "command": "${JUSTBETTER_NODE}",
      "args": [
        "${JUSTBETTER_TSX}",
        "src/websearch-server.ts"
      ]
    },
    {
      "name": "memory",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ],
      "env": {
        "MEMORY_FILE_PATH": "${JUSTBETTER_HOME}/memory.json"
      }
    },
    {
      "name": "sequential-thinking",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ]
    }
  ],
  "llmProxy": {
    "enabled": true,
    "port": 4141,
    "host": "127.0.0.1",
    "geminiApiKey": "YOUR-GEMINI-API-KEY",
    "mistralApiKey": "YOUR-MISTRAL-API-KEY",
    "model": "gemini-2.0-flash"
  },
  "dashboard": {
    "enabled": true,
    "port": 4040,
    "host": "127.0.0.1"
  },
  "pinnedTools": [],
  "destructiveTools": [
    "write_file",
    "edit_file",
    "delete_file",
    "drop_table"
  ]
}
```

**Notes on configuration**

- **Local (`stdio`) vs. Remote (`HTTP/SSE`) Upstreams.** An upstream server can either be a local command (`"command"`, `"args"`) spawned via standard I/O, or a remote MCP endpoint (`"url"`, optional `"headers"`) connected over Streamable HTTP/SSE. Headers support `${NAME}` placeholder expansion from environment variables or `~/.justbetter-mcp/secrets.json`. Connect timeouts default to 20 seconds (`upstreamConnectionTimeoutMs`).
- **Paths.** Upstream servers run from a temporary directory, because a process sitting in the install folder makes `npm install -g` fail with `EBUSY` on Windows. Relative args like `src/terminal-server.ts` are instead resolved against the installation before the server is spawned, so they work no matter which client launched the gateway. Add a `"cwd"` to an upstream entry to override the working directory. The gateway's own state (`catalog.db`, `token_log.csv`) lives in `~/.justbetter-mcp`, or in `JUSTBETTER_HOME` if that is set.
- **`allowedDirectories`.** The folders the agent may read and write. Any upstream arg that is `"."` or `"${JUSTBETTER_WORKSPACE}"` is replaced with this list — one placeholder expands to every folder, since the filesystem server accepts any number of paths. Leave it empty and it falls back to the directory the CLI was launched from. Set it from the TUI with `/setup` or `/config set workspace <dir>[,<dir>]`.
- **Secrets.** Any `${NAME}` in an upstream `env` or `headers` value is expanded from the process environment, falling back to `~/.justbetter-mcp/secrets.json` (created `0600`). Provider keys resolve in the order `config.json` → environment (`GEMINI_API_KEY` / `MISTRAL_API_KEY`) → that secrets file, so credentials need not sit in the project directory where the filesystem server can read them back. An upstream whose `${NAME}` never resolves is **skipped**, not started: an unusable server would otherwise advertise its tools, get them indexed, and have the model call one only to receive a 401.
- **`destructiveTools`.** Names listed here require an OS dialog confirmation before every execution. They must match the tool names the upstream server actually exposes (the filesystem server's reader is `read_text_file`, not `read_file`).
- **Terminal access runs without a confirmation dialog by default, and is not confined to `allowedDirectories`.** `run_terminal_command` executes through a shell, so the model can reach anything your user account can — the directory scoping that applies to the filesystem server does not apply here. To require an OS confirmation on every command, add it to the list:

  ```json
  "destructiveTools": ["run_terminal_command", "write_file", "edit_file", "delete_file", "drop_table"]
  ```

  To remove terminal access entirely, delete the `terminal` entry from `upstreamServers`.
- **Ports.** Both servers bind loopback. `llmProxy.authToken`, when set, is additionally required as a bearer token on `/v1`. The dashboard always requires the session token printed at startup.

### Running the Gateway & TUI

**Installed from npm** — the subcommands are the interface:
```bash
justbetter-mcp             # Mode 1: interactive TUI (the default)
justbetter-mcp chat        # Mode 1, plain readline client, no full-screen UI
justbetter-mcp gateway     # Mode 2: stdio server, for an MCP client to spawn
justbetter-mcp --help
```
Any extra argument is treated as a path to a config file.

**From a clone**, for contributors:
1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Start it.** Pick the entry point that matches your mode:
   ```bash
   npm run dev        # Mode 1: JustBetter CLI + gateway + LLM proxy + dashboard
   npm run tui        # Mode 1, Ink-based terminal UI
   npm start          # gateway only (what an MCP client should spawn)
   ```

**Open the dashboard.** The management API can start processes, so it is token-gated. The startup log prints the URL to use:
   ```
   [Dashboard] Local management UI: http://127.0.0.1:4040/?token=<generated at boot>
   ```

### Connecting a client

**Mode 1 — JustBetter CLI.** Set `"semanticPromptInjection": true` and run `justbetter-mcp` (or `npm run dev` from a clone). The CLI talks to the LLM proxy, which injects schemas before the request reaches the provider.

**Mode 2 — Claude Desktop, Cursor, or any MCP client.** Set `"semanticPromptInjection": false` and register the gateway as an stdio MCP server. These clients spawn the gateway themselves, so there is no base URL to configure:

```json
{
  "mcpServers": {
    "justbetter": {
      "command": "npx",
      "args": ["-y", "justbetter-mcp", "gateway"]
    }
  }
}
```

From a clone instead, point the client at the checkout:

```json
{
  "mcpServers": {
    "justbetter": {
      "command": "node",
      "args": [
        "<path to repo>/node_modules/tsx/dist/cli.mjs",
        "<path to repo>/src/proxy.ts",
        "<path to repo>/config.json"
      ]
    }
  }
}
```

The client starts with `request_tools`, `batch_call` and whatever is in `pinnedTools`; everything else is retrieved on demand and added to the advertised list as it is found. Set `"llmProxy": { "enabled": false }` if you only ever use Mode 2 and do not want the HTTP proxy running.

**OpenAI-compatible clients.** Any client that accepts a custom base URL can point at `http://127.0.0.1:4141/v1` to get Mode 1 injection.

### Verifying
```bash
npm test         # gate, catalog, config and terminal-server coverage
npm run typecheck
npm run tokens   # summarise token_log.csv
```
