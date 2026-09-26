/**
 * Draws the benchmark charts as SVG straight from raw.jsonl. No plotting library, no API cost.
 *
 *   node benchmark/charts.mjs [runDir]
 *
 * SVG rather than PNG so the figures stay sharp in the README and legible in dark mode -- each
 * file carries its own prefers-color-scheme rules, which GitHub honours for inline images.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const runDir = process.argv[2] ?? path.join(here, 'results', '2026-09-26T13-49-49-254Z');
const outDir = path.join(repoRoot, 'charts');
fs.mkdirSync(outDir, { recursive: true });

const rows = fs.readFileSync(path.join(runDir, 'raw.jsonl'), 'utf-8')
  .split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line))
  .filter(row => !row.abandoned);

const MODES = ['mode1', 'mode2', 'mode3'];
const NAME = {
  mode1: 'Mode 1 - semantic injection',
  mode2: 'Mode 2 - reactive discovery',
  mode3: 'Mode 3 - inject-all baseline'
};
const SHORT = { mode1: 'Mode 1', mode2: 'Mode 2', mode3: 'Mode 3' };
const TAIL = { mode1: 'semantic injection', mode2: 'reactive discovery', mode3: 'inject-all baseline' };

const sum = list => list.reduce((total, value) => total + value, 0);
const mean = list => sum(list) / list.length;
const median = list => {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const arm = {};
for (const mode of MODES) {
  const mine = rows.filter(row => row.mode === mode);
  const turns = sum(mine.map(row => row.turns));
  arm[mode] = {
    runs: mine.length,
    passed: mine.filter(row => row.passed).length,
    meanPrompt: Math.round(mean(mine.map(row => row.promptTokens))),
    meanCompletion: Math.round(mean(mine.map(row => row.completionTokens))),
    meanTotal: Math.round(mean(mine.map(row => row.totalTokens))),
    medianTotal: Math.round(median(mine.map(row => row.totalTokens))),
    meanTurns: mean(mine.map(row => row.turns)),
    tokPerTurn: Math.round(sum(mine.map(row => row.totalTokens)) / turns)
  };
}
const taskIds = [...new Set(rows.map(row => row.taskId))];

/* ---------- drawing helpers ---------- */

const FONT = 'ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
const STYLE = [
  '.bg { fill: #ffffff; }',
  '.title { font: 600 17px ' + FONT + '; fill: #1f2328; }',
  '.sub { font: 400 12.5px ' + FONT + '; fill: #59636e; }',
  '.axis { font: 400 12px ' + FONT + '; fill: #59636e; }',
  '.lbl { font: 600 12.5px ' + FONT + '; fill: #1f2328; }',
  '.val { font: 700 13px ' + FONT + '; fill: #1f2328; }',
  '.small { font: 400 10.5px ' + FONT + '; fill: #59636e; }',
  '.grid { stroke: #d1d9e0; stroke-width: 1; }',
  '.axisline { stroke: #59636e; stroke-width: 1; }',
  '.m1 { fill: #1f6feb; } .m2 { fill: #bf8700; } .m3 { fill: #cf222e; }',
  '.m1c { fill: #a5c9ff; } .m2c { fill: #e8c477; } .m3c { fill: #ffb3ba; }',
  '.medmark { stroke: #1f2328; stroke-width: 2; stroke-dasharray: 3 2; }',
  '@media (prefers-color-scheme: dark) {',
  '  .bg { fill: #0d1117; }',
  '  .title, .lbl, .val { fill: #e6edf3; }',
  '  .sub, .axis, .small { fill: #9198a1; }',
  '  .grid { stroke: #2f3742; }',
  '  .axisline { stroke: #9198a1; }',
  '  .m1 { fill: #58a6ff; } .m2 { fill: #d29922; } .m3 { fill: #f85149; }',
  '  .m1c { fill: #1f4e85; } .m2c { fill: #6b4c08; } .m3c { fill: #7d2622; }',
  '  .medmark { stroke: #e6edf3; }',
  '}'
].join(String.fromCharCode(10));

const cls = { mode1: 'm1', mode2: 'm2', mode3: 'm3' };
const clsPale = { mode1: 'm1c', mode2: 'm2c', mode3: 'm3c' };
const commas = value => Math.round(value).toLocaleString('en-US');
const one = value => value.toFixed(1);

/**
 * Picks a round axis maximum and a matching tick step. The candidate list is deliberately fine:
 * a coarse one (1, 2, 5, 10) rounds 47k up to 100k and leaves the tallest bar at half height,
 * which reads as if the differences were smaller than they are.
 */
function scale(maxValue) {
  const raw = maxValue * 1.08;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const multiple of [1, 1.2, 1.5, 1.6, 2, 2.4, 2.5, 3, 4, 5, 6, 8, 10]) {
    const top = magnitude * multiple;
    if (top >= raw) return { top, step: top / 4 };
  }
  return { top: magnitude * 10, step: magnitude * 2.5 };
}

