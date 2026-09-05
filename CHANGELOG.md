# Changelog

All notable changes to this project are documented here.

This project uses [Semantic Versioning](https://semver.org/). While on `0.x`, the config
format and CLI surface may change between minor versions.

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

[0.1.0]: https://github.com/igiamronit/justbetter-mcp/releases/tag/v0.1.0
