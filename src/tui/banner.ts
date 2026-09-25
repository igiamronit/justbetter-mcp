import type { Theme } from './theme.js';

/**
 * The wordmark shown at startup.
 *
 * A three-row half-block font rather than a figlet dependency: the package already ships
 * source instead of a build, and a font table for thirteen letters is smaller than another
 * runtime dependency. Every glyph is exactly three columns plus a separator, so the width
 * is arithmetic rather than a guess.
 */
const FONT: Record<string, [string, string, string]> = {
  j: ['  █', '▄ █', '▀▀▀'],
  u: ['█ █', '█ █', '▀▀▀'],
  s: ['█▀▀', '▀▀█', '▀▀▀'],
  t: ['▀█▀', ' █ ', ' ▀ '],
  b: ['█▀▄', '█ █', '▀▀ '],
  e: ['█▀▀', '█▀▀', '▀▀▀'],
  r: ['█▀▄', '█▀▄', '▀ ▀'],
  m: ['█▄█', '█ █', '▀ ▀'],
  c: ['█▀▀', '█  ', '▀▀▀'],
  p: ['█▀▄', '█▀ ', '▀  '],
  '-': ['   ', '▄▄▄', '   ']
};

/** Single-column fallback for terminals that cannot draw half blocks. */
const ASCII_FONT: Record<string, [string, string, string]> = {
  j: ['  #', '  #', '###'],
  u: ['# #', '# #', '###'],
  s: ['###', '#  ', '###'],
  t: ['###', ' # ', ' # '],
  b: ['## ', '#.#', '## '],
  e: ['###', '## ', '###'],
  r: ['## ', '#.#', '# #'],
  m: ['#.#', '# #', '# #'],
  c: ['###', '#  ', '###'],
  p: ['## ', '## ', '#  '],
  '-': ['   ', '---', '   ']
};

const WORD = 'justbetter-mcp';

/** Columns the wordmark needs, so a narrow terminal can skip it rather than wrap it. */
export function bannerWidth(): number {
  return WORD.length * 4 - 1;
}

/**
 * The wordmark as three strings, or an empty array when it will not fit. Callers fall back
 * to a plain one-line title rather than printing something that wraps into noise.
 */
export function bannerLines(theme: Theme): string[] {
  if (theme.columns < bannerWidth() + 2) return [];
  const font = theme.unicode ? FONT : ASCII_FONT;
  const rows = ['', '', ''];
  for (const character of WORD) {
    const glyph = font[character];
    if (!glyph) continue;
    for (let row = 0; row < 3; row++) {
      rows[row] = (rows[row] ?? '') + glyph[row] + ' ';
    }
  }
  return rows.map(row => ' ' + row.trimEnd());
}
