#!/usr/bin/env node
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliTsPath = path.join(__dirname, "..", "src", "cli.ts");

// Pass all arguments to the tsx process
const args = process.argv.slice(2);

const child = spawn("npx", ["tsx", `"${cliTsPath}"`, ...args], {
  stdio: "inherit",
  shell: true
});

child.on("exit", (code) => {
  process.exit(code || 0);
});
