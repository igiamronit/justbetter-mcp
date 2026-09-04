import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import {
  smartTruncate, toolContentToText, pruneMessages, resolveProxyUrl,
  resolveProxyBase, waitForProxy, MAX_TOOL_CHARS, MAX_CONTEXT_CHARS
} from './agent-common.js';
import { PACKAGE_ROOT, packagePath, resolveConfigPath } from './paths.js';
import { isPlaceholderApiKey } from './config.js';

const configPath = resolveConfigPath(process.argv[2]);
let cliConfig: any = {};
try {
  cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e: any) {
  // The proxy will surface config errors if they matter at runtime.
}

/** Recomputed on demand: the setup wizard can change proxy settings at runtime. */
const proxyUrl = () => resolveProxyUrl(cliConfig);

const PROVIDERS = ['gemini', 'mistral'] as const;
type Provider = (typeof PROVIDERS)[number];

const PROVIDER_LABEL: Record<Provider, string> = {
  gemini: 'Google Gemini',
  mistral: 'Mistral',
};

const PROVIDER_KEY_FIELD: Record<Provider, string> = {
  gemini: 'geminiApiKey',
  mistral: 'mistralApiKey',
};

const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-large-latest',
};

const PROVIDER_KEY_URL: Record<Provider, string> = {
  gemini: 'aistudio.google.com/apikey',
  mistral: 'console.mistral.ai/api-keys',
};

/** True when the config cannot drive a chat turn yet, so the wizard runs first. */
function configNeedsSetup(): boolean {
  return !cliConfig.llmProxy || isPlaceholderApiKey(cliConfig);
}

/** Writes cliConfig back to disk. Returns an error message, or null on success. */
function persistConfig(): string | null {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cliConfig, null, 2), 'utf-8');
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

const INITIAL_LLM_MESSAGES = [{ role: 'system', content: 'JUSTBETTER_CLI_AGENT' }];
const MAX_TURNS = 20;
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

const STARTUP_EVENTS: UiEvent[] = (() => {
  const seeded: UiEvent[] = [
    { id: 'startup-config', type: 'system', text: `Config: ${configPath}` }
  ];
  return seeded;
})();

type TranscriptLine = {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
};

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

/**
 * First-run configuration. Runs before the gateway is booted, because starting the
 * LLM proxy against a placeholder key just produces an "invalid API key" error from
 * the provider with no indication of which file to edit.
 */
