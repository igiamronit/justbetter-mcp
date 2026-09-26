# Changelog

All notable changes to this project are documented here.

This project uses [Semantic Versioning](https://semver.org/). While on `0.x`, the config
format and CLI surface may change between minor versions.

## [Unreleased]

### Fixed

- **A blank answer from the model printed nothing at all.** When a reply came back with no
  content and no tool calls, the turn put an `[Empty response]` sentinel into the model's
  history for its own benefit, filtered that sentinel back out of the transcript, and ended
  -- so the message was echoed and then absolutely nothing followed, no reply and no error.
  A provider that is rate limiting or overloaded returns exactly this, so the case that most
  needed explaining was the one that said least, and it looked like the CLI ignoring you. It
  now says the reply was empty and why that usually happens.
- **`/setup` offered a folder from some other project.** The workspace box was prefilled from
  `allowedDirectories` in the config, so a path saved by an earlier run came back every time
  and the folder you were actually standing in was ignored -- which is how an agent ended up
  writing into a source tree nobody had pointed it at. It now defaults to the directory the
  CLI was started in.
- **Enter did nothing on terminals that send a line feed.** ink flags a carriage return as
  `return`, which is what the text input submits on, but a bare LF or a CRLF is parsed as a
  key it calls "enter" with no flag exposed for it. On a terminal that sends either, nothing
  could be submitted at all -- the typed line just sat in the box. All three forms now submit
  exactly one turn.
- **A stalled model request span the clock forever.** `waitForProxy` only checks that
  something is listening on the port, so a gateway left running from an earlier session
  accepts the connection and never replies. A request now gives up after 120s and says so,
  including what usually causes it, instead of spinning with nothing on screen.
- **Two Enters in the same tick could start two turns.** The "already busy" check read React
  state, which every handler sees as it was at its own render, so submits arriving before the
  next render all passed it and each appended the same message. The guard is a ref now, so it
  is true the moment the first one starts.
- **Messages sent while the gateway was still starting vanished.** The TUI renders and takes
  input immediately, but the gateway is a child process that takes seconds to come up --
  longer on a first run, which downloads the bundled servers. The agentic loop was a
  `while (mcpClient)`, so a message sent in that window was echoed into the transcript and
  then dropped with no reply and no error, which looked like the app ignoring you. The
  message now stays in the input box and says why it has not been sent, the gateway
  announces that it is starting and when it is ready, and no path can end a turn silently.
- **A bare `/` was sent to the model as a chat message.** Pressing Enter with the command
  menu open submitted whatever was typed instead of the highlighted command, and an
  unrecognised command fell past every branch into the chat path -- so typing `/` and Enter
  spent a whole turn thinking about a slash. Enter now completes a command fragment from the
  menu, an unknown command says so, and `/config set` with no value prints its usage rather
  than reaching the model.
- **Terminal commands ran in the temp directory, not your project.** Upstreams are spawned
  with `cwd: os.tmpdir()` on purpose — a process sitting in the install folder is what makes
  `npm install -g` fail with EBUSY on Windows — and the terminal server took no path
  argument, so it inherited that. `npm test` looked for `%TEMP%\package.json` and failed
  with `ENOENT`. The gateway now publishes `JUSTBETTER_WORKSPACE` to every upstream, the
  shipped config passes `${JUSTBETTER_WORKSPACE}` to the terminal server, and the server
  reports the directory it will use at startup. Existing configs are fixed by the
  environment variable without any edit.
- **The prompt drifted down the screen.** Ink keeps its live region where the cursor
  started, so the prompt opened near the top and crept downward as the transcript grew. The
  screen is now scrolled once at launch, which puts the prompt on the last row and keeps it
  there while the transcript scrolls up behind it.
- **The TUI could not be scrolled.** It rendered into the alternate screen buffer, which has
  no scrollback by definition, so committing the transcript to `Static` produced output the
  mouse wheel could not reach. It now renders in the normal buffer, where finished turns are
  ordinary terminal scrollback — wheel-scrollable, selectable and copyable.
- **Leaving the setup wizard re-printed the whole transcript.** The wizard was returned in
  place of the entire component tree, which unmounted `Static` — and ink re-prints every
  `Static` item when it remounts. The wizard is now a state of the live region, so the
  committed transcript stays mounted across `/setup`.
- **A dashboard port clash killed the whole gateway.** `ws` forwards the HTTP server's own
  `error` event onto the `WebSocketServer` as well, so handling it only on the server left
  an unhandled duplicate — and an unhandled `'error'` event throws. Starting a second
  instance, or starting one after a previous process had not yet released the port, died
  with `EADDRINUSE` on 4040 instead of just running without a dashboard.

### Changed

- **The TUI was rebuilt to read like a modern coding agent.** The transcript is now
  committed to the terminal with ink's `Static` instead of being repainted inside a
  fixed-height viewport, so finished output is ordinary scrollback: the mouse wheel works,
  and text can be selected and copied. Only the live turn and the prompt redraw.
  - One marker vocabulary replaces the old text labels: a filled circle opens an assistant
    message or a tool call, a corner glyph hangs its result, and a cross marks a failure.
  - Tool calls collapse to one line with the argument that identifies them —
    `read_text_file(hello.py)` rather than a pretty-printed JSON block.
  - A failure now names its tool. In quiet mode the call line above it is hidden, so
    `Failed` on its own gave nothing to act on.
  - Colour is cut from six ad-hoc colours to four roles. Conversation text is left
    unstyled so it stands out from uniformly dimmed machinery.
  - The prompt sits in a rounded border, with one dim hint line under it that sheds items
    as the terminal narrows instead of being cut off mid-word.
  - `NO_COLOR` is honoured, and `JUSTBETTER_ASCII=1` forces single-column fallback glyphs
    for terminals that render box-drawing characters as replacement boxes.

### Added

- **An ASCII wordmark at launch**, drawn from a small built-in half-block font rather than a
  figlet dependency, with a `#` fallback for terminals that cannot draw half blocks and a
  plain one-line title when the terminal is too narrow for it.
- **`Esc` interrupts a running turn.** The request is cancelled through an `AbortSignal`,
  so it takes effect during a slow model call rather than after it. Whatever already
  happened stays in the transcript.
- **A working line** while a turn runs: spinner, the tool in flight, elapsed seconds, and
  the interrupt hint, in place of the old `Thinking...` text.
- **Command history** on Up/Down when the input is empty, and **arrow-key selection** in
  the slash menu with Tab to accept.
- **`Ctrl+C` twice to exit**, prompting after the first press.
- `src/tui.tsx` was split into `src/tui/` — `theme`, `render`, `components`, `commands`,
  `events`, `session` and `wizard` — with the wizard and the agentic loop moved unchanged.
  The exports the tests import are re-exported from `src/tui.tsx`.

### Removed

- **Retroactive expansion of old tool output.** `Ctrl+X` now expands the current turn only.
  Committed lines belong to the terminal and cannot be re-rendered; `/verbose` is the
  session-wide lever, and in exchange scrolling is the terminal's own.
- In-app scrolling keys (`PgUp`/`PgDn`, `Ctrl+U`/`Ctrl+D`, `Home`/`End`) and the
  `Lines 40-64/210` counter, both made redundant by native scrollback.

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
