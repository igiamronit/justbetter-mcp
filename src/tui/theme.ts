/**
 * The TUI's visual vocabulary: four colour roles and four glyphs, and the rules for
 * degrading both.
 *
 * Kept as data rather than scattered literals so the renderer has one place to ask, and
 * so the degraded paths can be tested without a terminal. The previous renderer reached
 * for six colours and bolded five different things, which is what made it read as busy.
 */

/** Terminal capabilities, resolved once and passed down. */
export interface Theme {
  /** False when colour must not be emitted at all. */
  color: boolean;
  /** False when the terminal cannot be trusted with box-drawing characters. */
  unicode: boolean;
  /** Usable width in columns. */
  columns: number;
  glyph: {
    /** Opens an assistant message or a tool call. */
    bullet: string;
    /** Hangs a result off the line above it. */
    branch: string;
    /** The user's own input. */
    prompt: string;
    /** A failure. */
    fail: string;
    /** Left and right edges of the input box, and its corners. */
    boxVertical: string;
    boxHorizontal: string;
    boxTopLeft: string;
    boxTopRight: string;
    boxBottomLeft: string;
    boxBottomRight: string;
  };
}

/**
 * Styling for one transcript line. `undefined` means the terminal's own foreground, which
 * is deliberate: conversation text is left unstyled so it dominates everything around it.
 */
export interface Style {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}

const UNICODE_GLYPHS: Theme['glyph'] = {
  bullet: '⏺',
  branch: '⎿',
  prompt: '>',
  fail: '✗',
  boxVertical: '│',
  boxHorizontal: '─',
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯'
};

// Chosen so a line keeps the same width in both modes: every fallback is one column, which
// means wrapping maths does not change when the glyphs do.
const ASCII_GLYPHS: Theme['glyph'] = {
  bullet: '*',
  branch: '\\',
  prompt: '>',
  fail: 'x',
  boxVertical: '|',
  boxHorizontal: '-',
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+'
};

/** Below this the input border is dropped; a box plus padding leaves too little room. */
export const NARROW_COLUMNS = 60;

export interface ThemeInput {
  columns?: number | undefined;
  /** Honours the NO_COLOR convention. */
  noColor?: boolean | undefined;
  /** Forces the single-byte glyph set. */
  ascii?: boolean | undefined;
}

/** Pure, so the degraded combinations are testable without a terminal. */
export function resolveTheme(input: ThemeInput = {}): Theme {
  return {
    color: input.noColor !== true,
    unicode: input.ascii !== true,
    columns: Math.max(20, input.columns ?? 80),
    glyph: input.ascii === true ? ASCII_GLYPHS : UNICODE_GLYPHS
  };
}

/**
 * Reads the environment.
 *
 * NO_COLOR is honoured whatever its value, per the convention: the variable's presence is
 * the signal. JUSTBETTER_ASCII is our own escape hatch for terminals that report a UTF-8
 * locale and then render box-drawing characters as replacement boxes anyway, which older
 * Windows consoles do.
 */
export function themeFromEnvironment(columns?: number, env: Record<string, string | undefined> = process.env): Theme {
  return resolveTheme({
    columns,
    noColor: env.NO_COLOR !== undefined && env.NO_COLOR !== '',
    ascii: env.JUSTBETTER_ASCII === '1'
  });
}

/** True when the input border should be dropped for want of width. */
export function isNarrow(theme: Theme): boolean {
  return theme.columns < NARROW_COLUMNS;
}

/**
 * The four roles. Anything not in this list does not get a colour.
 *
 * `conversation` returning an empty object is the point of the scheme, not an oversight:
 * the assistant's prose and the user's own words are the only things on screen that are
 * never recoloured, so they stand out against uniformly dimmed machinery.
 */
export function style(theme: Theme, role: 'conversation' | 'accent' | 'secondary' | 'failure'): Style {
  if (!theme.color) {
    // Without colour, bold is the only remaining way to separate a failure from noise.
    return role === 'failure' ? { bold: true } : {};
  }
  switch (role) {
    case 'accent': return { color: 'cyan' };
    case 'secondary': return { dimColor: true };
    case 'failure': return { color: 'red' };
    case 'conversation': return {};
  }
}
