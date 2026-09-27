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
  '.good { font: 700 12px ' + FONT + '; fill: #1a7f37; }',
  '.goodsm { font: 700 10px ' + FONT + '; fill: #1a7f37; }',
  '.bad { font: 700 12px ' + FONT + '; fill: #a40e26; }',
  '.badsm { font: 700 10px ' + FONT + '; fill: #a40e26; }',
  '.base { font: 400 11px ' + FONT + '; fill: #59636e; }',
  '@media (prefers-color-scheme: dark) {',
  '  .bg { fill: #0d1117; }',
  '  .title, .lbl, .val { fill: #e6edf3; }',
  '  .sub, .axis, .small, .base { fill: #9198a1; }',
  '  .grid { stroke: #2f3742; }',
  '  .axisline { stroke: #9198a1; }',
  '  .m1 { fill: #58a6ff; } .m2 { fill: #d29922; } .m3 { fill: #f85149; }',
  '  .m1c { fill: #1f4e85; } .m2c { fill: #6b4c08; } .m3c { fill: #7d2622; }',
  '  .medmark { stroke: #e6edf3; }',
  '  .good, .goodsm { fill: #3fb950; }',
  '  .bad, .badsm { fill: #ff7b72; }',
  '}'
].join(String.fromCharCode(10));

/**
 * Change against the inject-all baseline, which is the arm every chart measures from. Green only
 * where the arm actually beat the baseline -- Mode 2 needs *more* turns than inject-all does, and
 * colouring that green to keep the chart tidy would be a lie.
 */
function delta(value, baseline, small) {
  if (value === baseline) return { label: 'baseline', klass: 'base' };
  const pct = 100 * (value - baseline) / baseline;
  const better = pct < 0;
  const sign = better ? String.fromCharCode(0x2212) : '+';
  return {
    label: sign + Math.abs(pct).toFixed(1) + '%',
    klass: (better ? 'good' : 'bad') + (small ? 'sm' : '')
  };
}

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
  const W = 820;
  const H = 400;
  const gutter = 70;          // identical left and right, so the plot sits centred
  const x0 = gutter + 46;     // leaves room for the y tick labels
  const x1 = W - gutter;
  const yTop = 86;
  const yBottom = H - 92;
  const { top, step } = scale(Math.max(...MODES.map(mode => arm[mode].meanTotal)));
  const slot = (x1 - x0) / MODES.length;
  const barW = 104;
  const baseline = arm.mode3.meanTotal;
  const parts = [
    text('title', gutter, 34, 'Mean tokens per completed run'),
    gridY(x0, x1, yTop, yBottom, top, step),
    line('axisline', x0, yBottom, x1, yBottom),
    text('axis', gutter, yTop - 12, 'tokens')
  ];
  MODES.forEach((mode, index) => {
    const data = arm[mode];
    const cx = x0 + slot * index + slot / 2;
    const bx = cx - barW / 2;
    const height = value => (value / top) * (yBottom - yTop);
    const barTop = yBottom - height(data.meanTotal);
    parts.push(rect(cls[mode], bx, barTop, barW, height(data.meanTotal), 2));
    parts.push(text('val', cx, barTop - 13, commas(data.meanTotal), 'middle'));
    const change = delta(data.meanTotal, baseline);
    parts.push(text(change.klass, cx, barTop - 32, change.label, 'middle'));
    // Median rule spans the bar and nothing else, so every group is the same width.
    const medY = yBottom - height(data.medianTotal);
    parts.push(line('medmark', bx, medY, bx + barW, medY));
    parts.push(text(mode === 'mode1' ? 'lbl' : 'small', cx, yBottom + 24, SHORT[mode], 'middle'));
    parts.push(text('small', cx, yBottom + 41, TAIL[mode], 'middle'));
    parts.push(text('small', cx, yBottom + 58,
      'median ' + commas(data.medianTotal) + '  ·  ' + data.passed + '/' + data.runs + ' passed', 'middle'));
  });
  return svg(W, H, parts.join(String.fromCharCode(10)));
}

/* ---------- 2. the mechanism: same price per turn, different number of turns ---------- */

