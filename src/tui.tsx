import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';

const configPath = process.argv[2] || 'config.json';
let cliConfig: any = {};
try {
  cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e: any) {
  // The proxy will surface config errors if they matter at runtime.
}

const INITIAL_LLM_MESSAGES = [{ role: 'system', content: 'JUSTBETTER_CLI_AGENT' }];
const MAX_TURNS = 20;
const MAX_TOOL_CHARS = 15000;
const ASSISTANT_PREVIEW_LINES = 8;
const TOOL_CONTENT_PREVIEW_LINES = 6;

function smartTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  
  const halfLimit = Math.floor(maxLength / 2);
  
  // Find the last newline before halfLimit for the head
  let headEnd = text.lastIndexOf('\n', halfLimit);
  if (headEnd === -1) headEnd = halfLimit; // fallback if no newlines
  
  // Find the first newline after (text.length - halfLimit) for the tail
  const tailStartTarget = text.length - halfLimit;
  let tailStart = text.indexOf('\n', tailStartTarget);
  if (tailStart === -1) tailStart = tailStartTarget; // fallback
  
  // If we couldn't find good boundaries or they overlap weirdly, just hard cut
  if (headEnd >= tailStart) {
    headEnd = halfLimit;
    tailStart = text.length - halfLimit;
  }
  
  const head = text.substring(0, headEnd);
  const tail = text.substring(tailStart);
  const omitted = text.length - (head.length + tail.length);
  
  return `${head}\n\n...[SYSTEM WARNING: OUTPUT TRUNCATED. OMITTED ${omitted} CHARACTERS TO PREVENT CONTEXT EXHAUSTION]...\n\n${tail}`;
}
const TOOL_ARGS_PREVIEW_LINES = 3;

type UiEventType = 'user' | 'assistant' | 'tool_request' | 'tool_running' | 'tool_result' | 'system';

type UiEvent = {
  id: string;
  turnId?: string;
  type: UiEventType;
  text?: string;
  name?: string;
  argsText?: string;
  summary?: string;
  content?: string;
  isError?: boolean;
};

type TranscriptLine = {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
};

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toolContentToText(content: any): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content ?? '');
  }

  return content.map((part) => {
    if (typeof part?.text === 'string') return part.text;
    return JSON.stringify(part);
  }).join('\n');
}

function formatToolArgs(rawArgs: any) {
  try {
    const value = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(rawArgs ?? '{}');
  }
}

function wrapText(text: any, columns: number) {
  const width = Math.max(20, columns);
  const rawLines = String(text ?? '').split('\n');
  const lines: string[] = [];

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }

    for (let i = 0; i < rawLine.length; i += width) {
      lines.push(rawLine.slice(i, i + width));
    }
  }

  return lines;
}

function prefixedLines(prefix: string, text: any, columns: number, line: Omit<TranscriptLine, 'text'> = {}) {
  const firstWidth = Math.max(20, columns - prefix.length);
  const continuation = ' '.repeat(prefix.length);
  const wrapped = wrapText(text, firstWidth);

  if (wrapped.length === 0) return [{ ...line, text: prefix }];

  return wrapped.map((wrappedLine, index) => ({
    ...line,
    text: `${index === 0 ? prefix : continuation}${wrappedLine}`
  }));
}

function limitLines(lines: TranscriptLine[], maxLines: number, expanded: boolean, marker: string) {
  if (expanded || lines.length <= maxLines) return lines;
  const hidden = lines.length - maxLines;
  return [
    ...lines.slice(0, maxLines),
    { text: `${marker} ${hidden} more lines. Press Ctrl+X to expand latest output.`, color: 'yellow' }
  ];
}

