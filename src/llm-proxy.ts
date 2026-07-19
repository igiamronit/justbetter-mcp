import express from 'express';
import fs from 'fs';
import { embed } from './embeddings.js';
import { searchTools, getToolByName, getAllToolSummaries, markToolInjected, getRecentlyInjectedTools } from './catalog.js';
import type { Config } from './config.js';
import { getEffectiveApiBase, getEffectiveApiKey } from './config.js';
import { serverStatuses, activeUpstreams } from './upstream.js';
import { broadcastEvent } from './dashboard/server.js';
import { passesPreconditions } from './gates/precondition.js';
import { fetchWithRetry } from './fetch-retry.js';

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

      const connectedServerNames = activeUpstreams.map((u: any) => u.name);

      let matchedTools: any[] = [];
      if (config.semanticPromptInjection) {
        // Step 2: Embed the user prompt
        const promptVector = await embed(userPrompt);

        // Step 3: Search the catalog for semantically matching tools (excluding pinned tools to save compute)
        // We use a strict threshold (0.35) and low topK (4) for auto-injection to save tokens.
        // If the LLM needs something else, it will use request_tools (which casts a wider net).
        matchedTools = searchTools(promptVector, connectedServerNames, config.pinnedTools, 0.35, 4);
        console.error(`[LLM Proxy] Semantic search found ${matchedTools.length} tools:`);
        matchedTools.forEach(t => {
          console.error(`  - ${t.tool_name} (score: ${t.score.toFixed(4)})`);
        });
      } else {
        console.error(`[LLM Proxy] Semantic prompt injection is disabled. Prompt embedding skipped.`);
      }

      broadcastEvent({
        type: 'discovery_trace',
        prompt: userPrompt,
        matchedTools: matchedTools.map(t => ({ name: t.tool_name, score: t.score })),
        tokensSaved: Math.max(0, 15000 - (matchedTools.length * 400)),
        isFallback: false
      });

      // Step 4: Build the tools array to inject using a single-pass Deduplication Map
      const finalTools = new Map();

      // 1. Pinned Tools (Added first so they are guaranteed present)
      for (const pinnedName of config.pinnedTools) {
        const pinnedTool = getToolByName(pinnedName, connectedServerNames);
        if (pinnedTool && passesPreconditions(pinnedTool.tool_name, pinnedTool.server_name, config)) {
          finalTools.set(pinnedName, JSON.parse(pinnedTool.full_schema_json));
        }
      }

      // 2. Semantically Matched Tools
      for (const match of matchedTools) {
        if (passesPreconditions(match.tool_name, match.server_name, config)) {
          finalTools.set(match.tool_name, JSON.parse(match.full_schema_json));
        }
      }

      // 3. Recently requested tools (to prevent hallucination failures on subsequent turns)
      const recentlyInjected = getRecentlyInjectedTools();
      for (const t of recentlyInjected) {
        // Ensure they belong to connected servers
        if (connectedServerNames.includes(t.server_name) && passesPreconditions(t.tool_name, t.server_name, config)) {
          finalTools.set(t.tool_name, JSON.parse(t.full_schema_json));
        }
      }

      // 4. Fallbacks (request_tools & batch_call)
      finalTools.set('request_tools', REQUEST_TOOLS_SCHEMA);
      finalTools.set('batch_call', BATCH_CALL_SCHEMA);

      // Assemble final array and mark injected
      const toolSchemas: any[] = [];
      const injectedToolNames = new Set<string>();

      for (const [name, schema] of finalTools) {
        toolSchemas.push(
          (name === 'request_tools' || name === 'batch_call') ? schema : {
            type: "function",
            function: {
              name,
              description: schema.description || "",
              parameters: schema.inputSchema || { type: "object", properties: {} }
            }
          }
        );
        injectedToolNames.add(name);
        markToolInjected(name);
      }

      // Step 5: Inject tools into the request body
      body.tools = toolSchemas;

      // Step 6: System Prompt Assembly
      // Exclude already injected tools from the text summary pool to save tokens
      const summaryPool = getAllToolSummaries(connectedServerNames, injectedToolNames);
      
      const isCliAgent = messages.length > 0 && messages[0].role === 'system' && messages[0].content === 'JUSTBETTER_CLI_AGENT';

      if (isCliAgent) {
        messages[0].content = `You are JustBetter CLI, an autonomous coding assistant operating through an MCP Gateway with dynamically-injected tools.

## Path resolution
If you already know the exact file path (the user gave it, or you've seen it already), open it directly. Only when the path is unknown or you're guessing, call list_directory on root first (cheap, always safe) to see the top-level folders, THEN scope your broad search to the specific subdirectory that looks relevant (e.g. src/, not the whole repo). Never call a read/write tool with a bare or guessed filename. Treat every path as unverified until a tool result confirms it.

## Tool result validation
A tool call that completes without throwing is NOT the same as success — read the result content itself. If it contains an error, an empty result, or a "not found" message, that is a signal to retry with a different path or search strategy, not a final answer.

## Persistence
Never report "file not found" or "doesn't exist" after a single attempt. Try at least one alternate path, directory, or naming convention first. If you've exhausted reasonable search strategies, say what you tried before concluding it's missing.

## Reflection
Reflect on tool results before acting on them. After receiving tool results, carefully reflect on their quality and determine optimal next steps in your content output before proceeding with the next tool call.

## Tool access (Dynamic Semantic Tool Injection)
Tools are injected per turn based on relevance. Tools provided in your native tool array with full parameters are ready to call now. Capabilities listed below only by name are NOT yet loaded — you must call request_tools with a description before you can use them. Calling an unloaded tool directly will be blocked.

Available capabilities:
${summaryPool}

## Tool usage
If the user simply says "hi", "hello", or engages in casual conversation where no action is required, DO NOT call any tools. Only call tools when strictly necessary to fulfill the user's request.

## Style
Reference files by absolute path. No filler text before tool calls.`;
      } else {
        const hasSummaryMessage = messages.some((m: any) =>
          m.role === 'system' && m.content?.includes('Dynamic Semantic Tool Injection')
        );
        if (!hasSummaryMessage) {
          const summaryMessage = {
            role: 'system',
            content: `\n\n[CRITICAL GATEWAY INSTRUCTIONS]\nYou are operating through an MCP Gateway that uses Dynamic Semantic Tool Injection. DO NOT hallucinate tool calls. Tools provided in your native tool array with full parameters are ready to call now. Capabilities listed below only by name are NOT yet loaded — YOU MUST FIRST call the 'request_tools' function to explicitly fetch a schema before attempting to use it.\n\nAvailable capabilities:\n${summaryPool}`
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

      // Step 7: Forward to the real LLM API (using provider-aware config)
      const effectiveBase = getEffectiveApiBase(config);
      const effectiveKey = getEffectiveApiKey(config);
      const realUrl = `${effectiveBase}/chat/completions`;

      const forwardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${effectiveKey}`,
      };

      const realResponse = await fetchWithRetry(realUrl, {
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
        try {
          const parsed = JSON.parse(responseData);
          if (parsed.usage) {
            const injectedCount = toolSchemas.length;
            const logLine = `${new Date().toISOString()},${parsed.usage.prompt_tokens || 0},${parsed.usage.completion_tokens || 0},${parsed.usage.total_tokens || 0},${injectedCount}\n`;
            if (!fs.existsSync('token_log.csv')) {
              fs.writeFileSync('token_log.csv', 'timestamp,prompt_tokens,completion_tokens,total_tokens,tools_injected\n');
            }
            fs.appendFileSync('token_log.csv', logLine);
          }
        } catch (e) {
          console.error('[LLM Proxy] Failed to parse token usage:', e);
        }
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
      const effectiveBase = getEffectiveApiBase(config);
      const effectiveKey = getEffectiveApiKey(config);
      const realUrl = `${effectiveBase}${req.path}`;
      const realResponse = await fetchWithRetry(realUrl, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${effectiveKey}`,
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
    console.error(`[LLM Proxy] Provider: ${config.apiProvider || 'gemini'} → ${getEffectiveApiBase(config)}`);
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
