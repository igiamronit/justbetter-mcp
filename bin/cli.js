#!/usr/bin/env node
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, "..");
/**
 * npm hoists dependencies, so tsx usually lands in the *installing project's*
 * node_modules, not inside this package's own. A hardcoded path only works in a
 * git checkout. tsx does not export "./dist/cli.mjs", so resolve its package.json
 * (which is exported) and walk to the binary from there.
 */
function resolveTsx() {
  const req = createRequire(import.meta.url);
  const candidates = [];
  try {
    candidates.push(path.join(path.dirname(req.resolve("tsx/package.json")), "dist", "cli.mjs"));
  } catch {
    // not resolvable from here; fall through to the checkout layout
  }
  candidates.push(path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

// Subcommand -> entry module. `gateway` is Mode 2 (stdio, driven by an MCP client);
// `chat` and `tui` are Mode 1 clients that boot their own gateway as a child.
const TARGETS = {
  gateway: path.join("src", "proxy.ts"),
  tui: path.join("src", "tui.tsx"),
  chat: path.join("src", "cli.ts"),
};

const HELP = `justbetter-mcp — an MCP gateway with retrieval-based tool injection

Usage:
  justbetter-mcp [tui]        Mode 1: interactive chat with semantic tool injection
  justbetter-mcp chat         Mode 1, plain readline client (no full-screen UI)
  justbetter-mcp gateway      Mode 2: stdio server, for Claude Desktop / Cursor
  justbetter-mcp --help       Show this message
  justbetter-mcp --version    Print the version

Any additional argument is treated as a path to a config file. With none, the
config is read from ./config.json if present, otherwise ~/.justbetter-mcp/config.json
(created from a template on first run).

Mode 2 config for an MCP client:
  { "mcpServers": { "justbetter": {
      "command": "npx", "args": ["-y", "justbetter-mcp", "gateway"] } } }
`;

const argv = process.argv.slice(2);
let command = "tui";
let rest = argv;

if (argv.length > 0 && Object.prototype.hasOwnProperty.call(TARGETS, argv[0])) {
  command = argv[0];
  rest = argv.slice(1);
}

// Handled before anything is spawned. Never reached on the gateway path, where
// stray stdout would corrupt the MCP stdio stream.
if (command === "tui" && (argv[0] === "--help" || argv[0] === "-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (command === "tui" && (argv[0] === "--version" || argv[0] === "-v")) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

const tsxPath = resolveTsx();
if (!tsxPath) {
  console.error("Failed to start JustBetter: the 'tsx' runtime could not be found.");
  console.error("Reinstall the package to restore it (npm install -g justbetter-mcp).");
  process.exit(1);
}

const entry = path.join(packageRoot, TARGETS[command]);

// No shell, and no hand-rolled quoting: spawn passes each argv entry verbatim, which
// is what makes paths containing spaces work.
//
// cwd is a throwaway directory on purpose. On Windows a process holds a handle on its
// working directory, and npm upgrades by renaming the package folder -- so running the
// gateway from the install directory makes `npm install -g` fail with EBUSY for as long
// as an MCP client keeps the server alive. Nothing here needs that cwd: entry paths are
// absolute, and every state and config lookup resolves from the module's own URL.
const child = spawn(process.execPath, [tsxPath, entry, ...rest], {
  stdio: "inherit",
  cwd: os.tmpdir(),
});

child.on("error", (err) => {
  console.error(`Failed to start JustBetter: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
