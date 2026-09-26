/**
 * Tells you whether a benchmark run is going, how far it has got, and what it has found so far.
 * Safe to run at any time, including mid-run.
 *
 *   node benchmark/status.mjs
 *
 * raw.jsonl is appended after every single run, so this is always current. summary.md is written
 * only at the very end, which is what makes FINISHED reliable rather than a guess.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsRoot = path.join(here, 'results');
const MODES = ['mode1', 'mode2', 'mode3'];
const LABEL = { mode1: 'Mode 1 inject', mode2: 'Mode 2 discover', mode3: 'Mode 3 all-tools' };

if (!fs.existsSync(resultsRoot)) { console.log('\nNo runs yet.\n'); process.exit(0); }
const dirs = fs.readdirSync(resultsRoot)
  .filter(name => fs.statSync(path.join(resultsRoot, name)).isDirectory())
  .sort().reverse();
if (dirs.length === 0) { console.log('\nNo runs yet.\n'); process.exit(0); }

const runName = process.argv[2] ?? dirs[0];
const dir = path.join(resultsRoot, runName);
const rawPath = path.join(dir, 'raw.jsonl');
const finished = fs.existsSync(path.join(dir, 'summary.md'));

const rows = fs.existsSync(rawPath)
  ? fs.readFileSync(rawPath, 'utf-8').split(String.fromCharCode(10)).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
  : [];

const taskIds = [...new Set(rows.map(r => r.taskId))];
const EXPECTED = 24;
const idleMin = rows.length > 0 ? Math.round((Date.now() - fs.statSync(rawPath).mtimeMs) / 60000) : null;

const done = rows.filter(r => !r.abandoned);
const abandoned = rows.filter(r => r.abandoned);
const spent = done.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);

console.log('');
console.log('================ BENCHMARK STATUS ================');
console.log(`run        ${runName}`);
console.log(`state      ${finished ? 'FINISHED' : 'RUNNING'}`);
console.log(`progress   ${rows.length} of ${EXPECTED} runs   (${Math.round(100 * rows.length / EXPECTED)}%)`);
if (!finished && idleMin !== null) {
  console.log(`last wrote ${idleMin} min ago${idleMin > 12 ? '   <-- STUCK? nothing for over 12 min' : ''}`);
}
console.log(`tokens     ${spent.toLocaleString()}`);
console.log(`reruns     ${rows.reduce((s, r) => s + (r.restarts ?? 0), 0)}  (infrastructure/provider, never scored)`);
console.log(`abandoned  ${abandoned.length}`);

if (done.length > 0) {
  console.log('');
  console.log('--- per arm ---------------------------------------');
  console.log('arm                runs  pass   tok/run  tok/TURN  turns');
  for (const mode of MODES) {
    const mine = done.filter(r => r.mode === mode);
    if (mine.length === 0) { console.log(`${LABEL[mode].padEnd(18)}    -     -         -         -      -`); continue; }
    const tokens = mine.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
    const turns = mine.reduce((s, r) => s + (r.turns ?? 0), 0);
    const passed = mine.filter(r => r.passed).length;
    // tok/TURN is the stable one: total cost is dominated by how many turns a run happened to
    // need, which swings hugely at one repetition per cell.
    console.log(
      LABEL[mode].padEnd(18)
      + String(mine.length).padStart(4)
      + String(`${passed}/${mine.length}`).padStart(6)
      + String(Math.round(tokens / mine.length).toLocaleString()).padStart(10)
      + String(turns > 0 ? Math.round(tokens / turns).toLocaleString() : '-').padStart(10)
      + String((turns / mine.length).toFixed(1)).padStart(7)
    );
  }

  console.log('');
  console.log('--- per task (tokens, P=pass F=fail) --------------');
  console.log('task                        mode1         mode2         mode3');
  for (const taskId of taskIds) {
    const cell = mode => {
      const row = rows.find(r => r.taskId === taskId && r.mode === mode);
      if (!row) return '-';
      if (row.abandoned) return 'ABANDONED';
      return `${(row.totalTokens ?? 0).toLocaleString()}${row.passed ? 'P' : 'F'}`;
    };
    console.log(taskId.padEnd(26) + MODES.map(m => cell(m).padStart(13)).join(' '));
  }
}

if (abandoned.length > 0) {
  console.log('');
  console.log('--- abandoned (NOT counted against any mode) ------');
  for (const row of abandoned) console.log(`  ${row.taskId} / ${row.mode}: ${row.abandonReason}`);
}

console.log('');
console.log(finished
  ? `Report:  benchmark/results/${runName}/summary.md`
  : `Still running. Re-run this to refresh. To resume after a stop:  BENCH_RESUME=${runName} npx tsx benchmark/run.ts`);
console.log('==================================================');
console.log('');
