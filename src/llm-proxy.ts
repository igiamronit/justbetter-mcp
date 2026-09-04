import express from 'express';
import fs from 'fs';
import { embed } from './embeddings.js';
import {
  searchTools, getToolByName, getAllToolSummaries, markToolInjected,
  getRecentlyInjectedTools, getActiveTools, getActiveSchemaBytes
} from './catalog.js';
import type { Config } from './config.js';
import { getEffectiveApiBase, getEffectiveApiKey } from './config.js';
import { serverStatuses, activeUpstreams } from './upstream.js';
import { broadcastEvent } from './dashboard/server.js';
import { passesPreconditions } from './gates/precondition.js';
import { fetchWithRetry } from './fetch-retry.js';
import { TOKEN_LOG_PATH } from './paths.js';

/**
 * OpenAI-compatible clients may send `content` as a plain string or as an array of
 * typed content parts (any multimodal or cache-annotated request). Assuming a string
 * and calling .split() on it turned every such request into a 500.
 */
function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

/** Rough char-per-token estimate, only ever used for the dashboard's savings figure. */
const CHARS_PER_TOKEN = 4;

/** Appends one row to the token log. Resolved absolutely so it cannot follow the cwd. */
function logTokenUsage(usage: any, injectedCount: number) {
  if (!usage) return;
  try {
    const logFile = TOKEN_LOG_PATH();
    const logLine = `${new Date().toISOString()},${usage.prompt_tokens || 0},${usage.completion_tokens || 0},${usage.total_tokens || 0},${injectedCount}\n`;
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, 'timestamp,prompt_tokens,completion_tokens,total_tokens,tools_injected\n');
    }
    fs.appendFileSync(logFile, logLine);
  } catch (e: any) {
    console.error('[LLM Proxy] Failed to write token log:', e.message);
  }
}

/**
 * Best-effort usage extraction from an SSE stream tail. Providers only emit a usage
 * block when the caller asked for one, so a miss here is normal and simply means the
 * turn goes unlogged rather than being logged wrongly.
 */
