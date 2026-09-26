import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { COMMANDS } from './commands.js';
import type { Theme } from './theme.js';
import { isNarrow, style } from './theme.js';
import type { TranscriptLine } from './events.js';

/** Renders pre-styled transcript lines. One place decides how a line becomes ink. */
export function Lines({ lines }: { lines: TranscriptLine[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <Text
          key={index}
          {...(line.color !== undefined ? { color: line.color } : {})}
          {...(line.bold !== undefined ? { bold: line.bold } : {})}
          {...(line.dimColor !== undefined ? { dimColor: line.dimColor } : {})}
          wrap="truncate-end"
        >
          {line.text.length > 0 ? line.text : ' '}
        </Text>
      ))}
    </>
  );
}

/**
 * The input prompt. Bordered on anything wide enough for a border to fit; a bare prompt
 * below that, because a box plus its padding eats the room the text needs.
 */
export function InputBox({ theme, value, onChange, onSubmit }: {
  theme: Theme;
  value: string;
  onChange: (text: string) => void;
  onSubmit: (text: string) => void;
}) {
  const accent = style(theme, 'accent');
  const handleSubmit = (submitted: string) => {
    const text = submitted.trim();
    if (!text) return;
    // Cleared before submitting, not after: the handler may put a completed command back
    // in the field, and clearing afterwards would wipe it out again.
    onChange('');
    onSubmit(text);
  };

  const field = (
    <>
      <Text {...accent}>{theme.glyph.prompt} </Text>
      <TextInput value={value} onChange={onChange} onSubmit={handleSubmit} />
    </>
  );

  if (isNarrow(theme) || !theme.unicode) {
    return <Box height={1} overflow="hidden">{field}</Box>;
  }

  return (
    <Box
      borderStyle="round"
      {...(theme.color ? { borderColor: 'cyan' } : {})}
      paddingX={1}
      width={theme.columns}
    >
      {field}
    </Box>
  );
}

/**
 * The one dim line under the input. Sheds items from the right as the terminal narrows,
 * least important first, rather than being truncated mid-word by the terminal.
 */
export function HintLine({ theme, items }: { theme: Theme; items: string[] }) {
  const secondary = style(theme, 'secondary');
  const separator = ' · ';
  const kept: string[] = [];
  let width = 0;
  for (const item of items) {
    const next = width + item.length + (kept.length > 0 ? separator.length : 0);
    if (next > theme.columns - 2) break;
    kept.push(item);
    width = next;
  }
  return (
    <Box height={1} overflow="hidden">
      <Text {...secondary}>{kept.join(separator)}</Text>
    </Box>
  );
}

/**
 * Replaces the input while a turn runs: spinner, what it is doing, how long it has taken,
 * and how to stop it.
 *
 * The clock ticks once a second rather than with the spinner frames. Ink repaints the whole
 * dynamic region on every state change, so a 10Hz state update here is what makes a TUI
 * flicker; the spinner animates inside its own component and does not touch this state.
 */
export function WorkingLine({ theme, activity, interrupting, onElapsed }: {
  theme: Theme;
  activity: string | null;
  /** Esc has been pressed; the loop exits at its next checkpoint. */
  interrupting?: boolean;
  onElapsed?: (seconds: number) => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const accent = style(theme, 'accent');
  const secondary = style(theme, 'secondary');

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      const next = Math.floor((Date.now() - started) / 1000);
      setSeconds(next);
      onElapsed?.(next);
    }, 1000);
    return () => clearInterval(timer);
    // Deliberately started once: this component mounts when a turn begins and unmounts
    // when it ends, so the elapsed clock is the turn's own.
  }, []);

  return (
    <Box height={1} overflow="hidden">
      <Text {...accent}><Spinner type="dots" /></Text>
      <Text {...accent}>{` ${interrupting ? 'Interrupting' : activity ? 'Running ' + activity : 'Thinking'}`}</Text>
      <Text {...secondary}>{` (${seconds}s${interrupting ? '' : ' · esc to interrupt'})`}</Text>
    </Box>
  );
}

/** Slash-command suggestions, with the selected row marked. */
export function CommandMenu({ theme, suggestions, selected }: {
  theme: Theme;
  suggestions: typeof COMMANDS;
  selected: number;
}) {
  if (suggestions.length === 0) return null;
  const accent = style(theme, 'accent');
  const secondary = style(theme, 'secondary');
  const width = Math.max(...suggestions.map(command => command.name.length));
  return (
    <Box flexDirection="column">
      {suggestions.map((command, index) => {
        const isSelected = index === selected;
        return (
          <Text key={command.name} {...(isSelected ? accent : secondary)}>
            {`${isSelected ? theme.glyph.prompt + ' ' : '  '}${command.name.padEnd(width)}  ${command.description}`}
          </Text>
        );
      })}
    </Box>
  );
}