function renderEventsToLines(events: UiEvent[], columns: number, expandedEventIds: Set<string>) {
  const lines: TranscriptLine[] = [];

  for (const event of events) {
    const expanded = expandedEventIds.has(event.id);

    if (event.type === 'user') {
      lines.push({ text: '' });
      lines.push(...prefixedLines('You > ', event.text, columns, { color: 'blue', bold: true }));
      continue;
    }

    if (event.type === 'assistant') {
      lines.push({ text: '' });
      lines.push({ text: 'Assistant >', color: 'magenta', bold: true });
      const bodyLines = wrapText(event.text, columns).map(text => ({ text }));
      lines.push(...limitLines(bodyLines, ASSISTANT_PREVIEW_LINES, expanded, '[assistant collapsed]'));
      continue;
    }

    if (event.type === 'tool_request') {
      lines.push({ text: `Tool request > ${event.name}`, color: 'cyan', bold: true });
      const argLines = wrapText(event.argsText || '{}', columns).map(text => ({ text, dimColor: true }));
      lines.push(...limitLines(argLines, TOOL_ARGS_PREVIEW_LINES, expanded, '[args collapsed]'));
      continue;
    }

    if (event.type === 'tool_running') {
      lines.push({ text: `Tool running > ${event.name}`, color: 'cyan' });
      continue;
    }

    if (event.type === 'tool_result') {
      const color = event.isError ? 'red' : 'green';
      const label = event.isError ? 'Tool failed' : 'Tool done';
      lines.push({ text: `${label} > ${event.name} - ${event.summary || 'Completed'}`, color, ...(event.isError ? { bold: true } : {}) });

      if (event.content && (event.isError || expanded)) {
        const resultLines: TranscriptLine[] = wrapText(event.content, columns).map(text => (
          event.isError ? { text, color: 'red', dimColor: true } : { text, dimColor: true }
        ));
        lines.push(...limitLines(resultLines, TOOL_CONTENT_PREVIEW_LINES, expanded, '[tool output collapsed]'));
      } else if (event.content && !event.isError) {
        lines.push({ text: 'Press Ctrl+X to expand latest tool output.', dimColor: true });
      }
      continue;
    }

    if (event.type === 'system') {
      lines.push({ text: event.text || '', color: 'yellow' });
    }
  }

  return lines.length > 0 ? lines : [{ text: 'Type a message. Use PageUp/PageDown or Ctrl+U/Ctrl+D to scroll.', dimColor: true }];
}

function maskKey(key: string | undefined): string {
  if (!key || key.length < 8) return '********';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function findLatestExpandableEventId(events: UiEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if ((event.type === 'assistant' && event.text) || (event.type === 'tool_result' && event.content) || event.type === 'tool_request') {
      return event.id;
    }
  }
  return null;
}

