import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

/** Commands are killed after this long so a hung process cannot wedge the server. */
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

const server = new Server({ name: "terminal", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run_terminal_command",
        description: "Execute a command in the host terminal (Powershell/Cmd/Bash) and get the standard output and error.",
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
}

run().catch(console.error);
