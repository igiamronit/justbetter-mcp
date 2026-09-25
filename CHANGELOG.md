# Changelog

All notable changes to this project are documented here.

This project uses [Semantic Versioning](https://semver.org/). While on `0.x`, the config
format and CLI surface may change between minor versions.

## [0.3.0] — 2026-09-25

### Added

- **The default config now ships a working toolset.** A fresh install previously started
  only `filesystem` and a GitHub server, so `run_terminal_command` — which has always been
  in `CORE_PINNED_TOOLS` — was pinned to a server that never ran. The agent could write a
  script and then report it was unable to execute it, with no setting to change. Defaults
  are now `filesystem`, `terminal`, `websearch`, `memory` and `sequential-thinking`.
- **`${JUSTBETTER_NODE}` and `${JUSTBETTER_TSX}` config tokens.** The bundled TypeScript
  servers are started with the interpreter and tsx copy already installed. The previous
  `npx tsx src/terminal-server.ts` form only worked in a git checkout: `tsx` is a nested
  dependency whose bin is never linked onto `PATH`, so under a real install npx would
  download a second copy or fail. A bundled server is now cleanly `skipped` with a readable
  reason when tsx cannot be found.
- **`${JUSTBETTER_HOME}` expands in upstream `env` values**, so an upstream can keep its
  state beside ours instead of inside `node_modules`. The `memory` server writes to
  `~/.justbetter-mcp/memory.json` because of this.

### Changed

- **`run_terminal_command` is no longer in `destructiveTools`**, so shell commands run
  without an OS confirmation dialog. Note that it executes through a shell and, unlike the
  filesystem server, is **not** restricted to `allowedDirectories`. Add it back to
  `destructiveTools` to require confirmation, or remove the `terminal` upstream to drop the
  capability; both are documented in the README.
- **Both GitHub upstreams are no longer defaults.** `@modelcontextprotocol/server-github`
  is deprecated on npm and unmaintained since April 2025, and both entries needed a
  `GITHUB_PERSONAL_ACCESS_TOKEN` that most first runs do not have. GitHub is now opt-in;
  the remote `https://api.githubcopilot.com/mcp/` endpoint is the maintained option.

## [0.2.0] — 2026-09-08

### Added

- **Remote HTTP/SSE Upstream Server Support ([#6](https://github.com/igiamronit/justbetter-mcp/pull/6)).** Upstream servers can now connect to remote MCP endpoints over Streamable HTTP/SSE using `"url"` and optional `"headers"`:
  - Header values support `${NAME}` placeholder expansion from environment variables and `~/.justbetter-mcp/secrets.json`.
  - Servers with missing credentials in headers are cleanly marked `'skipped'` and excluded from active tools.
  - Per-connection timeout protection via `upstreamConnectionTimeoutMs` (default 20s).
  - Validates URLs via Zod schema and enforces `command` XOR `url` exclusivity.
  - Dashboard table displays `server.url` for remote endpoints.

## [0.1.1] — 2026-09-06

### Fixed

- **Mode 2 discovery never reached the model.** `tools/list` returned a fixed pair of
  tools, so a tool found by `request_tools` was marked callable but its schema was never
  advertised — the client had no function definition to give the model, and the "they have
  been seamlessly added to your environment" acknowledgement was simply false
  ([#5](https://github.com/igiamronit/justbetter-mcp/issues/5)). Now:
  - `tools/list` returns the discovery primitives, the pinned tools, and everything
    `request_tools` has found this session, capped at 24 discovered tools and evicted
    oldest-first so the surface cannot grow back into the inject-all baseline.
  - The server declares `capabilities.tools.listChanged` and emits
    `notifications/tools/list_changed` when the advertised set grows.
  - `request_tools` returns the matched tools' real JSON schemas in its result, and
    `batch_call` accepts any of those names — so a discovered tool is callable in the same
    turn even in clients that only refresh their tool list on restart.
- **Pinned tools were unreachable over stdio.** `pinnedTools` were re-injected on every
  Mode 1 request but never advertised in Mode 2, so a Claude Desktop session started with
  no file or terminal access until the model guessed that `request_tools` existed. They
  are now advertised once upstream indexing completes.

## [0.1.0] — 2026-09-05

First public release.

### What it does

An MCP gateway that stops dozens of tool schemas being dumped into every LLM request.
It connects to your MCP servers, indexes their tools into a local vector catalog, and puts
only the relevant ones in front of the model.

Two modes:

- **Mode 1 — semantic prompt injection.** Retrieval runs on the raw prompt *before* the
  first LLM call, so the model never spends inference deciding what to search for.
  Requires a client that accepts a custom OpenAI-compatible base URL; the bundled TUI is
  the reference client.
- **Mode 2 — reactive tool discovery.** The client sees exactly two tools,
  `request_tools` and `batch_call`, and asks for more mid-conversation. Works in Claude
  Desktop, Cursor, and any other MCP client.

### Added

- `npx justbetter-mcp` — no clone, no build.
- **First-run setup wizard.** Provider, API key, model and workspace folder, collected in
  the TUI. The key is verified against the provider before it is saved, so a typo is
  caught immediately instead of surfacing as an opaque `401` on the first chat turn.
- **`/setup`, `/config`, `/verbose`, `/help`** in the TUI, and a `/` command menu.
  Tool traffic is hidden by default; failures are always shown.
- **`allowedDirectories`** — the folders the agent may read and write, chosen in the
  wizard or with `/config set workspace`. Defaults to the directory you launched from.
- Subcommands: `justbetter-mcp` (TUI), `chat`, `gateway`, `--help`, `--version`.
- Security gates: hallucination, schema validation, preconditions, and OS-dialog approval
  for tools listed in `destructiveTools`.
- Token-gated management dashboard.

### Fixed

- Upstream servers whose `${CREDENTIAL}` never resolves are now **skipped** rather than
  started, so the model is never offered tools that can only return a `401`.
- The gateway no longer runs from its own install directory, which made `npm install -g`
  fail with `EBUSY` on Windows while a client kept a server alive.
- State (`catalog.db`, `token_log.csv`, config) moved to `~/.justbetter-mcp` instead of
  the current working directory or `node_modules`.
- The ~87MB embedding model caches in `~/.justbetter-mcp/models`, so upgrading no longer
  re-downloads it.
- `npx` vs `npx.cmd` is normalised per platform, so a config written on one OS starts its
  upstreams on the other.
- The MCP transport opens before upstreams connect, so first launch no longer exceeds the
  client's handshake timeout while the model downloads.

### Known gaps

- Tested only on Windows. macOS and Linux should work but are unverified.
- Mode 1 does not work in Claude Desktop, which cannot redirect model traffic.
- `grouping.ts` is a documented no-op seam, not a shipped feature.
- `searchTools` is a full scan — fine at current catalog sizes.
- The Mode 1 output-quality advantage is a hypothesis, not a measured result.

[0.1.1]: https://github.com/igiamronit/justbetter-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/igiamronit/justbetter-mcp/releases/tag/v0.1.0
[0.3.0]: https://github.com/igiamronit/justbetter-mcp/releases/tag/v0.3.0
