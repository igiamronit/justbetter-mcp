#!/usr/bin/env node
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.join(__dirname, "..");
const cliTsPath = path.join(packageRoot, "src", "cli.ts");
const tsxPath = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");

// Pass all arguments to the tsx process
const args = process.argv.slice(2);

// No shell, and no hand-rolled quoting: spawn passes each argv entry verbatim, which
// is what makes paths containing spaces work. Running from the package root keeps the
// gateway's own relative lookups stable no matter where the user invoked us from.
const child = spawn(process.execPath, [tsxPath, cliTsPath, ...args], {
  stdio: "inherit",
  cwd: packageRoot
});

child.on("error", (err) => {
  console.error(`Failed to start JustBetter CLI: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
