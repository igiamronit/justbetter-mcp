import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";
import {
  smartTruncate, toolContentToText, pruneMessages, resolveProxyUrl,
  resolveProxyBase, waitForProxy, MAX_TOOL_CHARS, MAX_CONTEXT_CHARS
} from "./agent-common.js";
import { packagePath, resolveConfigPath } from "./paths.js";

const configPath = resolveConfigPath(process.argv[2]);
let cliConfig: any = {};
try {
  cliConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch (e: any) {
  // It will warn later or fail gracefully
}

const PROXY_URL = resolveProxyUrl(cliConfig);

let mcpClient: Client;
let messages: any[] = [
  { 
    role: "system", 
    content: "JUSTBETTER_CLI_AGENT" 
  }
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\nUser > "
});

async function runAgenticLoop() {
  let isFinished = false;
  let turns = 0;
  let requestToolsMisses = 0;
  const MAX_TURNS = 10;

  while (!isFinished) {
    if (turns >= MAX_TURNS) {
      console.log(`\n[System: 🛑 AI reached the maximum of ${MAX_TURNS} tool turns. Forcing a stop to prevent infinite loops.]`);
      break;
    }
    turns++;

    try {
      // Bound the transcript before each call; without this the history grows for the
      // whole session and only ever stops at the provider's context limit.
      messages = pruneMessages(messages, MAX_CONTEXT_CHARS);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cliConfig.llmProxy?.authToken) {
        headers["X-JustBetter-Token"] = cliConfig.llmProxy.authToken;
      }

      const response = await fetch(PROXY_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: cliConfig.llmProxy?.model || "mistral-large-latest",
          messages: messages,
          tools: [] // The LLM Proxy will automatically inject these!
        })
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`\n[System: Error from LLM Proxy: ${response.status} ${err}]`);
        break;
      }

      const data = await response.json();
      const message = data.choices[0].message;

      // Display AI thought/content if present
      if (message.content) {
        console.log(`\nAI > ${message.content}`);
      }

      // Check if AI decided to stop or use a tool
      if (!message.tool_calls || message.tool_calls.length === 0) {
        messages.push(message);
        isFinished = true;
      } else {
        // AI called one or more tools
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          const name = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments || "{}");
          
          console.log(`\n[⏳ Executing tool '${name}'...]`);

          try {
            // Execute autonomously via our MCP stdio connection
            const result = await mcpClient.callTool({
              name,
              arguments: args
            });
            
            // Format result for the LLM and strictly truncate massive outputs
            let resultText = "";
            let isFailure = result.isError;
            
            if (result.isError) {
              resultText = "Error: ";
            }
            resultText += toolContentToText(result.content);

            // Check for common filesystem errors that might not set isError flag
            if (resultText.toLowerCase().includes("enoent") || resultText.toLowerCase().includes("no such file")) {
              isFailure = true;
            }

            // PREVENT CONTEXT EXHAUSTION
            if (resultText.length > MAX_TOOL_CHARS) {
              resultText = smartTruncate(resultText, MAX_TOOL_CHARS);
            }
            
            // IF TOOL FAILED, INJECT A LOUD RETRY DIRECTIVE
            if (isFailure) {
              const lowerRes = resultText.toLowerCase();
              const isHallucination = lowerRes.includes('is not currently available. please use');
              const isEnoent = lowerRes.includes('enoent') || lowerRes.includes('no such file');
              const isAuth = lowerRes.includes('eacces') || lowerRes.includes('eperm') || lowerRes.includes('permission denied') || lowerRes.includes('unauthorized') || lowerRes.includes('401') || lowerRes.includes('403');
              
              if (isHallucination) {
                resultText = `[TOOL EXECUTION FAILED]\n${resultText}`;
              } else if (isAuth) {
                resultText = `[TOOL EXECUTION FAILED]\n${resultText}\n\n[SYSTEM DIRECTIVE]: The tool failed. Do not retry with the same approach. Tell the user this requires a permission or credential they need to fix.`;
              } else if (isEnoent) {
                resultText = `[TOOL EXECUTION FAILED]\n${resultText}\n\n[SYSTEM DIRECTIVE]: The tool failed. DO NOT apologize or give up. If it failed due to a missing path, you MUST use 'list_directory' on the root first to safely inspect the top-level structure. If two different approaches both fail, stop and explain the blocker to the user rather than continuing to retry.`;
              } else {
                resultText = `[TOOL EXECUTION FAILED]\n${resultText}\n\n[SYSTEM DIRECTIVE]: The tool failed for the reason shown above — inspect the error message itself before retrying. If two different approaches both fail, stop and explain the blocker to the user rather than continuing to retry.`;
              }
              console.log(`[❌ Tool reported failure]`);
            } else {
              console.log(`[✅ Tool completed]`);
            }
            
            if (name === 'request_tools') {
              if (resultText.includes('No matching tools found')) {
                requestToolsMisses++;
                if (requestToolsMisses >= 2) {
                  resultText = `${resultText}\n\n[SYSTEM DIRECTIVE]: Multiple searches haven't found this capability — it likely doesn't exist in this environment. Tell the user, or propose a workaround, rather than continuing to search.`;
                }
              } else {
                requestToolsMisses = 0;
              }
            }

            messages.push({
              role: "tool",
              name: name,
              tool_call_id: toolCall.id,
              content: resultText
            });
          } catch (e: any) {
            console.error(`[❌ Error running ${name}]: ${e.message}`);
            messages.push({
              role: "tool",
              name: name,
              tool_call_id: toolCall.id,
              content: `Error: ${e.message}`
            });
          }
        }
      }
    } catch (e: any) {
      console.error(`\n[System: Execution error: ${e.message}]`);
      break;
    }
  }

  rl.prompt();
}