function InputBar({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');

  const handleSubmit = (value: string) => {
    if (value.trim()) {
      onSubmit(value.trim());
      setText('');
    }
  };

  return (
    <Box height={1} overflow="hidden">
      <Text color="blue" bold>User {'>'} </Text>
      <TextInput value={text} onChange={setText} onSubmit={handleSubmit} />
    </Box>
  );
}

function StatusBar({ isBusy, connected, isPinnedToBottom }: { isBusy: boolean; connected: boolean; isPinnedToBottom: boolean }) {
  return (
    <Box height={1} overflow="hidden" flexDirection="row">
      <Text color="cyan">JustBetter MCP TUI</Text>
      <Text color="dim"> | </Text>
      <Text color={connected ? 'green' : 'yellow'}>{connected ? 'Gateway Connected' : 'Connecting...'}</Text>
      <Text color="dim"> | </Text>
      <Text color="dim">{isBusy ? 'Processing...' : 'Ready'}</Text>
      <Text color="dim"> | </Text>
      <Text color={isPinnedToBottom ? 'green' : 'yellow'}>{isPinnedToBottom ? 'Follow' : 'Scrolled'}</Text>
      <Text color="dim"> | PgUp/PgDn Ctrl+U/D Home/End Ctrl+X</Text>
    </Box>
  );
}

function App({ mcpClient }: { mcpClient: Client | null }) {
  const [llmMessages, setLlmMessages] = useState<any[]>(INITIAL_LLM_MESSAGES);
  const [events, setEvents] = useState<UiEvent[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [scrollTopLine, setScrollTopLine] = useState(0);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const { stdout } = useStdout();

  const terminalRows = stdout.rows || 24;
  const terminalColumns = stdout.columns || 80;
  const transcriptHeight = Math.max(4, terminalRows - 4);
  const transcriptLines = useMemo(
    () => renderEventsToLines(events, terminalColumns, expandedEventIds),
    [events, terminalColumns, expandedEventIds]
  );
  const maxScrollTop = Math.max(0, transcriptLines.length - transcriptHeight);
  const visibleLines = transcriptLines.slice(scrollTopLine, scrollTopLine + transcriptHeight);

  const appendEvent = (event: Omit<UiEvent, 'id'> & { id?: string }) => {
    const nextEvent = { ...event, id: event.id || createId() };
    setEvents(prev => [...prev, nextEvent]);
    return nextEvent.id;
  };

  const replaceEvent = (id: string, event: UiEvent) => {
    setEvents(prev => prev.map(item => item.id === id ? event : item));
  };

  useInput((input, key) => {
    const pageSize = Math.max(1, transcriptHeight - 1);

    if (key.pageUp || (key.ctrl && input === 'u')) {
      setIsPinnedToBottom(false);
      setScrollTopLine(prev => Math.max(0, prev - pageSize));
      return;
    }

    if (key.pageDown || (key.ctrl && input === 'd')) {
      setScrollTopLine(prev => {
        const next = Math.min(maxScrollTop, prev + pageSize);
        if (next >= maxScrollTop) setIsPinnedToBottom(true);
        return next;
      });
      return;
    }

    if (key.home) {
      setIsPinnedToBottom(false);
      setScrollTopLine(0);
      return;
    }

    if (key.end) {
      setIsPinnedToBottom(true);
      setScrollTopLine(maxScrollTop);
      return;
    }

    if (key.ctrl && input === 'x') {
      const latestExpandable = findLatestExpandableEventId(events);
      if (!latestExpandable) return;
      setExpandedEventIds(prev => {
        const next = new Set(prev);
        if (next.has(latestExpandable)) next.delete(latestExpandable);
        else next.add(latestExpandable);
        return next;
      });
    }
  });

  useEffect(() => {
    if (mcpClient) setIsConnected(true);
  }, [mcpClient]);

  useEffect(() => {
    if (isPinnedToBottom) {
      setScrollTopLine(maxScrollTop);
    } else {
      setScrollTopLine(prev => Math.min(prev, maxScrollTop));
    }
  }, [maxScrollTop, isPinnedToBottom]);

  const runAgenticLoop = async (initialHistory: any[], turnId: string) => {
    let history = [...initialHistory];
    let turns = 0;
    let requestToolsMisses = 0;

    while (mcpClient) {
      if (turns >= MAX_TURNS) {
        appendEvent({ turnId, type: 'system', text: `System: reached the maximum of ${MAX_TURNS} tool turns.` });
        break;
      }
      turns++;

      try {
        // Prune history to prevent context bloat on long sessions
        // Keep the initial system prompt (index 0) and the last 40 messages
        let prunedHistory = history;
        if (history.length > 40) {
          prunedHistory = [history[0], ...history.slice(-40)];
        }

        const response = await fetch('http://localhost:4141/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: cliConfig.llmProxy?.model || 'mistral-large-latest',
            messages: prunedHistory
          })
        });

        if (!response.ok) {
          const err = await response.text();
          appendEvent({ turnId, type: 'system', text: `System error: ${response.status} ${err}` });
          break;
        }

        const data = await response.json();
        const message = data.choices?.[0]?.message;
        if (!message) {
          appendEvent({ turnId, type: 'system', text: 'System error: LLM response did not contain a message.' });
          break;
        }

        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

        if (message.content) {
          appendEvent({ turnId, type: 'assistant', text: message.content });
        }

        history = [...history, message];
        setLlmMessages(history);

        if (toolCalls.length === 0) break;

        const malformedToolCall = toolCalls.find((toolCall: any) => {
          const name = toolCall.function?.name || toolCall.name;
          return typeof name !== 'string' || name.trim() === '';
        });

        if (malformedToolCall) {
          appendEvent({ turnId, type: 'system', text: 'System error: model returned a tool call with an empty function name.' });
          break;
        }

        for (const toolCall of toolCalls) {
          const name = toolCall.function?.name || toolCall.name;
          const rawArgs = toolCall.function?.arguments ?? toolCall.arguments ?? '{}';

          appendEvent({ turnId, type: 'tool_request', name, argsText: formatToolArgs(rawArgs) });
          const runningEventId = appendEvent({ turnId, type: 'tool_running', name });

          let resultMsg: any;
          try {
            let args: any;
            try {
              args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
            } catch (e: any) {
              throw new Error(`Invalid JSON arguments from model: ${e.message}`);
            }

            const result = await mcpClient.callTool({ name, arguments: args });
            let resultText = result.isError ? 'Error: ' : '';
            resultText += toolContentToText(result.content);

            let isFailure = Boolean(result.isError);
            if (resultText.toLowerCase().includes('enoent') || resultText.toLowerCase().includes('no such file')) {
              isFailure = true;
            }

            if (resultText.length > MAX_TOOL_CHARS) {
              resultText = smartTruncate(resultText, MAX_TOOL_CHARS);
            }

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

            resultMsg = {
              role: 'tool',
              name,
              tool_call_id: toolCall.id,
              content: resultText
            };

            replaceEvent(runningEventId, {
              id: runningEventId,
              turnId,
              type: 'tool_result',
              name,
              content: resultText,
              isError: isFailure,
              summary: isFailure ? 'Failed' : `Returned ${resultText.length} characters`
            });
          } catch (e: any) {
            const errorText = `Error: ${e.message}`;
            resultMsg = {
              role: 'tool',
              name,
              tool_call_id: toolCall.id,
              content: errorText
            };

            replaceEvent(runningEventId, {
              id: runningEventId,
              turnId,
              type: 'tool_result',
              name,
              content: errorText,
              isError: true,
              summary: 'Exception thrown'
            });
          }

          history = [...history, resultMsg];
          setLlmMessages(history);
        }
      } catch (e: any) {
        appendEvent({ turnId, type: 'system', text: `Execution error: ${e.message}` });
        break;
      }
    }
  };

  const handleSubmit = async (text: string) => {
    if (text.startsWith('/')) {
      if (text === '/exit' || text === '/quit') {
        process.exit(0);
      }

      if (text === '/clear') {
        setLlmMessages(INITIAL_LLM_MESSAGES);
        setEvents([]);
        setExpandedEventIds(new Set());
        setScrollTopLine(0);
        setIsPinnedToBottom(true);
        return;
      }

      if (text === '/config') {
        const provider = cliConfig.apiProvider || 'gemini';
        const llm = cliConfig.llmProxy || {};
        const lines = [
          `── Configuration ──`,
          `  Provider:     ${provider}`,
          `  Gemini Key:   ${maskKey(llm.geminiApiKey || llm.realApiKey)}`,
          `  Mistral Key:  ${maskKey(llm.mistralApiKey)}`,
          `  Model:        ${llm.model || '(not set)'}`,
          ``,
          `Commands:`,
          `  /config set provider gemini|mistral`,
          `  /config set gemini-key <key>`,
          `  /config set mistral-key <key>`,
          `  /config set model <name>`,
          `  /config save`,
          `  /config reload`,
        ];
        for (const line of lines) {
          appendEvent({ type: 'system', text: line });
        }
        return;
      }

      if (text.startsWith('/config set ')) {
        const setting = text.slice(12).trim();
        const spaceIdx = setting.indexOf(' ');
        if (spaceIdx === -1) {
          appendEvent({ type: 'system', text: 'Usage: /config set provider|gemini-key|mistral-key|model <value>' });
          return;
        }
        const key = setting.slice(0, spaceIdx);
        const value = setting.slice(spaceIdx + 1);

        if (key === 'provider') {
          if (value !== 'gemini' && value !== 'mistral') {
            appendEvent({ type: 'system', text: 'Provider must be "gemini" or "mistral"' });
            return;
          }
          cliConfig.apiProvider = value;
          appendEvent({ type: 'system', text: `Provider set to ${value} (restart proxy to take effect)` });
        } else if (key === 'gemini-key') {
          if (!cliConfig.llmProxy) cliConfig.llmProxy = {};
          cliConfig.llmProxy.geminiApiKey = value;
          appendEvent({ type: 'system', text: 'Gemini API key updated (restart proxy to take effect)' });
        } else if (key === 'mistral-key') {
          if (!cliConfig.llmProxy) cliConfig.llmProxy = {};
          cliConfig.llmProxy.mistralApiKey = value;
          appendEvent({ type: 'system', text: 'Mistral API key updated (restart proxy to take effect)' });
        } else if (key === 'model') {
          if (!cliConfig.llmProxy) cliConfig.llmProxy = {};
          cliConfig.llmProxy.model = value;
          appendEvent({ type: 'system', text: `Model set to ${value}` });
        } else {
          appendEvent({ type: 'system', text: `Unknown setting: ${key}` });
        }
        return;
      }

      if (text === '/config save') {
        try {
          fs.writeFileSync(configPath, JSON.stringify(cliConfig, null, 2), 'utf-8');
          appendEvent({ type: 'system', text: `Config saved to ${configPath}` });
        } catch (e: any) {
          appendEvent({ type: 'system', text: `Error saving config: ${e.message}` });
        }
        return;
      }

      if (text === '/config reload') {
        try {
          cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          appendEvent({ type: 'system', text: `Config reloaded from ${configPath}` });
        } catch (e: any) {
          appendEvent({ type: 'system', text: `Error reloading config: ${e.message}` });
        }
        return;
      }
    }

    if (isBusy) return;

    const turnId = createId();
    const userMessage = { role: 'user', content: text };
    const nextHistory = [...llmMessages, userMessage];

    setIsBusy(true);
    setIsPinnedToBottom(true);
    appendEvent({ turnId, type: 'user', text });
    setLlmMessages(nextHistory);

    await runAgenticLoop(nextHistory, turnId);
    setIsBusy(false);
  };

  return (
    <Box flexDirection="column">
      <Box height={transcriptHeight} overflow="hidden" flexDirection="column" justifyContent="flex-end">
        {visibleLines.map((line, index) => (
          <Text
            key={`${scrollTopLine}-${index}`}
            {...(line.color !== undefined ? { color: line.color } : {})}
            {...(line.bold !== undefined ? { bold: line.bold } : {})}
            {...(line.dimColor !== undefined ? { dimColor: line.dimColor } : {})}
            wrap="truncate-end"
          >
            {line.text}
          </Text>
        ))}
      </Box>

      <Box height={1} overflow="hidden">
        {isBusy ? <Text color="cyan">AI is thinking...</Text> : <InputBar onSubmit={handleSubmit} />}
      </Box>
      <StatusBar isBusy={isBusy} connected={isConnected} isPinnedToBottom={isPinnedToBottom} />
      <Box height={1} overflow="hidden">
        <Text color="dim">Lines {Math.min(scrollTopLine + 1, transcriptLines.length)}-{Math.min(scrollTopLine + transcriptHeight, transcriptLines.length)}/{transcriptLines.length}</Text>
      </Box>
    </Box>
  );
}

async function start() {
  let mcpClient: Client | null = null;
  const { waitUntilExit, rerender } = render(<App mcpClient={mcpClient} />, { alternateScreen: true });

  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['node_modules/tsx/dist/cli.mjs', 'src/proxy.ts', configPath],
      env: { ...(process.env as Record<string, string>), SILENCE_LOGS: '1' }
    });

    mcpClient = new Client({ name: 'justbetter-tui', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    await new Promise(resolve => setTimeout(resolve, 2000));
    rerender(<App mcpClient={mcpClient} />);
  } catch (e: any) {
    // Keep the TUI alive; the status bar will remain in connecting state.
  }

  await waitUntilExit();
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});

// Robust cleanup on Windows to ensure orphan processes (like node.exe spawned by npx.cmd) die
process.on('SIGINT', () => {
  if (process.platform === 'win32') {
    import('child_process').then(({ execSync }) => {
      try {
        execSync(`taskkill /F /T /PID ${process.pid}`);
      } catch (e) {
        process.exit(0);
      }
    });
  } else {
    process.exit(0);
  }
});
