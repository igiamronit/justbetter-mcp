import express from 'express';
import { embed } from './embeddings.js';
import { searchTools, getToolByName, getAllToolSummaries, markToolInjected } from './catalog.js';
import type { Config } from './config.js';
import { serverStatuses, activeUpstreams } from './upstream.js';
import { broadcastEvent } from './dashboard/server.js';
import { passesPreconditions } from './gates/precondition.js';

// The request_tools fallback schema — always injected alongside matched tools
const REQUEST_TOOLS_SCHEMA = {
  type: "function" as const,
  function: {
    name: "request_tools",
    description: "If none of your current tools can fulfill the user's request, call this with a precise description of what capability you need. The system will search for and provide matching tools.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A clear description of the tool capability you need"
        }
      },
      required: ["query"]
    }
  }
};

const BATCH_CALL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "batch_call",
    description: "Execute multiple tools sequentially in a single turn to save time.",
    parameters: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          description: "List of tools to execute",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              args: { type: "object" }
            },
            required: ["tool", "args"]
          }
        }
      },
      required: ["calls"]
    }
  }
};

/**
 * Starts the LLM API Proxy on the configured port.
 * This server intercepts OpenAI-compatible chat completion requests,
 * embeds the user's prompt, searches the tool catalog, and injects
 * the matched tool schemas into the request before forwarding to
 * the real LLM API.
 */
