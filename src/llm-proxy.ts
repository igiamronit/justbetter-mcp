import express from 'express';
import { embed } from './embeddings.js';
import { searchTools, getToolByName, getAllToolSummaries } from './catalog.js';
import type { Config } from './config.js';

import { markToolInjected } from './session.js';
import { broadcastEvent } from './dashboard/server.js';

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

      // Step 3: Search the catalog for semantically matching tools
      const matchedTools = searchTools(promptVector, 0.28, 15);
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
        const schema = JSON.parse(match.full_schema_json);
        toolSchemas.push({
          type: "function",
          function: schema
        });
        markToolInjected(match.tool_name);
      }

      // Add pinned tools (if not already matched)
      const matchedToolNames = new Set(matchedTools.map(t => t.tool_name));
      for (const pinnedName of config.pinnedTools) {
        if (!matchedToolNames.has(pinnedName)) {
          const pinnedTool = getToolByName(pinnedName);
          if (pinnedTool) {
            const schema = JSON.parse(pinnedTool.full_schema_json);
            toolSchemas.push({
              type: "function",
              function: schema
            });
            markToolInjected(pinnedTool.tool_name);
            console.error(`  + ${pinnedName} (pinned)`);
          }
        }
      }

      // Always add the request_tools fallback
      toolSchemas.push(REQUEST_TOOLS_SCHEMA);
      markToolInjected('request_tools');

      // Step 5: Inject tools into the request body
      body.tools = toolSchemas;

      // Step 6: Inject summary pool as a system message (if not already present)
      const hasSummaryMessage = messages.some((m: any) =>
        m.role === 'system' && m.content?.includes('The system will automatically provide relevant tool schemas')
      );
      if (!hasSummaryMessage) {
        const summaryPool = getAllToolSummaries();
        const summaryMessage = {
          role: 'system',
          content: `You have access to tools. The system will automatically provide relevant tool schemas based on the user's request. If no provided tool matches what you need, use the request_tools function to search for the right tool.\n\nAvailable capabilities:\n${summaryPool}`
        };
        // Insert at position 1 (after any existing system message, before user messages)
        const firstUserIdx = messages.findIndex((m: any) => m.role === 'user');
        if (firstUserIdx > 0) {
          messages.splice(firstUserIdx, 0, summaryMessage);
        } else {
          messages.unshift(summaryMessage);
        }
        body.messages = messages;
      }

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

  return server;
}