async function start() {
  console.log("🚀 Starting JustBetter CLI...");
  
  console.log(`Config: ${configPath}`);
  if (!cliConfig.llmProxy) {
    console.warn(`[Warning] No llmProxy block found in ${configPath}. CLI requires this to function!`);
  }
  
  // 1. Boot the gateway as a background process via MCP stdio.
  //    Paths are resolved from this module's location, so `justbetter-cli` works from
  //    any directory without the child needing a meaningful cwd.
  const transport = new StdioClientTransport({
    command: process.execPath,
    // Go through bin/cli.js rather than invoking tsx directly: it is the single
    // place that knows how to locate the tsx runtime across hoisted and nested
    // node_modules layouts.
    args: [packagePath("bin", "cli.js"), "gateway", configPath],
    // Not the package root: a live process sitting in the install directory is what
    // makes `npm install -g` fail with EBUSY on Windows.
    cwd: os.tmpdir(),
    env: process.env as Record<string, string> // Inherit env vars (secrets, etc)
  });

  mcpClient = new Client({ name: "justbetter-cli", version: "1.0.0" }, { capabilities: {} });
  
  console.log("⌛ Waiting for Gateway and LLM Proxy to boot...");
  await mcpClient.connect(transport);

  // Poll the proxy's health endpoint rather than sleeping a fixed interval and hoping
  // the HTTP server finished binding.
  const ready = await waitForProxy(resolveProxyBase(cliConfig));
  if (!ready) {
    console.warn(`\n[Warning] LLM Proxy did not report healthy at ${resolveProxyBase(cliConfig)}/health.`);
    console.warn(`[Warning] Check that llmProxy is enabled and its port is free.`);
  }
  console.log("\n✅ Connected! Type 'exit' to quit.");

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log("Goodbye!");
      await mcpClient.close();
      process.exit(0);
    }
    
    if (!input) {
      rl.prompt();
      return;
    }

    // Add to history and kick off the loop
    messages.push({ role: "user", content: input });
    
    // Pause prompt while AI thinks
    rl.pause();
    await runAgenticLoop();
    rl.resume();
  });
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});
