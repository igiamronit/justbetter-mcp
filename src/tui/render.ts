import type { UiEvent, TranscriptLine } from './events.js';
import {
  isDetailEvent, ASSISTANT_PREVIEW_LINES, TOOL_CONTENT_PREVIEW_LINES, TOOL_ARGS_PREVIEW_LINES
} from './events.js';
import { resolveTheme, style } from './theme.js';
import { bannerLines } from './banner.js';
import type { Theme } from './theme.js';

/** Turns the event list into styled terminal lines. Pure, so the tests drive it directly. */

export function wrapText(text: any, columns: number) {
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

export function prefixedLines(prefix: string, text: any, columns: number, line: Omit<TranscriptLine, 'text'> = {}) {
  const firstWidth = Math.max(20, columns - prefix.length);
  const continuation = ' '.repeat(prefix.length);
  const wrapped = wrapText(text, firstWidth);

  if (wrapped.length === 0) return [{ ...line, text: prefix }];

  return wrapped.map((wrappedLine, index) => ({
    ...line,
    text: `${index === 0 ? prefix : continuation}${wrappedLine}`
  }));
}

export function limitLines(
  lines: TranscriptLine[],
  maxLines: number,
  expanded: boolean,
  marker: string,
  theme: Theme
) {
  if (expanded || lines.length <= maxLines) return lines;
  const hidden = lines.length - maxLines;
  return [
    ...lines.slice(0, maxLines),
    { text: `  ${marker} +${hidden} more lines (ctrl+x)`, ...style(theme, 'secondary') }
  ];
}

/**
 * A one-line summary of a tool call's arguments.
 *
 * Claude Code shows `Read(hello.py)` rather than a pretty-printed JSON block, and that is
 * most of why its transcript stays readable: the argument that identifies the call is
 * almost always a single short string. Falls back to the key names when nothing looks like
 * a headline value, which is still shorter than the whole object.
 */
export function summariseArgs(argsText: string | undefined, width: number): string {
  if (!argsText) return '';
  let parsed: any;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    return truncateInline(argsText.replace(/\s+/g, ' ').trim(), width);
  }
  if (!parsed || typeof parsed !== 'object') return truncateInline(String(parsed), width);

  const entries = Object.entries(parsed);
  if (entries.length === 0) return '';

  // Prefer whichever value reads as the subject of the call.
  const preferred = ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'name'];
  for (const key of preferred) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return truncateInline(value.trim(), width);
  }

  const firstString = entries.find(([, value]) => typeof value === 'string' && value.trim());
  if (firstString) return truncateInline(String(firstString[1]).trim(), width);

  return truncateInline(entries.map(([key]) => key).join(', '), width);
}

function truncateInline(text: string, width: number): string {
  const limit = Math.max(8, width);
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

/**
 * One event's lines. Returns empty for an event quiet mode hides.
 *
 * Split out because the transcript is committed to ink's <Static> one event at a time:
 * Static renders each item once and never again, so the renderer has to be addressable per
 * event rather than only over the whole list.
 */
export function renderEventLines(
  event: UiEvent,
  columns: number,
  expanded: boolean,
  verbose: boolean,
  theme: Theme = resolveTheme({ columns })
): TranscriptLine[] {
  return renderEventsToLines([event], columns, expanded ? new Set([event.id]) : new Set(), verbose, theme, false);
}

export function renderEventsToLines(
  events: UiEvent[],
  columns: number,
  expandedEventIds: Set<string>,
  verbose: boolean,
  theme: Theme = resolveTheme({ columns }),
  withPlaceholder: boolean = true
) {
  const lines: TranscriptLine[] = [];
  const { bullet, branch, prompt, fail } = theme.glyph;
  const conversation = style(theme, 'conversation');
  const accent = style(theme, 'accent');
  const secondary = style(theme, 'secondary');
  const failure = style(theme, 'failure');

  for (const event of events) {
    if (!verbose && isDetailEvent(event)) continue;
    const expanded = expandedEventIds.has(event.id);

    if (event.type === 'banner') {
      const art = bannerLines(theme);
      if (art.length > 0) {
        for (const line of art) lines.push({ text: line, ...accent });
      } else {
        // Too narrow for the wordmark: a plain title beats something that wraps into noise.
        lines.push({ text: ` ${bullet} justbetter-mcp`, ...accent });
      }
      lines.push({ text: '' });
      continue;
    }

    if (event.type === 'user') {
      lines.push({ text: '' });
      // The user's own words stay unstyled. Only the marker is coloured, so a glance down
      // the left edge tells you who said what without reading any of it.
      lines.push(...prefixedLines(`${prompt} `, event.text, columns, conversation));
      continue;
    }

    if (event.type === 'assistant') {
      lines.push({ text: '' });
      const bodyLines = wrapText(event.text, Math.max(20, columns - 2));
      const headline = bodyLines.length > 0 ? bodyLines[0] : '';
      lines.push({ text: `${bullet} ${headline}`, ...conversation });
      const rest = bodyLines.slice(1).map(text => ({ text: `  ${text}`, ...conversation }));
      lines.push(...limitLines(rest, ASSISTANT_PREVIEW_LINES, expanded, branch, theme));
      continue;
    }

    if (event.type === 'tool_request') {
      const summary = summariseArgs(event.argsText, Math.max(12, columns - (event.name?.length ?? 0) - 6));
      lines.push({ text: `${bullet} ${event.name}(${summary})`, ...accent });
      if (expanded && event.argsText) {
        const argLines = wrapText(event.argsText, Math.max(20, columns - 4)).map(text => ({ text: `    ${text}`, ...secondary }));
        lines.push(...limitLines(argLines, TOOL_ARGS_PREVIEW_LINES, expanded, branch, theme));
      }
      continue;
    }

    if (event.type === 'tool_running') {
      lines.push({ text: `${bullet} ${event.name}…`, ...accent });
      continue;
    }

    if (event.type === 'tool_result') {
      const marker = event.isError ? fail : branch;
      const label = event.summary || (event.isError ? 'Failed' : 'Done');
      // A failure names its tool; a success does not. In quiet mode the call line above is
      // hidden, so an unnamed failure would read as `x Failed` with nothing to act on.
      const heading = event.isError ? `${event.name} — ${label}` : label;
      lines.push({ text: `  ${marker} ${heading}`, ...(event.isError ? failure : secondary) });

      if (event.content && (event.isError || expanded)) {
        const resultLines: TranscriptLine[] = wrapText(event.content, Math.max(20, columns - 4))
          .map(text => ({ text: `    ${text}`, ...(event.isError ? failure : secondary) }));
        lines.push(...limitLines(resultLines, TOOL_CONTENT_PREVIEW_LINES, expanded, branch, theme));
      }
      continue;
    }

    if (event.type === 'system') {
      lines.push({ text: event.text || '', ...(event.isError ? failure : secondary) });
    }
  }

  if (lines.length > 0) return lines;
  return withPlaceholder ? [{ text: 'Type a message, or / for commands.', ...secondary }] : [];
}

export function findLatestExpandableEventId(events: UiEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if ((event.type === 'assistant' && event.text) || (event.type === 'tool_result' && event.content) || event.type === 'tool_request') {
      return event.id;
    }
  }
  return null;
}
