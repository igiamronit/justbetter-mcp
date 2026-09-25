import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import util from "util";
import fs from "fs";
import path from "path";

const execAsync = util.promisify(exec);

/**
 * Where commands run.
 *
 * The gateway spawns its upstreams from a temp directory on purpose -- a process sitting in
 * the install folder is what makes `npm install -g` fail with EBUSY on Windows. This server
 * takes no path argument, so it inherited that temp directory and every command ran there:
 * `npm test` looked for %TEMP%\package.json and failed with ENOENT.
 *
 * Resolution order: the first path argument, then JUSTBETTER_WORKSPACE (published by the
 * gateway for exactly this), then this process's own directory. A configured path that does
 * not exist is ignored rather than passed to exec, which would fail every command with a
 * message about the directory instead of the command.
 */
function resolveWorkingDirectory(): string {
  const candidates = [process.argv[2], process.env.JUSTBETTER_WORKSPACE];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      /* not a usable directory; try the next candidate */
    }
    console.error(`[terminal] Ignoring working directory that does not exist: ${resolved}`);
  }
  return process.cwd();
}

const WORKING_DIRECTORY = resolveWorkingDirectory();

/** Commands are killed after this long so a hung process cannot wedge the server. */
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

const server = new Server({ name: "terminal", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run_terminal_command",
        description: `Execute a command in the host terminal (Powershell/Cmd/Bash) and get the standard output and error. Commands run in ${WORKING_DIRECTORY}, so relative paths resolve there.`,
        inputSchema: {
          type: "object",
          properties: {
            command: { 
              type: "string",
              description: "The command to run"
            }
          },
          required: ["command"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  if (request.params.name === "run_terminal_command") {
    const cmd = request.params.arguments?.command;
    if (!cmd) {
      return { isError: true, content: [{ type: "text", text: "Command is required" }] };
    }
    
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: WORKING_DIRECTORY,
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer to prevent crash on large outputs
        // A command that never returns would otherwise hold this server open forever.
        timeout: COMMAND_TIMEOUT_MS
      });
      
      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += `\nSTDERR:\n${stderr}`;
      
      if (!output) output = "Command executed successfully with no output.";
      
      return {
        content: [{ type: "text", text: output }]
      };
    } catch (e: any) {
      const reason = e?.killed
        ? `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s and was terminated.`
        : e?.message;
      return {
        isError: true,
        content: [{ type: "text", text: `Execution failed: ${reason}\nSTDOUT: ${e.stdout ?? ''}\nSTDERR: ${e.stderr ?? ''}` }]
      };
    }
  }
  throw new Error("Tool not found");
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[terminal] Commands run in: ${WORKING_DIRECTORY}`);
}

run().catch(console.error);