function parseStreamUsage(tail: string): any | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.usage) return parsed.usage;
    } catch {
      /* partial or non-JSON chunk */
    }
  }
  return undefined;
}

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
          description: "A clear description of the capability you need. IMPORTANT: Start your query with 'A tool to...' to ensure optimal semantic matching (e.g. 'A tool to search the web')."
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

  // Optional shared secret. This proxy forwards every request with the real provider
  // key attached, so when a token is configured it must be presented; without one the
  // loopback bind is the only thing standing between a local process and free use of
  // that key.
  if (llmConfig.authToken) {
    app.use('/v1', (req, res, next) => {
      const header = req.get('authorization') || '';
      const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      const provided = bearer || req.get('x-justbetter-token') || '';
      if (provided !== llmConfig.authToken) {
        return res.status(401).json({ error: { message: 'Unauthorized: invalid JustBetter proxy token.', type: 'proxy_auth' } });
      }
      next();
    });
  }

  // Intercept chat completion requests
  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const body = req.body;
      const messages: any[] = body.messages || [];

      // Step 1: Extract the latest user message
      const lastUserMessage = messages.filter((m: any) => m.role === 'user').at(-1);
      const userPrompt = extractText(lastUserMessage?.content);

      console.error(`\n[LLM Proxy] Intercepted prompt: "${userPrompt.slice(0, 80)}${userPrompt.length > 80 ? '...' : ''}"`);

      const connectedServerNames = activeUpstreams.map((u: any) => u.name);

      let matchedTools: any[] = [];
      if (config.injectAllTools) {
        matchedTools = getActiveTools(connectedServerNames);
        console.error(`[LLM Proxy] Injecting ALL ${matchedTools.length} tools as requested (bypassing semantic search).`);
      } else if (config.semanticPromptInjection) {
        // Step 2: Chunk the prompt into sentences/clauses to prevent vector dilution on complex multi-intent prompts
        const clauses = userPrompt.split(/(?<=[.!?])\s+|,\s+(?=and\s)/).filter((c: string) => c.trim().length > 3);
        if (clauses.length === 0 && userPrompt.trim().length > 0) {
          clauses.push(userPrompt.trim());
        }

        const allMatchedTools: any[] = [];
        
        // Step 3: Embed each clause and search the catalog for semantically matching tools
        for (const clause of clauses) {
          const queryVector = await embed(clause);
          // Unconditionally grab the top 5 matches for each clause
          const results = searchTools(queryVector, connectedServerNames, config.pinnedTools, -1.0, 5);
          allMatchedTools.push(...results);
        }

        // Deduplicate by max score, then sort descending and take top 5 overall
        const deduped = new Map<string, any>();
        for (const tool of allMatchedTools) {
          const existing = deduped.get(tool.tool_name);
          if (!existing || tool.score > existing.score) {
            deduped.set(tool.tool_name, tool);
          }
        }

        matchedTools = Array.from(deduped.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        console.error(`[LLM Proxy] Semantic chunking found ${matchedTools.length} tools across ${clauses.length} clauses:`);
        matchedTools.forEach(t => {
          console.error(`  - ${t.tool_name} (max score: ${t.score.toFixed(4)})`);
        });
      } else {
        console.error(`[LLM Proxy] Semantic prompt injection is disabled. Prompt embedding skipped.`);
      }

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

      // 3. Recently requested tools (to prevent hallucination failures on subsequent turns).
      //    Bounded and ordered most-recent-first: an unbounded rolling window makes the
      //    injected set grow monotonically until it approaches the whole catalog, which
      //    quietly turns Mode 1 back into the Mode 3 inject-all baseline mid-session.
      //    Pinned tools are excluded because step 1 already re-added every one of them.
      const recentlyInjected = getRecentlyInjectedTools(config.pinnedTools);
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

      // Measure the actual saving instead of guessing at it: the Mode 3 baseline is the
      // serialized size of every active schema, and what we send is the serialized size
      // of the schemas we selected. Both are real bytes, converted at a stated ratio.
      const injectedBytes = JSON.stringify(toolSchemas).length;
      const injectAllBytes = getActiveSchemaBytes(connectedServerNames);
      const tokensSaved = Math.max(0, Math.round((injectAllBytes - injectedBytes) / CHARS_PER_TOKEN));

      broadcastEvent({
        type: 'discovery_trace',
        prompt: userPrompt,
        matchedTools: matchedTools.map(t => ({ name: t.tool_name, score: t.score })),
        injectedTools: Array.from(injectedToolNames),
        tokensSaved,
        isEstimate: true,
        isFallback: false
      });

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
      res.setHeader('X-JustBetter-Injected-Count', toolSchemas.length.toString());
      res.setHeader('X-JustBetter-Injected-Tools', Array.from(injectedToolNames).join(', '));
      res.status(realResponse.status);

      if (body.stream) {
        // For streaming responses, pipe the body through while watching the tail for a
        // usage block, so streamed turns are represented in the token log too.
        if (realResponse.body) {
          const reader = realResponse.body.getReader();
          const decoder = new TextDecoder();
          let tail = '';

          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                logTokenUsage(parseStreamUsage(tail), toolSchemas.length);
                res.end();
                break;
              }
              tail = (tail + decoder.decode(value, { stream: true })).slice(-16384);
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
          logTokenUsage(parsed.usage, toolSchemas.length);
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
  app.use('/v1', async (req, res, next) => {
    // Skip chat/completions since the dedicated POST route above handles it. Handing off
    // to next() matters: returning here left non-POST requests to that path with no
    // response at all, so the socket hung open until the client gave up.
    if (req.path === '/chat/completions') return next();

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

  const host = llmConfig.host || '127.0.0.1';

  const server = app.listen(llmConfig.port, host, () => {
    console.error(`[LLM Proxy] Listening on http://${host}:${llmConfig.port}/v1`);
    console.error(`[LLM Proxy] Provider: ${config.apiProvider || 'gemini'} → ${getEffectiveApiBase(config)}`);
    if (!llmConfig.authToken) {
      console.error(`[LLM Proxy] No authToken set: any process on this machine can spend the configured API key.`);
    }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.error(`[LLM Proxy] ⚠️  Bound to ${host}, not loopback. This exposes your provider API key to the network.`);
    }
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[LLM Proxy] ⚠️  Port ${llmConfig.port} is already in use, so THIS instance has no LLM proxy.`);
      console.error(`[LLM Proxy]    Requests to that port are served by the other process. Set llmProxy.port, or llmProxy.enabled=false, to silence this.`);
    } else {
      console.error(`[LLM Proxy] Error: ${err.message}`);
    }
  });

  return server;
}