function svg(width, height, body) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height
      + '" width="' + width + '" height="' + height + '" role="img">',
    '<style>' + STYLE + '</style>',
    '<rect class="bg" width="' + width + '" height="' + height + '" rx="6"/>',
    body,
    '</svg>',
    ''
  ].join(String.fromCharCode(10));
}

const rect = (klass, x, y, w, h, r) =>
  '<rect class="' + klass + '" x="' + one(x) + '" y="' + one(y) + '" width="' + one(w)
    + '" height="' + one(h) + '" rx="' + r + '"/>';

const text = (klass, x, y, content, anchor) =>
  '<text class="' + klass + '" x="' + one(x) + '" y="' + one(y) + '"'
    + (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + content + '</text>';

const line = (klass, x1, y1, x2, y2) =>
  '<line class="' + klass + '" x1="' + one(x1) + '" y1="' + one(y1) + '" x2="' + one(x2)
    + '" y2="' + one(y2) + '"/>';

/** Y-axis gridlines plus their labels, drawn behind the bars. */
function gridY(x0, x1, yTop, yBottom, top, step, format) {
  const fmt = format ?? commas;
  const parts = [];
  for (let value = 0; value <= top + 1e-9; value += step) {
    const y = yBottom - (value / top) * (yBottom - yTop);
    parts.push(line('grid', x0, y, x1, y));
    parts.push(text('axis', x0 - 8, y + 4, fmt(value), 'end'));
  }
  return parts.join('');
}

/* ---------- 1. headline: mean tokens per run, split prompt vs completion ---------- */

function chartMeanTokens() {
  const W = 860;
  const H = 450;
  const x0 = 96;
  const x1 = W - 96;
  const yTop = 100;
  const yBottom = H - 96;
  const { top, step } = scale(Math.max(...MODES.map(mode => arm[mode].meanTotal)));
  const slot = (x1 - x0) / MODES.length;
  const barW = 116;
  const parts = [
    text('title', 30, 34, 'Mean tokens per completed run'),
    text('sub', 30, 56, 'Lower is better. Eight verifiable tasks, one run each, nemotron-3-super. Bars split prompt (solid) from completion (pale).'),
    text('sub', 30, 75, 'The dashed rule is the median, which is the figure to quote: within-arm spread is 4-7x at one repetition per cell.'),
    gridY(x0, x1, yTop, yBottom, top, step),
    line('axisline', x0, yBottom, x1, yBottom),
    text('axis', 30, yTop - 12, 'tokens')
  ];
  MODES.forEach((mode, index) => {
    const data = arm[mode];
    const cx = x0 + slot * index + slot / 2;
    const bx = cx - barW / 2;
    const height = value => (value / top) * (yBottom - yTop);
    const promptH = height(data.meanPrompt);
    const compH = height(data.meanCompletion);
    parts.push(rect(clsPale[mode], bx, yBottom - promptH - compH, barW, compH, 2));
    parts.push(rect(cls[mode], bx, yBottom - promptH, barW, promptH, 2));
    parts.push(text('val', cx, yBottom - promptH - compH - 12, commas(data.meanTotal), 'middle'));
    const medY = yBottom - height(data.medianTotal);
    parts.push(line('medmark', bx - 12, medY, bx + barW + 12, medY));
    parts.push(text('small', bx + barW + 16, medY + 4, 'med ' + commas(data.medianTotal)));
    parts.push(text('lbl', cx, yBottom + 23, SHORT[mode], 'middle'));
    parts.push(text('small', cx, yBottom + 40, TAIL[mode], 'middle'));
    parts.push(text('small', cx, yBottom + 57, data.passed + '/' + data.runs + ' passed  |  '
      + Math.round(100 * data.meanPrompt / data.meanTotal) + '% prompt', 'middle'));
  });
  return svg(W, H, parts.join(String.fromCharCode(10)));
}

/* ---------- 2. the mechanism: same price per turn, different number of turns ---------- */

function chartTurnEconomics() {
  const W = 860;
  const H = 410;
  const panelW = (W - 60) / 2;
  const parts = [
    text('title', 30, 34, 'Why Mode 1 is cheaper: fewer turns, not a cheaper turn'),
    text('sub', 30, 56, 'Mode 1 and Mode 2 pay nearly the same price per turn. The gap between them is turn count alone.'),
    text('sub', 30, 75, 'Cost is about 97% prompt in every arm, so each extra turn re-sends the whole transcript and the whole tool surface.')
  ];

  const panel = (offsetX, title, values, format, note) => {
    const x0 = offsetX + 76;
    const x1 = offsetX + panelW - 16;
    const yTop = 126;
    const yBottom = H - 80;
    const { top, step } = scale(Math.max(...MODES.map(mode => values[mode])));
    const slot = (x1 - x0) / MODES.length;
    const barW = 58;
    const out = [
      text('lbl', offsetX + 30, 108, title),
      gridY(x0, x1, yTop, yBottom, top, step, format),
      line('axisline', x0, yBottom, x1, yBottom)
    ];
    MODES.forEach((mode, index) => {
      const cx = x0 + slot * index + slot / 2;
      const h = (values[mode] / top) * (yBottom - yTop);
      out.push(rect(cls[mode], cx - barW / 2, yBottom - h, barW, h, 2));
      out.push(text('val', cx, yBottom - h - 10, format(values[mode]), 'middle'));
      out.push(text('lbl', cx, yBottom + 23, SHORT[mode], 'middle'));
    });
    out.push(text('small', offsetX + 30, H - 30, note));
    return out.join(String.fromCharCode(10));
  };

  const perTurn = Object.fromEntries(MODES.map(mode => [mode, arm[mode].tokPerTurn]));
  const turns = Object.fromEntries(MODES.map(mode => [mode, arm[mode].meanTurns]));
  const perTurnGap = 100 * (perTurn.mode2 - perTurn.mode1) / perTurn.mode1;
  const mode3Gap = 100 * (perTurn.mode3 - perTurn.mode1) / perTurn.mode1;
  const turnGap = 100 * (turns.mode2 - turns.mode1) / turns.mode2;

  parts.push(panel(0, 'Tokens per turn', perTurn, commas,
    'Mode 1 vs Mode 2: ' + perTurnGap.toFixed(1) + '% apart. Mode 3 pays '
      + Math.round(mode3Gap) + '% more per turn for its 26-tool surface.'));
  parts.push(panel(panelW + 30, 'Turns per run (mean)', turns, one,
    'Mode 1 finishes in ' + Math.round(turnGap) + '% fewer turns than Mode 2. That is the whole advantage.'));
  return svg(W, H, parts.join(String.fromCharCode(10)));
}

/* ---------- 3. per-task tokens ---------- */

function chartPerTask() {
  const W = 940;
  const H = 470;
  const x0 = 92;
  const x1 = W - 24;
  const yTop = 96;
  const yBottom = H - 98;
  const { top, step } = scale(Math.max(...rows.map(row => row.totalTokens)));
  const slot = (x1 - x0) / taskIds.length;
  const barW = Math.min(22, (slot - 18) / 3);
  const parts = [
    text('title', 30, 34, 'Tokens per task'),
    text('sub', 30, 56, 'One run per cell. F marks a failed verification. The ordering is not uniform - Mode 2 wins three of the eight tasks outright.'),
    text('sub', 30, 75, 'Note the range: the same arm can cost four to seven times more on one task than another, which is why single runs cannot settle this.'),
    gridY(x0, x1, yTop, yBottom, top, step),
    line('axisline', x0, yBottom, x1, yBottom),
    text('axis', 30, yTop - 12, 'tokens')
  ];
  taskIds.forEach((taskId, index) => {
    const groupCx = x0 + slot * index + slot / 2;
    MODES.forEach((mode, modeIndex) => {
      const row = rows.find(item => item.taskId === taskId && item.mode === mode);
      if (!row) return;
      const bx = groupCx - (barW * 3 + 6) / 2 + modeIndex * (barW + 3);
      const h = (row.totalTokens / top) * (yBottom - yTop);
      parts.push(rect(cls[mode], bx, yBottom - h, barW, h, 1.5));
      if (!row.passed) parts.push(text('small', bx + barW / 2, yBottom - h - 5, 'F', 'middle'));
    });
    const label = taskId.replace(/^t[0-9]+-/, '');
    parts.push(text('small', groupCx, yBottom + 18, taskId.slice(0, 2), 'middle'));
    parts.push(text('small', groupCx, yBottom + 33,
      label.length > 13 ? label.slice(0, 12) + '.' : label, 'middle'));
  });
  MODES.forEach((mode, index) => {
    const lx = x0 + index * 210;
    parts.push(rect(cls[mode], lx, H - 40, 12, 12, 2));
    parts.push(text('small', lx + 18, H - 30, NAME[mode]));
  });
  return svg(W, H, parts.join(String.fromCharCode(10)));
}

const files = {
  'bench_mean_tokens.svg': chartMeanTokens(),
  'bench_turn_economics.svg': chartTurnEconomics(),
  'bench_per_task.svg': chartPerTask()
};
for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(outDir, name), content);
  console.log('charts/' + name + '  ' + content.length + ' bytes');
}
console.log('');
console.log('figures for the report:');
for (const mode of MODES) {
  const data = arm[mode];
  console.log(SHORT[mode] + '  mean ' + commas(data.meanTotal) + '  median ' + commas(data.medianTotal)
    + '  tok/turn ' + commas(data.tokPerTurn) + '  turns ' + data.meanTurns.toFixed(1)
    + '  pass ' + data.passed + '/' + data.runs);
}
