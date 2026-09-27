/**
 * The one command for "where are we and what have we got".
 *
 *   node benchmark/status.mjs            # everything measured so far, across every run
 *   node benchmark/status.mjs <runDir>   # just that run
 *
 * Merges every run directory under benchmark/results, so arms added later (OpenCode) show up
 * beside the original three without anything being re-run. When the same task has been measured
 * twice for the same arm, the newer run wins. raw.jsonl is appended after every single task, so
 * this is always current, including mid-suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsRoot = path.join(here, 'results');

const LABEL = {
  mode1: 'Mode 1 inject',
  mode2: 'Mode 2 discover',
  mode3: 'Mode 3 all-tools',
  opencode: 'OpenCode plain'
};
const ORDER = ['mode1', 'mode2', 'mode3', 'opencode'];
const NL = String.fromCharCode(10);

if (!fs.existsSync(resultsRoot)) { console.log(NL + 'No runs yet.' + NL); process.exit(0); }

const dirs = fs.readdirSync(resultsRoot)
  .filter(name => fs.statSync(path.join(resultsRoot, name)).isDirectory())
  .sort();
if (dirs.length === 0) { console.log(NL + 'No runs yet.' + NL); process.exit(0); }

const only = process.argv[2];
const chosen = only ? dirs.filter(d => d === only) : dirs;
if (chosen.length === 0) { console.log(NL + 'No run directory named ' + only + NL); process.exit(1); }

/** Every row from every chosen run, newest run winning a tie on (mode, taskId). */
const byKey = new Map();
const runs = [];
for (const dir of chosen) {
  const full = path.join(resultsRoot, dir);
  const rawPath = path.join(full, 'raw.jsonl');
  if (!fs.existsSync(rawPath)) continue;
  const rows = fs.readFileSync(rawPath, 'utf-8').split(NL).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  runs.push({
    dir,
    finished: fs.existsSync(path.join(full, 'summary.md')),
    count: rows.length,
    mtimeMs: fs.statSync(rawPath).mtimeMs,
    arms: [...new Set(rows.map(r => r.mode))]
  });
  for (const row of rows) byKey.set(row.mode + '|' + row.taskId, { ...row, _run: dir });
}

const rows = [...byKey.values()];
if (rows.length === 0) { console.log(NL + 'No results recorded yet.' + NL); process.exit(0); }

const arms = ORDER.filter(m => rows.some(r => r.mode === m))
  .concat([...new Set(rows.map(r => r.mode))].filter(m => !ORDER.includes(m)));
const taskIds = [...new Set(rows.map(r => r.taskId))].filter(Boolean).sort();
const done = rows.filter(r => !r.abandoned);
const abandoned = rows.filter(r => r.abandoned);
const pad = (value, width) => String(value).padStart(width);
const num = value => Math.round(value).toLocaleString('en-US');

console.log('');
console.log('=================== BENCHMARK STATUS ===================');

const live = runs.filter(r => !r.finished);
if (live.length > 0) {
  for (const run of live) {
    const idleMin = Math.round((Date.now() - run.mtimeMs) / 60000);
    const expected = run.arms.length * taskIds.length || taskIds.length;
    console.log('IN FLIGHT  ' + run.dir);
    console.log('           ' + run.count + ' of ~' + expected + ' runs recorded'
      + '   last wrote ' + idleMin + ' min ago'
      + (idleMin > 25 ? '   <-- STUCK? nothing for over 25 min' : ''));
  }
} else {
  console.log('state      all runs FINISHED');
}
console.log('runs read  ' + chosen.length + ' directory(ies), ' + rows.length + ' task results, '
  + arms.length + ' arm(s)');
console.log('tokens     ' + num(done.reduce((s, r) => s + (r.totalTokens ?? 0), 0)) + ' total');
console.log('reruns     ' + rows.reduce((s, r) => s + (r.restarts ?? 0), 0)
  + '   (infrastructure/provider, never scored)');
console.log('abandoned  ' + abandoned.length);

console.log('');
console.log('--- per arm --------------------------------------------');
console.log('arm                runs  pass   tok/run   tok/TURN  turns');
for (const mode of arms) {
  const mine = done.filter(r => r.mode === mode);
  const label = (LABEL[mode] ?? mode).padEnd(18);
  if (mine.length === 0) { console.log(label + '   -     -         -          -      -'); continue; }
  const tokens = mine.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
  const turns = mine.reduce((s, r) => s + (r.turns ?? 0), 0);
  const passed = mine.filter(r => r.passed).length;
  // tok/TURN is the stable one: total cost is dominated by how many turns a run happened to need,
  // which swings hugely at one repetition per cell.
  console.log(label
    + pad(mine.length, 4)
    + pad(passed + '/' + mine.length, 6)
    + pad(num(tokens / mine.length), 10)
    + pad(turns > 0 ? num(tokens / turns) : '-', 11)
    + pad((turns / mine.length).toFixed(1), 7));
}

// Against whichever arm is the declared baseline, so the saving is visible without a spreadsheet.
const baseline = arms.includes('opencode') ? 'opencode' : (arms.includes('mode3') ? 'mode3' : null);
if (baseline) {
  const base = done.filter(r => r.mode === baseline);
  if (base.length > 0) {
    const baseMean = base.reduce((s, r) => s + (r.totalTokens ?? 0), 0) / base.length;
    console.log('');
    console.log('--- mean tokens vs ' + (LABEL[baseline] ?? baseline) + ' ---------------------');
    for (const mode of arms) {
      if (mode === baseline) continue;
      const mine = done.filter(r => r.mode === mode);
      if (mine.length === 0) continue;
      const mean = mine.reduce((s, r) => s + (r.totalTokens ?? 0), 0) / mine.length;
      const pct = (100 * (mean - baseMean) / baseMean).toFixed(1);
      console.log('  ' + (LABEL[mode] ?? mode).padEnd(18) + pad(num(mean), 9)
        + '   ' + (mean < baseMean ? '' : '+') + pct + '%'
        + (mine.length === base.length ? '' : '   (only ' + mine.length + ' of ' + base.length + ' tasks)'));
    }
  }
}

console.log('');
console.log('--- per task (tokens, P=pass F=fail) -------------------');
console.log('task'.padEnd(26) + arms.map(m => (LABEL[m] ?? m).slice(0, 13).padStart(14)).join(''));
for (const taskId of taskIds) {
  const cells = arms.map(mode => {
    const row = rows.find(r => r.taskId === taskId && r.mode === mode);
    if (!row) return '-';
    if (row.abandoned) return 'ABANDONED';
    return num(row.totalTokens ?? 0) + (row.passed ? 'P' : 'F');
  });
  console.log(taskId.padEnd(26) + cells.map(c => c.padStart(14)).join(''));
}

if (abandoned.length > 0) {
  console.log('');
  console.log('--- abandoned (NOT counted against any arm) ------------');
  for (const row of abandoned) {
    console.log('  ' + row.taskId + ' / ' + row.mode + ': ' + row.abandonReason);
  }
}

console.log('');
if (live.length > 0) {
  console.log('Still running. Re-run this command to refresh.');
} else {
  console.log('Reports:');
  for (const run of runs) {
    if (run.finished) console.log('  benchmark/results/' + run.dir + '/summary.md');
  }
}
console.log('========================================================');
console.log('');
