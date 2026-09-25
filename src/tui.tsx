import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, Static, useInput, useStdout } from 'ink';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'os';
import {
  smartTruncate, toolContentToText, pruneMessages,
  resolveProxyBase, waitForProxy, MAX_TOOL_CHARS, MAX_CONTEXT_CHARS
} from './agent-common.js';
import { packagePath } from './paths.js';
import { isPlaceholderApiKey, verifyApiKey } from './config.js';
import {
  cliConfig, configPath, proxyUrl, persistConfig, reloadConfig, saveConfig,
  configNeedsSetup, currentWorkspace, parseWorkspaceInput, maskKey,
  PROVIDER_LABEL, PROVIDER_KEY_FIELD, PROVIDER_DEFAULT_MODEL
} from './tui/session.js';
import type { Provider } from './tui/session.js';
import {
  INITIAL_LLM_MESSAGES, MAX_TURNS, STARTUP_EVENTS, createId, formatToolArgs
} from './tui/events.js';
import type { UiEvent } from './tui/events.js';
import { renderEventsToLines, renderEventLines, findLatestExpandableEventId } from './tui/render.js';
import { matchingCommands } from './tui/commands.js';
import { CommandMenu, InputBox, HintLine, WorkingLine, Lines } from './tui/components.js';
import { themeFromEnvironment } from './tui/theme.js';
import { SetupWizard } from './tui/wizard.js';

// Re-exported so tests and any other caller keep importing them from this module.
export { renderEventsToLines } from './tui/render.js';
export { matchingCommands } from './tui/commands.js';
export { SetupWizard } from './tui/wizard.js';