export function SetupWizard({ onComplete }: { onComplete: (summary: string[]) => void }) {
  const configured = String(cliConfig.apiProvider ?? '');
  const initialProvider: Provider =
    (PROVIDERS as readonly string[]).includes(configured) ? (configured as Provider) : 'gemini';

  const [step, setStep] = useState<'provider' | 'key' | 'model'>('provider');
  const [cursor, setCursor] = useState(Math.max(0, PROVIDERS.indexOf(initialProvider)));
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [keyValue, setKeyValue] = useState('');
  const [modelValue, setModelValue] = useState('');
  const [error, setError] = useState('');

  useInput((input, key) => {
    if (key.upArrow) { setCursor(c => (c + PROVIDERS.length - 1) % PROVIDERS.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % PROVIDERS.length); return; }
    const typed = Number(input);
    if (typed >= 1 && typed <= PROVIDERS.length) { setCursor(typed - 1); return; }
    if (key.return) {
      const chosen = PROVIDERS[cursor] as Provider;
      const existingKey = cliConfig.llmProxy?.[PROVIDER_KEY_FIELD[chosen]];
      const keptProvider = chosen === cliConfig.apiProvider;
      setProvider(chosen);
      // Carry a real key over so re-running setup is not a retype; skip placeholders.
      setKeyValue(existingKey && !/^YOUR-/i.test(existingKey) ? existingKey : '');
      // Only reuse the configured model when the provider is unchanged. Carrying it
      // across a switch is exactly how a Mistral model name ended up under Gemini.
      setModelValue((keptProvider && cliConfig.llmProxy?.model) || PROVIDER_DEFAULT_MODEL[chosen]);
      setStep('key');
    }
  }, { isActive: step === 'provider' });

  const submitKey = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || /^YOUR-/i.test(trimmed)) {
      setError('A real API key is required. Paste one to continue.');
      return;
    }
    setError('');
    setKeyValue(trimmed);
    setStep('model');
  };

  const submitModel = (value: string) => {
    const model = value.trim() || PROVIDER_DEFAULT_MODEL[provider];
    if (!cliConfig.llmProxy) {
      cliConfig.llmProxy = { enabled: true, port: 4141, host: '127.0.0.1' };
    }
    cliConfig.apiProvider = provider;
    cliConfig.llmProxy[PROVIDER_KEY_FIELD[provider]] = keyValue;
    cliConfig.llmProxy.model = model;

    const err = persistConfig();
    onComplete(err
      ? [`Could not save config: ${err}`]
      : [`Provider: ${PROVIDER_LABEL[provider]}`, `Model: ${model}`, `Saved to ${configPath}`]);
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>JustBetter setup</Text>
      <Text dimColor>{configPath}</Text>
      <Box height={1} />

      {step === 'provider' ? (
        <Box flexDirection="column">
          <Text>Which API provider should power the chat?</Text>
          <Box height={1} />
          {PROVIDERS.map((option, index) => (
            <Text key={option} {...(index === cursor ? { color: 'green' } : {})}>
              {index === cursor ? '>' : ' '} {index + 1}. {PROVIDER_LABEL[option]}
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Up/Down or a number to choose, Enter to confirm.</Text>
        </Box>
      ) : null}

      {step === 'key' ? (
        <Box flexDirection="column">
          <Text>Paste your {PROVIDER_LABEL[provider]} API key.</Text>
          <Text dimColor>Get one at {PROVIDER_KEY_URL[provider]}</Text>
          <Box height={1} />
          <Box>
            <Text color="blue" bold>Key {'>'} </Text>
            <TextInput
              value={keyValue}
              onChange={value => { setKeyValue(value); if (error) setError(''); }}
              onSubmit={submitKey}
              mask="*"
            />
          </Box>
          {error ? <Text color="red">{error}</Text> : null}
        </Box>
      ) : null}

      {step === 'model' ? (
        <Box flexDirection="column">
          <Text>Which model? Enter accepts the default.</Text>
          <Box height={1} />
          <Box>
            <Text color="blue" bold>Model {'>'} </Text>
            <TextInput value={modelValue} onChange={setModelValue} onSubmit={submitModel} />
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function App({ mcpClient }: { mcpClient: Client | null }) {
  const [llmMessages, setLlmMessages] = useState<any[]>(INITIAL_LLM_MESSAGES);
  const [events, setEvents] = useState<UiEvent[]>(STARTUP_EVENTS);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [scrollTopLine, setScrollTopLine] = useState(0);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [phase, setPhase] = useState<'setup' | 'chat'>(configNeedsSetup() ? 'setup' : 'chat');
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

  const restartGateway = (reason: string) => {
    appendEvent({ type: 'system', text: reason });
    void bootGateway().then(err => {
      appendEvent(err
        ? { type: 'system', isError: true, text: `Gateway failed to start: ${err}` }
        : { type: 'system', text: 'Gateway ready.' });
    });
  };

  const finishSetup = (summary: string[]) => {
    for (const line of summary) appendEvent({ type: 'system', text: line });
    setPhase('chat');
    restartGateway('Starting gateway...');
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
  }, { isActive: phase === 'chat' });

  useEffect(() => {
    setIsConnected(Boolean(mcpClient));
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
        // Prune history to prevent context bloat on long sessions. Slicing the last N
        // messages could orphan a `role: "tool"` reply from the assistant turn that
        // requested it, which the chat-completions API rejects; pruneMessages drops
        // whole assistant+tool groups instead.
        const prunedHistory = pruneMessages(history, MAX_CONTEXT_CHARS);

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (cliConfig.llmProxy?.authToken) {
          headers['X-JustBetter-Token'] = cliConfig.llmProxy.authToken;
        }

        const response = await fetch(proxyUrl(), {
          method: 'POST',
          headers,
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

        const injectedCount = response.headers.get('X-JustBetter-Injected-Count');
        const injectedTools = response.headers.get('X-JustBetter-Injected-Tools');
        if (turns === 1 && injectedCount) {
          appendEvent({ turnId, type: 'system', text: `[Gateway] Auto-injected ${injectedCount} tools: ${injectedTools}` });
        }

        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

        if (!message.content && toolCalls.length === 0) {
          message.content = "[Empty response]";
        }

        if (message.content && message.content !== "[Empty response]") {
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

      if (text === '/setup') {
        setPhase('setup');
        return;
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
          `  /setup                              re-run the guided setup`,
          `  /config set provider gemini|mistral`,
          `  /config set gemini-key <key>`,
          `  /config set mistral-key <key>`,
          `  /config set model <name>`,
          `  /config reload                      discard edits, re-read file`,
          ``,
          `Changes are saved and applied immediately.`,
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

        if (key === 'provider' && value !== 'gemini' && value !== 'mistral') {
          appendEvent({ type: 'system', text: 'Provider must be "gemini" or "mistral"' });
          return;
        }

        if (key !== 'provider' && !cliConfig.llmProxy) {
          cliConfig.llmProxy = { enabled: true, port: 4141, host: '127.0.0.1' };
        }

        if (key === 'provider') {
          cliConfig.apiProvider = value;
        } else if (key === 'gemini-key') {
          cliConfig.llmProxy.geminiApiKey = value;
        } else if (key === 'mistral-key') {
          cliConfig.llmProxy.mistralApiKey = value;
        } else if (key === 'model') {
          cliConfig.llmProxy.model = value;
        } else {
          appendEvent({ type: 'system', text: `Unknown setting: ${key}` });
          return;
        }

        // Saving and restarting here is the point: a setting that needs two further
        // commands to take effect is how someone ends up staring at a stale API key.
        const saveError = persistConfig();
        if (saveError) {
          appendEvent({ type: 'system', isError: true, text: `Could not save config: ${saveError}` });
          return;
        }
        appendEvent({ type: 'system', text: `${key} updated and saved to ${configPath}` });
        restartGateway('Restarting gateway to apply...');
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

  if (phase === 'setup') {
    return <SetupWizard onComplete={finishSetup} />;
  }

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

let gatewayClient: Client | null = null;
let rerenderApp: () => void = () => {};

/**
 * Starts, or restarts, the gateway child process and waits for its LLM proxy.
 * Restarting is what lets a change made in the TUI take effect without quitting:
 * the proxy reads its provider, key and model once, at boot.
 * Returns an error message, or null on success.
 */
export async function bootGateway(): Promise<string | null> {
  if (gatewayClient) {
    try { await gatewayClient.close(); } catch { /* child already gone */ }
    gatewayClient = null;
    rerenderApp();
  }

  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      // Go through bin/cli.js rather than invoking tsx directly: it is the single
      // place that knows how to locate the tsx runtime across hoisted and nested
      // node_modules layouts.
      args: [packagePath('bin', 'cli.js'), 'gateway', configPath],
      cwd: PACKAGE_ROOT,
      env: { ...(process.env as Record<string, string>), SILENCE_LOGS: '1' }
    });

    const client = new Client({ name: 'justbetter-tui', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    await waitForProxy(resolveProxyBase(cliConfig));
    gatewayClient = client;
    rerenderApp();
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

async function start() {
  const { waitUntilExit, rerender } = render(<App mcpClient={gatewayClient} />, { alternateScreen: true });
  rerenderApp = () => rerender(<App mcpClient={gatewayClient} />);

  // A config that cannot chat yet goes to the wizard first. Booting now would start
  // the LLM proxy against a placeholder key and fail with a provider-side error.
  if (!configNeedsSetup()) {
    await bootGateway();
  }

  await waitUntilExit();
}

// Importing this module for a test should not take over the terminal. Anything
// other than the opt-out runs the TUI exactly as before.
if (process.env.JUSTBETTER_TUI_NO_AUTOSTART !== '1') {
  start().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

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