export function startLlmProxy(config: Config) {
  const llmConfig = config.llmProxy;
  if (!llmConfig) {
    console.error("LLM Proxy: No llmProxy config found. Skipping LLM API proxy.");
    return;
  }

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'justbetter-mcp-llm-proxy' });
  });

  // Intercept chat completion requests
  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const body = req.body;
      const messages: any[] = body.messages || [];

      // Step 1: Extract the latest user message
      const lastUserMessage = messages.filter((m: any) => m.role === 'user').at(-1);
      const userPrompt = lastUserMessage?.content || '';

      console.error(`\n[LLM Proxy] Intercepted prompt: "${userPrompt.slice(0, 80)}${userPrompt.length > 80 ? '...' : ''}"`);

      // Step 2: Embed the user prompt
      const promptVector = await embed(userPrompt);

      const connectedServerNames = activeUpstreams.map((u: any) => u.name);

      // Step 3: Search the catalog for semantically matching tools
      const matchedTools = searchTools(promptVector, connectedServerNames, 0.15, 15);
      console.error(`[LLM Proxy] Semantic search found ${matchedTools.length} tools:`);
      matchedTools.forEach(t => {
        console.error(`  - ${t.tool_name} (score: ${t.score.toFixed(4)})`);
      });

      broadcastEvent({
        type: 'discovery_trace',
        prompt: userPrompt,
        matchedTools: matchedTools.map(t => ({ name: t.tool_name, score: t.score })),
        tokensSaved: Math.max(0, 15000 - (matchedTools.length * 400)),
        isFallback: false
      });

      // Step 4: Build the tools array to inject
      const toolSchemas: any[] = [];

      // Add semantically matched tools
      for (const match of matchedTools) {
        if (!passesPreconditions(match.tool_name, match.server_name, config)) {
          continue; // Skip injecting this tool because preconditions failed
        }
        
        const schema = JSON.parse(match.full_schema_json);
        toolSchemas.push({
          type: "function",
          function: {
            name: schema.name,
            description: schema.description || "",
            parameters: schema.inputSchema || { type: "object", properties: {} }
          }
        });
        markToolInjected(match.tool_name);
      }

      // Add pinned tools (if not already matched)
      const matchedToolNames = new Set(matchedTools.map(t => t.tool_name));
      for (const pinnedName of config.pinnedTools) {
        if (!matchedToolNames.has(pinnedName)) {
          const pinnedTool = getToolByName(pinnedName, connectedServerNames);
          if (pinnedTool) {
            if (!passesPreconditions(pinnedTool.tool_name, pinnedTool.server_name, config)) {
              continue; // Skip pinned tool if preconditions fail
            }
            const schema = JSON.parse(pinnedTool.full_schema_json);
            toolSchemas.push({
              type: "function",
              function: {
                name: schema.name,
                description: schema.description || "",
                parameters: schema.inputSchema || { type: "object", properties: {} }
              }
            });
            markToolInjected(pinnedTool.tool_name);
            console.error(`  + ${pinnedName} (pinned)`);
          }
        }
      }

      // Always add the request_tools and batch_call fallbacks
      toolSchemas.push(REQUEST_TOOLS_SCHEMA);
      markToolInjected('request_tools');
      
      toolSchemas.push(BATCH_CALL_SCHEMA);
      markToolInjected('batch_call');

      // Step 5: Inject tools into the request body
      body.tools = toolSchemas;

      // Step 6: System Prompt Assembly
      const summaryPool = getAllToolSummaries(connectedServerNames);
      
      const isCliAgent = messages.length > 0 && messages[0].role === 'system' && messages[0].content === 'JUSTBETTER_CLI_AGENT';

      if (isCliAgent) {
        messages[0].content = `You are JustBetter CLI, an autonomous coding assistant operating through an MCP Gateway with dynamically-injected tools.

## Path resolution
Never call a read/write tool with a bare or guessed filename. If you don't already have a path confirmed by a previous tool result, resolve it first. DO NOT walk directories one level at a time. Instead, use a one-shot broad search (like 'search_files' or 'directory_tree') scoped to a likely subdirectory rather than assuming repo root. Treat every path as unverified until a tool result confirms it.

## Tool result validation
A tool call that completes without throwing is NOT the same as success — read the result content itself. If it contains an error, an empty result, or a "not found" message, that is a signal to retry with a different path or search strategy, not a final answer.

## Persistence
Never report "file not found" or "doesn't exist" after a single attempt. Try at least one alternate path, directory, or naming convention first. If you've exhausted reasonable search strategies, say what you tried before concluding it's missing.

## Reflection
Reflect on tool results before acting on them. After receiving tool results, carefully reflect on their quality and determine optimal next steps in your content output before proceeding with the next tool call.

## Tool access (Dynamic Semantic Tool Injection)
Tools are injected per turn based on relevance — you may only call tools whose schema was provided this turn. The capability list below is for awareness only, not a callable tool list. If you need something from it that isn't in your current schemas, call request_tools to fetch it first, then use it. Calling an unlisted tool will be blocked.

Available capabilities:
${summaryPool}

## Style
Reference files by absolute path. No filler text before tool calls.`;
      } else {
        const hasSummaryMessage = messages.some((m: any) =>
          m.role === 'system' && m.content?.includes('Dynamic Semantic Tool Injection')
        );
        if (!hasSummaryMessage) {
          const summaryMessage = {
            role: 'system',
            content: `\n\n[CRITICAL GATEWAY INSTRUCTIONS]\nYou are operating through an MCP Gateway that uses Dynamic Semantic Tool Injection. DO NOT hallucinate tool calls. You can ONLY call tools if their JSON schema is explicitly provided to you in the current turn. Below is a SUMMARY of available capabilities. If you need a tool from this summary that is NOT in your current schemas, YOU MUST FIRST call the 'request_tools' function to explicitly fetch its schema.\n\nAvailable capabilities:\n${summaryPool}`
          };
          const firstUserIdx = messages.findIndex((m: any) => m.role === 'user');
          if (firstUserIdx > 0) {
            messages.splice(firstUserIdx, 0, summaryMessage);
          } else {
            messages.unshift(summaryMessage);
          }
        }
      }
      body.messages = messages;

      console.error(`[LLM Proxy] Injected ${toolSchemas.length} tools (${toolSchemas.length - 1} matched/pinned + request_tools fallback)`);

      // Step 7: Forward to the real LLM API
      const realUrl = `${llmConfig.realApiBase}/chat/completions`;

      // Clone the original headers, swap auth, remove host
      const forwardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.realApiKey}`,
      };

      const realResponse = await fetch(realUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify(body),
      });

      // Step 8: Stream or return the response
      const contentType = realResponse.headers.get('content-type') || 'application/json';
      res.setHeader('Content-Type', contentType);
      res.status(realResponse.status);

      if (body.stream) {
        // For streaming responses, pipe the body through
        if (realResponse.body) {
          const reader = realResponse.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                res.end();
                break;
              }
              res.write(value);
            }
          };
          pump().catch(err => {
            console.error('[LLM Proxy] Stream error:', err);
            res.end();
          });
        } else {
          const text = await realResponse.text();
          res.send(text);
        }
      } else {
        // Non-streaming: return full JSON
        const responseData = await realResponse.text();
        res.send(responseData);
      }

    } catch (err: any) {
      console.error('[LLM Proxy] Error:', err.message);
      res.status(500).json({
        error: { message: `LLM Proxy error: ${err.message}`, type: 'proxy_error' }
      });
    }
  });

  // Proxy all other OpenAI-compatible endpoints directly (models, embeddings, etc.)
  app.use('/v1', async (req, res) => {
    // Skip chat/completions since we handle that with a dedicated route above
    if (req.path === '/chat/completions') return;

    try {
      const realUrl = `${llmConfig.realApiBase}${req.path}`;
      const realResponse = await fetch(realUrl, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmConfig.realApiKey}`,
        },
        body: ['GET', 'HEAD'].includes(req.method) ? null : JSON.stringify(req.body),
      });
      const data = await realResponse.text();
      res.status(realResponse.status).send(data);
    } catch (err: any) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  const server = app.listen(llmConfig.port, () => {
    console.error(`[LLM Proxy] Listening on http://localhost:${llmConfig.port}/v1`);
    console.error(`[LLM Proxy] Forwarding to ${llmConfig.realApiBase}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[LLM Proxy] Port ${llmConfig.port} is already in use. Assuming LLM Proxy is already running in another instance.`);
    } else {
      console.error(`[LLM Proxy] Error: ${err.message}`);
    }
  });

  return server;
}