function chartTurnEconomics() {
  const W = 820;
  const H = 336;
  const gutter = 70;
  const sep = 64;
  const panelW = (W - 2 * gutter - sep) / 2;
  const parts = [text('title', gutter, 34, 'What a turn costs, and how many turns it takes')];

  const panel = (left, title, values, format) => {
    const x0 = left + 46;
    const x1 = left + panelW;
    const yTop = 100;
    const yBottom = H - 62;
    const { top, step } = scale(Math.max(...MODES.map(mode => values[mode])));
    const slot = (x1 - x0) / MODES.length;
    const barW = 54;
    const out = [
      text('lbl', (x0 + x1) / 2, 68, title, 'middle'),
      gridY(x0, x1, yTop, yBottom, top, step, format),
      line('axisline', x0, yBottom, x1, yBottom)
    ];
    MODES.forEach((mode, index) => {
      const cx = x0 + slot * index + slot / 2;
      const h = (values[mode] / top) * (yBottom - yTop);
      out.push(rect(cls[mode], cx - barW / 2, yBottom - h, barW, h, 2));
      out.push(text('val', cx, yBottom - h - 11, format(values[mode]), 'middle'));
      const change = delta(values[mode], values.mode3);
      out.push(text(change.klass, cx, yBottom - h - 28, change.label, 'middle'));
      out.push(text(mode === 'mode1' ? 'lbl' : 'small', cx, yBottom + 22, SHORT[mode], 'middle'));
    });
    return out.join(String.fromCharCode(10));
  };

  const perTurn = Object.fromEntries(MODES.map(mode => [mode, arm[mode].tokPerTurn]));
  const turns = Object.fromEntries(MODES.map(mode => [mode, arm[mode].meanTurns]));
  parts.push(panel(gutter, 'Tokens per turn', perTurn, commas));
  parts.push(panel(gutter + panelW + sep, 'Turns per run', turns, one));
  return svg(W, H, parts.join(String.fromCharCode(10)));
}

/* ---------- 3. per-task tokens ---------- */

function chartPerTask() {
  const W = 940;
  const H = 444;
  const x0 = 92;
  const x1 = W - 24;
  const yTop = 90;
  const yBottom = H - 104;
  const { top, step } = scale(Math.max(...rows.map(row => row.totalTokens)));
  const slot = (x1 - x0) / taskIds.length;
  const barW = Math.min(22, (slot - 18) / 3);
  const parts = [
    text('title', 30, 32, 'Tokens per task, against the inject-all baseline'),
    gridY(x0, x1, yTop, yBottom, top, step),
    line('axisline', x0, yBottom, x1, yBottom),
    text('axis', 30, yTop - 10, 'tokens')
  ];
  taskIds.forEach((taskId, index) => {
    const groupCx = x0 + slot * index + slot / 2;
    const baseline = rows.find(item => item.taskId === taskId && item.mode === 'mode3');
    MODES.forEach((mode, modeIndex) => {
      const row = rows.find(item => item.taskId === taskId && item.mode === mode);
      if (!row) return;
      const bx = groupCx - (barW * 3 + 6) / 2 + modeIndex * (barW + 3);
      const h = (row.totalTokens / top) * (yBottom - yTop);
      const barTop = yBottom - h;
      parts.push(rect(cls[mode], bx, barTop, barW, h, 1.5));
      if (!row.passed) parts.push(text('small', bx + barW / 2, barTop - 4, 'F', 'middle'));
      // Rotated so eight tasks' worth of percentages cannot collide horizontally.
      if (mode !== 'mode3' && baseline) {
        const change = delta(row.totalTokens, baseline.totalTokens, true);
        const lx = bx + barW / 2 + 3.5;
        const ly = barTop - (row.passed ? 8 : 18);
        parts.push('<text class="' + change.klass + '" transform="rotate(-90 ' + one(lx) + ' '
          + one(ly) + ')" x="' + one(lx) + '" y="' + one(ly) + '">' + change.label + '</text>');
      }
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
  parts.push(text('small', x0 + 640, H - 30, 'F = failed verification'));
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
