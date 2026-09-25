import { configPath } from './session.js';

/** The transcript's data model: one event per thing that happened, in order. */
export const INITIAL_LLM_MESSAGES = [{ role: 'system', content: 'JUSTBETTER_CLI_AGENT' }];
export const MAX_TURNS = 20;
export const ASSISTANT_PREVIEW_LINES = 8;
export const TOOL_CONTENT_PREVIEW_LINES = 6;
export const TOOL_ARGS_PREVIEW_LINES = 3;

export type UiEventType = 'banner' | 'user' | 'assistant' | 'tool_request' | 'tool_running' | 'tool_result' | 'system';

export type UiEvent = {
  id: string;
  turnId?: string;
  type: UiEventType;
  text?: string;
  name?: string;
  argsText?: string;
  summary?: string;
  content?: string;
  isError?: boolean;
  /** Machinery rather than conversation: hidden unless /verbose is on. */
  detail?: boolean;
};

/**
 * What the transcript hides in quiet mode. Successful tool traffic is the model showing
 * its working, which is noise most of the time -- but a failure is something the user has
 * to see, so errors are never hidden.
 */
export function isDetailEvent(event: UiEvent): boolean {
  if (event.isError) return false;
  if (event.detail) return true;
  return event.type === 'tool_request' || event.type === 'tool_running' || event.type === 'tool_result';
}

export const STARTUP_EVENTS: UiEvent[] = (() => {
  const seeded: UiEvent[] = [
    // Expanded at render time, not here, so the theme decides whether it fits the terminal.
    { id: 'startup-banner', type: 'banner' },
    { id: 'startup-config', type: 'system', text: `Config: ${configPath}` },
    // Without this line the only route to /setup is /config, which you have to already
    // know to type -- so a rejected API key looked like a dead end.
    { id: 'startup-help', type: 'system', text: 'Type / for commands, or /setup to change provider, key, model or folder.' }
  ];
  return seeded;
})();

export type TranscriptLine = {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
};

export function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function formatToolArgs(rawArgs: any) {
  try {
    const value = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(rawArgs ?? '{}');
  }
}
