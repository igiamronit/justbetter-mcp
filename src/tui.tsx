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
const MAX_TURNS = 10;
const MAX_TOOL_CHARS = 15000;
const ASSISTANT_PREVIEW_LINES = 8;
const TOOL_CONTENT_PREVIEW_LINES = 6;
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
      lines.push({ text: `${label} > ${event.name} - ${event.summary || 'Completed'}`, color, bold: event.isError });

      if (event.content && (event.isError || expanded)) {
        const resultLines = wrapText(event.content, columns).map(text => ({ text, color: event.isError ? 'red' : undefined, dimColor: true }));
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

    while (mcpClient) {
      if (turns >= MAX_TURNS) {
        appendEvent({ turnId, type: 'system', text: `System: reached the maximum of ${MAX_TURNS} tool turns.` });
        break;
      }
      turns++;

      try {
        const response = await fetch('http://localhost:4141/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: cliConfig.llmProxy?.model || 'gemini-1.5-flash',
            messages: history,
            tools: []
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
              resultText = `${resultText.substring(0, MAX_TOOL_CHARS)}\n\n...[TRUNCATED]...`;
            }

            if (isFailure) {
              resultText = `[TOOL EXECUTION FAILED]\n${resultText}\n\n[SYSTEM DIRECTIVE]: The tool failed. You MUST use 'search_files', 'directory_tree', or 'request_tools' to find the correct path or alternative solution and try again.`;
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
            color={line.color}
            bold={line.bold}
            dimColor={line.dimColor}
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
