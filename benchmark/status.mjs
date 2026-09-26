/**
 * Tells you whether a benchmark run is still going, how far it has got, and what it has found so
 * far. Reads the newest results directory; safe to run at any time, including mid-run.
 *
 *   node benchmark/status.mjs
 *
 * The run appends to raw.jsonl after every single run, so this is always current. summary.md is
 * written only at the very end, which is what makes "FINISHED" reliable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsRoot = path.join(here, 'results');

if (!fs.existsSync(resultsRoot)) {
  console.log('No runs yet.');
  process.exit(0);
}

const dirs = fs.readdirSync(resultsRoot)
  .filter(name => fs.statSync(path.join(resultsRoot, name)).isDirectory())
  .sort()
  .reverse();

if (dirs.length === 0) {
  console.log('No runs yet.');
  process.exit(0);
}

const dir = path.join(resultsRoot, dirs[0]);
const rawPath = path.join(dir, 'raw.jsonl');
const summaryPath = path.join(dir, 'summary.md');
const finished = fs.existsSync(summaryPath);

const rows = fs.existsSync(rawPath)
  ? fs.readFileSync(rawPath, 'utf-8').split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line))
  : [];

const EXPECTED = 24; // 8 tasks x 3 arms
const ageMinutes = rows.length > 0
  ? Math.round((Date.now() - fs.statSync(rawPath).mtimeMs) / 60000)
  : null;

console.log('');
console.log(`run       ${dirs[0]}`);
console.log(`state     ${finished ? 'FINISHED' : 'RUNNING'}`);
console.log(`progress  ${rows.length} of ~${EXPECTED} runs`);
if (!finished && ageMinutes !== null) {
  console.log(`last wrote ${ageMinutes} min ago${ageMinutes > 10 ? '  <-- suspicious, it may be stuck' : ''}`);
}

const done = rows.filter(r => !r.abandoned);
const abandoned = rows.filter(r => r.abandoned);
const tokens = done.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
console.log(`tokens    ${tokens}`);
console.log(`abandoned ${abandoned.length}  (infrastructure or provider, not scored)`);
console.log(`reruns    ${rows.reduce((sum, r) => sum + (r.restarts ?? 0), 0)}`);

if (done.length > 0) {
  console.log('');
  console.log('per arm so far:');
  for (const mode of ['mode1', 'mode2', 'mode3']) {
    const mine = done.filter(r => r.mode === mode);
    if (mine.length === 0) { console.log(`  ${mode}  no runs yet`); continue; }
    const total = mine.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
    const passed = mine.filter(r => r.passed).length;
    console.log(`  ${mode}  ${String(mine.length).padStart(2)} runs  ${passed}/${mine.length} passed  ${String(Math.round(total / mine.length)).padStart(6)} tokens/run`);
  }
}

if (abandoned.length > 0) {
  console.log('');
  console.log('abandoned (NOT counted against any mode):');
  for (const row of abandoned) console.log(`  ${row.taskId} / ${row.mode} - ${row.abandonReason}`);
}

console.log('');
console.log(finished
  ? `Read the report:  benchmark/results/${dirs[0]}/summary.md`
  : 'Still running. Re-run this command to check again.');
console.log('');