export function App({ mcpClient }: { mcpClient: Client | null }) {
  const [llmMessages, setLlmMessages] = useState<any[]>(INITIAL_LLM_MESSAGES);
  const [events, setEvents] = useState<UiEvent[]>(STARTUP_EVENTS);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  // How many events have been handed to <Static>. Everything below this index is the
  // terminal's now: printed once, never redrawn, and scrolled with the mouse wheel like
  // any other command output. Above it is the live turn, which still re-renders.
  const [committedCount, setCommittedCount] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [menuSelection, setMenuSelection] = useState(0);
  const [interruptedAt, setInterruptedAt] = useState(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const exitArmedRef = React.useRef<number>(0);
  const [phase, setPhase] = useState<'setup' | 'chat'>(configNeedsSetup() ? 'setup' : 'chat');
  // A first run has no working config to fall back to, so the wizard is not escapable
  // there. Reached through /setup, it is.
  const [setupIsOptional, setSetupIsOptional] = useState(false);
  // Quiet by default: the tool-by-tool trace is the model showing its working, and it
  // buries the actual answer. /verbose brings it back.
  const [verbose, setVerbose] = useState(false);
  const [draft, setDraft] = useState('');
  const [activity, setActivity] = useState<string | null>(null);
  const { stdout } = useStdout();

  const terminalColumns = stdout.columns || 80;
  const theme = useMemo(() => themeFromEnvironment(terminalColumns), [terminalColumns]);
  const suggestions = useMemo(() => matchingCommands(draft), [draft]);

  const committedEvents = events.slice(0, committedCount);
  const liveEvents = events.slice(committedCount);
  const liveLines = useMemo(
    () => renderEventsToLines(liveEvents, terminalColumns, expandedEventIds, verbose, theme, false),
    [liveEvents, terminalColumns, expandedEventIds, verbose, theme]
  );

  // The live region is capped because ink repaints all of it on every state change, and a
  // tall repainting region under a ticking spinner is exactly what makes a TUI flicker.
  const LIVE_LINE_CAP = 8;
  const visibleLiveLines = liveLines.slice(-LIVE_LINE_CAP);

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

  const cancelSetup = () => {
    setPhase('chat');
    appendEvent({ type: 'system', text: 'Setup cancelled. Nothing changed.' });
  };

  useInput((input, key) => {
    // Esc aborts the turn in flight. The transcript keeps whatever already happened --
    // an interrupted run that erased its own output would be worse than no interrupt.
    if (key.escape) {
      if (isBusy && abortRef.current) {
        abortRef.current.abort();
        setInterruptedAt(Date.now());
      }
      return;
    }

    if (key.ctrl && input === 'c') {
      // Two presses within two seconds, so a stray Ctrl+C cannot end the session.
      const now = Date.now();
      if (now - exitArmedRef.current < 2000) process.exit(0);
      exitArmedRef.current = now;
      appendEvent({ type: 'system', text: 'Press Ctrl+C again to exit, or type /exit.' });
      return;
    }

    if (suggestions.length > 0) {
      if (key.upArrow) { setMenuSelection(i => (i + suggestions.length - 1) % suggestions.length); return; }
      if (key.downArrow) { setMenuSelection(i => (i + 1) % suggestions.length); return; }
      if (key.tab) {
        const chosen = suggestions[menuSelection] ?? suggestions[0];
        if (chosen) setDraft(chosen.name + ' ');
        return;
      }
    }

    // Recalling a previous line only makes sense when there is nothing half-typed to lose.
    if (draft === '' && key.upArrow && history.length > 0) {
      const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setDraft(history[nextIndex] ?? '');
      return;
    }

    if (historyIndex !== null && key.downArrow) {
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(null);
        setDraft('');
      } else {
        setHistoryIndex(nextIndex);
        setDraft(history[nextIndex] ?? '');
      }
      return;
    }

    // Expansion applies to the live turn only. Anything already committed to <Static>
    // belongs to the terminal and cannot be re-rendered; /verbose is the lever for that.
    if (key.ctrl && input === 'x') {
      const latestExpandable = findLatestExpandableEventId(liveEvents);
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

  // Menu selection must not point past the end when the filter narrows.
  useEffect(() => {
    setMenuSelection(selection => (selection < suggestions.length ? selection : 0));
  }, [suggestions.length]);

  /**
   * Hands everything from the finished turn to <Static>.
   *
   * Commits only while idle, and only whole turns. Committing an event as it arrived would
   * print a tool result before the call it belongs to whenever a slow result landed after
   * the next event, and nothing printed can be reordered afterwards.
   */
  useEffect(() => {
    if (isBusy) return;
    setCommittedCount(count => (events.length > count ? events.length : count));
  }, [isBusy, events.length]);

  const runAgenticLoop = async (initialHistory: any[], turnId: string, signal?: AbortSignal) => {
    let history = [...initialHistory];
    let turns = 0;
    let requestToolsMisses = 0;

    while (mcpClient) {
      if (signal?.aborted) {
        appendEvent({ turnId, type: 'system', text: 'Interrupted.' });
        break;
      }
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
          }),
          // Without this, Esc during a slow model call would only take effect once the
          // response had already arrived, which does not read as an interrupt.
          ...(signal ? { signal } : {})
        });

        if (!response.ok) {
          const err = await response.text();
          // The proxy passes the provider's status straight through, so a rejected key
          // arrives here as a bare 401. Saying which key and how to replace it is the
          // difference between a fixable mistake and a dead end.
          const isAuthFailure = response.status === 401 || response.status === 403;
          if (isAuthFailure) {
            const provider = cliConfig.apiProvider || 'gemini';
            appendEvent({ turnId, type: 'system', isError: true, text:
              `Your ${provider} API key was rejected (HTTP ${response.status}).` });
            appendEvent({ turnId, type: 'system', text:
              `Type /setup to enter a new one, or /config set ${provider}-key <key>.` });
          } else {
            appendEvent({ turnId, type: 'system', text: `System error: ${response.status} ${err}` });
          }
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
          appendEvent({ turnId, type: 'system', detail: true, text: `[Gateway] Auto-injected ${injectedCount} tools: ${injectedTools}` });
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
          if (signal?.aborted) break;
          const name = toolCall.function?.name || toolCall.name;
          const rawArgs = toolCall.function?.arguments ?? toolCall.arguments ?? '{}';

          appendEvent({ turnId, type: 'tool_request', name, argsText: formatToolArgs(rawArgs) });
          const runningEventId = appendEvent({ turnId, type: 'tool_running', name });
          setActivity(name);

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

          setActivity(null);
          history = [...history, resultMsg];
          setLlmMessages(history);
        }
      } catch (e: any) {
        // AbortError is the user pressing Esc, which has already been reported.
        if (e?.name === 'AbortError' || signal?.aborted) {
          appendEvent({ turnId, type: 'system', text: 'Interrupted.' });
          break;
        }
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
        setSetupIsOptional(!configNeedsSetup());
        setPhase('setup');
        return;
      }

      if (text === '/verbose') {
        const next = !verbose;
        setVerbose(next);
        appendEvent({ type: 'system', text: next
          ? 'Verbose on: showing every tool call and its output.'
          : 'Verbose off: tool activity is hidden. Failures are always shown.' });
        return;
      }

      if (text === '/help' || text === '/?') {
        const lines = [
          `── Commands ──`,
          `  /setup      change provider, API key, model or folder`,
          `  /config     show the current settings and how to change one`,
          `  /verbose    show or hide tool activity (currently ${verbose ? 'on' : 'off'})`,
          `  /clear      clear the transcript`,
          `  /help       this list`,
          `  /exit       quit`,
          ``,
          ``,
          `Keys: Esc interrupts a running turn. Up/Down recalls what you typed.`,
          `      Ctrl+X expands the current tool output. Ctrl+C twice exits.`,
          `      Scroll with the mouse wheel -- finished output is ordinary terminal scrollback.`,
        ];
        for (const line of lines) appendEvent({ type: 'system', text: line });
        return;
      }

      if (text === '/clear') {
        setLlmMessages(INITIAL_LLM_MESSAGES);
        setEvents([]);
        setExpandedEventIds(new Set());
        // Nothing already printed can be unprinted -- it is the terminal's scrollback now.
        // Clearing resets the model's history and the live region, which is what /clear is for.
        setCommittedCount(0);
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
          `  Folders:      ${currentWorkspace().join(', ')}`,
          ``,
          `Commands:`,
          `  /setup                              re-run the guided setup`,
          `  /config set provider gemini|mistral`,
          `  /config set gemini-key <key>`,
          `  /config set mistral-key <key>`,
          `  /config set model <name>`,
          `  /config set workspace <dir>[,<dir>] folders the agent may read and write`,
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
          appendEvent({ type: 'system', text: 'Usage: /config set provider|gemini-key|mistral-key|model|workspace <value>' });
          return;
        }
        const key = setting.slice(0, spaceIdx);
        const value = setting.slice(spaceIdx + 1).trim();

        if (!cliConfig.llmProxy) {
          cliConfig.llmProxy = { enabled: true, port: 4141, host: '127.0.0.1' };
        }

        if (key === 'provider') {
          if (value !== 'gemini' && value !== 'mistral') {
            appendEvent({ type: 'system', text: 'Provider must be "gemini" or "mistral"' });
            return;
          }
          cliConfig.apiProvider = value;
          // The model belongs to the provider. Leaving the old one behind is exactly how
          // a Mistral model name ended up being sent to Gemini.
          cliConfig.llmProxy.model = PROVIDER_DEFAULT_MODEL[value as Provider];
          appendEvent({ type: 'system', text: `Model set to ${cliConfig.llmProxy.model} to match ${value}.` });
          if (isPlaceholderApiKey(cliConfig)) {
            appendEvent({ type: 'system', text: `No ${value} API key yet. Type /setup, or /config set ${value}-key <key>.` });
          }
        } else if (key === 'gemini-key' || key === 'mistral-key') {
          const provider: Provider = key === 'gemini-key' ? 'gemini' : 'mistral';
          appendEvent({ type: 'system', text: `Checking the key with ${PROVIDER_LABEL[provider]}...` });
          const check = await verifyApiKey(provider, value);
          if (check.status === 'rejected') {
            appendEvent({ type: 'system', isError: true, text: `${check.message} The key was not saved.` });
            return;
          }
          if (check.status === 'unknown') {
            appendEvent({ type: 'system', text: `${check.message} Saving it unverified.` });
          }
          cliConfig.llmProxy[PROVIDER_KEY_FIELD[provider]] = value;
        } else if (key === 'model') {
          cliConfig.llmProxy.model = value;
        } else if (key === 'workspace') {
          const parsed = parseWorkspaceInput(value);
          if ('error' in parsed) {
            appendEvent({ type: 'system', isError: true, text: parsed.error });
            return;
          }
          cliConfig.allowedDirectories = parsed.dirs;
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
          saveConfig();
          appendEvent({ type: 'system', text: `Config saved to ${configPath}` });
        } catch (e: any) {
          appendEvent({ type: 'system', text: `Error saving config: ${e.message}` });
        }
        return;
      }

      if (text === '/config reload') {
        try {
          reloadConfig();
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

    setHistory(prev => (prev[prev.length - 1] === text ? prev : [...prev, text]));
    setHistoryIndex(null);
    setIsBusy(true);
    setInterruptedAt(0);
    const controller = new AbortController();
    abortRef.current = controller;
    appendEvent({ turnId, type: 'user', text });
    setLlmMessages(nextHistory);

    await runAgenticLoop(nextHistory, turnId, controller.signal);
    abortRef.current = null;
    setActivity(null);
    setIsBusy(false);
  };

  const provider = cliConfig.apiProvider || 'gemini';
  const model = cliConfig.llmProxy?.model || '(no model)';
  const hints = [
    model,
    isConnected ? 'gateway ready' : 'connecting…',
    '/ for commands',
    verbose ? 'verbose on' : 'ctrl+x expand',
    'ctrl+c twice to exit'
  ];

  return (
    <Box flexDirection="column">
      {/*
        Committed history. Ink prints each item once and then forgets it, so the lines
        become ordinary terminal output: the mouse wheel scrolls them, the terminal keeps
        the scrollback, and text can be selected and copied. Keyed on the event id -- an
        index key would reprint the whole transcript whenever the array shifted.
      */}
      <Static items={committedEvents}>
        {(event: UiEvent) => (
          <Box key={event.id} flexDirection="column">
            <Lines lines={renderEventLines(event, terminalColumns, expandedEventIds.has(event.id), verbose, theme)} />
          </Box>
        )}
      </Static>

      {/*
        The wizard is a state of the live region, never a replacement for the whole tree.
        Returning <SetupWizard /> instead unmounted <Static>, and ink re-prints every Static
        item when it remounts -- so leaving setup duplicated the entire transcript.
      */}
      {phase === 'setup' ? (
        <SetupWizard onComplete={finishSetup} {...(setupIsOptional ? { onCancel: cancelSetup } : {})} />
      ) : (
        <>
          {visibleLiveLines.length > 0 ? (
            <Box flexDirection="column">
              <Lines lines={visibleLiveLines} />
            </Box>
          ) : null}

          {isBusy
            ? <WorkingLine theme={theme} activity={activity} interrupting={interruptedAt > 0} />
            : <InputBox theme={theme} value={draft} onChange={setDraft} onSubmit={handleSubmit} />}

          <CommandMenu theme={theme} suggestions={suggestions} selected={menuSelection} />
          <HintLine theme={theme} items={hints} />
        </>
      )}
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
      // Not the package root: a live process sitting in the install directory is what
      // makes `npm install -g` fail with EBUSY on Windows. Every path passed above is
      // absolute, so there is nothing here that needs a meaningful cwd.
      cwd: os.tmpdir(),
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
  // NOT the alternate screen. That buffer has no scrollback by definition, so committing the
  // transcript to <Static> there produced output nobody could scroll back to -- the mouse
  // wheel did nothing. Rendering in the normal buffer is what makes finished turns behave
  // like ordinary command output: wheel-scrollable, selectable, copyable.
  //
  // Scroll the prompt to the bottom of the screen first. Ink keeps its live region wherever
  // the cursor started and writes committed output above it, so without this the prompt
  // opens near the top and creeps downward as the transcript grows. One screen of newlines
  // puts it on the last row immediately, and from then on the terminal scrolls the
  // transcript up behind it and the prompt stays put.
  const rows = process.stdout.rows || 24;
  process.stdout.write(String.fromCharCode(10).repeat(Math.max(0, rows - 1)));

  const { waitUntilExit, rerender } = render(<App mcpClient={gatewayClient} />);
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
