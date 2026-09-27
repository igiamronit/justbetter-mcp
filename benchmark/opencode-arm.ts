/**
 * Arm A of the OpenCode comparison: OpenCode, unmodified, running the same eight tasks as the
 * gateway benchmark.
 *
 *   npx tsx benchmark/opencode-arm.ts
 *   node benchmark/status.mjs        # progress and results, safe to run mid-suite
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 *
 * OpenCode carries its own system prompt and its own built-in tools on top of whatever MCP servers
 * are connected. So the gap between this arm and mode1/mode2/mode3 is NOT purely tool delivery --
 * part of it is OpenCode being a full agent rather than our minimal harness. The catalog is pinned
 * to the same three servers and 26 tools the gateway benchmark used so that at least that variable
 * is held still. Anything quoted from this arm has to carry that caveat.
 *
 * Token counts are OpenCode's own accounting, read out of its SQLite store rather than parsed from
 * its output, which makes them its numbers and not ours.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TASKS } from './tasks.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const MODE = 'opencode';
const MODEL = process.env.BENCH_OC_MODEL ?? 'ollama-cloud/nemotron-3-super';
const VARIANT = process.env.BENCH_OC_VARIANT ?? 'low';
const MAX_STEPS = 20;
const ATTEMPT_TIMEOUT_MS = Number(process.env.BENCH_OC_TIMEOUT_MS ?? 20 * 60 * 1000);
const MAX_ATTEMPTS = 3;
const BUDGET_TOKENS = Number(process.env.BENCH_BUDGET_TOKENS ?? 1_500_000);
const ONLY_TASKS = (process.env.BENCH_TASKS ?? '').split(',').map(t => t.trim()).filter(Boolean);

const ocDataDir = path.join(os.homedir(), '.local', 'share', 'opencode');
const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocbench-mem-'));
const ocDbPath = path.join(ocDataDir, 'opencode.db');

/** Faults that belong to the provider or the machine, never scored against the arm. */
const INFRA_ERROR = /rate.?limit|429|too many requests|quota|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|502|503|504|overloaded|unavailable/i;

class InfraFailure extends Error {}
class QuotaExhausted extends Error {}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(repoRoot, 'benchmark', 'results', stamp + '-opencode');
fs.mkdirSync(outDir, { recursive: true });
const rawPath = path.join(outDir, 'raw.jsonl');

const log = (message: string) => {
  const now = new Date().toTimeString().slice(0, 8);
  process.stdout.write('[' + now + '] ' + message + '\n');
};

/**
 * The per-task project config. It disables every globally configured MCP server by name and adds
 * the three the gateway benchmark used, under distinct names so no deep merge of a `command` array
 * can happen. Verified with `opencode debug config` before any tokens were spent.
 */
function writeConfig(workspace: string, globalServerNames: string[]) {
  const node = process.execPath;
  const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const mcp: Record<string, unknown> = {};
  for (const name of globalServerNames) mcp[name] = { enabled: false };
  mcp.benchfs = {
    type: 'local',
    enabled: true,
    command: ['npx.cmd', '-y', '@modelcontextprotocol/server-filesystem', workspace]
  };
  mcp.benchterm = {
    type: 'local',
    enabled: true,
    command: [node, tsx, path.join(repoRoot, 'src', 'terminal-server.ts'), workspace]
  };
  mcp.benchmem = {
    type: 'local',
    enabled: true,
    command: ['npx.cmd', '-y', '@modelcontextprotocol/server-memory'],
    // Deliberately OUTSIDE the task workspace. Written inside, memory.json shows up in directory
    // listings and in mtime comparisons, which is a file the task never put there.
    environment: { MEMORY_FILE_PATH: path.join(memoryDir, 'memory.json') }
  };
  const config = {
    $schema: 'https://opencode.ai/config.json',
    mcp,
    // `task` off keeps a run to a single session, so the token accounting has no child sessions to
    // chase. Everything else OpenCode ships with is left alone on purpose -- this arm is OpenCode.
    tools: { task: false },
    agent: { build: { temperature: 0, variant: VARIANT, maxSteps: MAX_STEPS } }
  };
  fs.writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify(config, null, 2));
}

/** Names of the MCP servers the user has configured globally, so they can be switched off. */
function globalMcpNames(): string[] {
  const candidates = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const stripped = fs.readFileSync(file, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(stripped) as { mcp?: Record<string, unknown> };
      return Object.keys(parsed.mcp ?? {});
    } catch { /* fall through to the known set */ }
  }
  return ['filesystem', 'terminal', 'websearch', 'sqlite', 'memory'];
}

type Attempt = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * The npm package ships a native binary. Spawning that directly, rather than the `.cmd` shim
 * through a shell, is what keeps a task prompt intact -- a shell would re-split it on spaces and
 * swallow its punctuation.
 */
function resolveOpenCode(): { command: string; shell: boolean } {
  const exe = path.join(
    os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'opencode-ai', 'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  );
  if (fs.existsSync(exe)) return { command: exe, shell: false };
  return { command: 'opencode', shell: true };
}

const OPENCODE = resolveOpenCode();

function runOpenCode(workspace: string, prompt: string, title: string): Promise<Attempt> {
  return new Promise(resolve => {
    const args = [
      'run', '--auto', '--dir', workspace,
      '-m', MODEL, '--variant', VARIANT,
      '--title', title,
      prompt
    ];
    const child = spawn(OPENCODE.command, args, {
      cwd: workspace,
      shell: OPENCODE.shell,
      // stdin MUST be closed. Left as an open pipe, `opencode run` reaches init and then waits on
      // it forever -- it treats piped stdin as more of the message. First run hung 12 minutes on
      // exactly this and never called the model.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, ATTEMPT_TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(error), timedOut });
    });
  });
}

type Harvest = {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  turns: number;
  transcript: string;
  toolsCalled: string[];
  toolsCalledRaw: string[];
  mcpToolCalls: number;
  builtinToolCalls: number;
  toolErrorCount: number;
  perTurn: { turn: number; prompt: number; completion: number; total: number; injected: number }[];
};

/**
 * Reads back what OpenCode recorded for this run. Sums the session and any children, since a
 * subagent gets its own session row -- `task` is disabled so there should be none, but summing the
 * tree costs nothing and removes the assumption.
 */
function harvest(title: string): Harvest | null {
  const db = new DatabaseSync(ocDbPath, { readOnly: true });
  try {
    // The title carries the task id, the run stamp and the attempt number, so it identifies one
    // attempt on its own and needs no time window.
    const root = db.prepare(
      'select id from session where title = ? order by time_created desc limit 1'
    ).get(title) as { id: string } | undefined;
    if (!root) return null;

    const ids = [root.id];
    for (let i = 0; i < ids.length; i++) {
      const parent = ids[i];
      if (parent === undefined) continue;
      const kids = db.prepare('select id from session where parent_id = ?').all(parent) as { id: string }[];
      for (const kid of kids) if (!ids.includes(kid.id)) ids.push(kid.id);
    }

    let promptTokens = 0, completionTokens = 0, reasoningTokens = 0, cacheRead = 0, cacheWrite = 0;
    let turns = 0, toolErrorCount = 0;
    const perTurn: Harvest['perTurn'] = [];
    const transcriptParts: string[] = [];
    const toolsCalled: string[] = [];
    const toolsCalledRaw: string[] = [];

    for (const id of ids) {
      const messages = db.prepare(
        'select id, data from message where session_id = ? order by time_created'
      ).all(id) as { id: string; data: string }[];
      for (const row of messages) {
        const message = JSON.parse(row.data) as {
          role: string;
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        };
        if (message.role !== 'assistant') continue;
        turns++;
        const t = message.tokens ?? {};
        const input = t.input ?? 0;
        const output = t.output ?? 0;
        const reasoning = t.reasoning ?? 0;
        promptTokens += input;
        completionTokens += output;
        reasoningTokens += reasoning;
        cacheRead += t.cache?.read ?? 0;
        cacheWrite += t.cache?.write ?? 0;
        perTurn.push({
          turn: turns,
          prompt: input + (t.cache?.read ?? 0),
          completion: output + reasoning,
          total: input + (t.cache?.read ?? 0) + output + reasoning,
          injected: 0            // OpenCode does not disclose per-turn tool counts
        });
      }
      const parts = db.prepare('select data from part where session_id = ?').all(id) as { data: string }[];
      for (const row of parts) {
        const part = JSON.parse(row.data) as {
          type: string; text?: string; tool?: string;
          state?: { status?: string; error?: unknown };
        };
        if (part.type === 'text' && part.text) transcriptParts.push(part.text);
        if (part.type === 'tool' && part.tool) {
          toolsCalledRaw.push(part.tool);
          toolsCalled.push(part.tool.replace(/^bench(fs|term|mem)[_-]/, ''));
          const status = part.state?.status ?? '';
          if (status === 'error' || part.state?.error) toolErrorCount++;
        }
      }
    }

    return {
      sessionId: root.id,
      promptTokens, completionTokens, reasoningTokens, cacheRead, cacheWrite,
      // cacheRead is ADDITIVE to input, not a subset of it. Verified on t7: one turn reported
      // input 13,441 / cache 0 and the next input 5,051 / cache 8,448 -- the prompt did not shrink
      // by 8k, those tokens simply moved columns. Leaving cache out understates the prompt this arm
      // actually sent by about 36%, and makes it incomparable to the other arms, whose provider
      // reported the whole prompt in usage.prompt_tokens.
      totalTokens: promptTokens + cacheRead + completionTokens + reasoningTokens,
      turns,
      transcript: transcriptParts.join('\n'),
      toolsCalled, toolsCalledRaw,
      mcpToolCalls: toolsCalledRaw.filter(name => /^bench(fs|term|mem)[_-]/.test(name)).length,
      builtinToolCalls: toolsCalledRaw.filter(name => !/^bench(fs|term|mem)[_-]/.test(name)).length,
      toolErrorCount, perTurn
    };
  } finally {
    db.close();
  }
}

async function runTask(task: typeof TASKS[number], globalNames: string[]) {
  let restarts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ocbench-'));
    task.fixture(workspace);
    writeConfig(workspace, globalNames);
    // Back-date it so it cannot be mistaken for something the task created. Without this,
    // t5-newest-file correctly answers "opencode.json" and the verifier calls that a failure.
    const configPath = path.join(workspace, 'opencode.json');
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(configPath, longAgo, longAgo);

    const title = 'jbbench-' + task.id + '-' + stamp + '-a' + attempt;
    log('  ' + task.id + ' attempt ' + attempt + ' ...');

    const result = await runOpenCode(workspace, task.prompt, title);
    const combined = result.stdout + '\n' + result.stderr;
    // Keep what OpenCode said, every attempt. Without this a stall is invisible.
    fs.writeFileSync(path.join(outDir, title + '.out.txt'),
      'exit=' + result.code + ' timedOut=' + result.timedOut + '\n--- stdout ---\n'
      + result.stdout + '\n--- stderr ---\n' + result.stderr);

    if (result.timedOut) {
      restarts++;
      log('    timed out after ' + Math.round(ATTEMPT_TIMEOUT_MS / 60000) + ' min - infrastructure, retrying');
      if (attempt === MAX_ATTEMPTS) return { abandoned: true, abandonReason: 'timed out ' + MAX_ATTEMPTS + 'x', restarts };
      await new Promise(r => setTimeout(r, 30_000));
      continue;
    }

    const data = harvest(title);

    if (!data || data.turns === 0) {
      // No session, or a session that never got a reply: provider or launcher, not the model.
      const reason = INFRA_ERROR.test(combined) ? 'provider error' : 'no session recorded';
      restarts++;
      log('    ' + reason + ' (exit ' + result.code + ') - not scored, retrying');
      if (/quota|insufficient|payment/i.test(combined)) throw new QuotaExhausted(combined.slice(-400));
      if (attempt === MAX_ATTEMPTS) return { abandoned: true, abandonReason: reason, restarts };
      await new Promise(r => setTimeout(r, 30_000));
      continue;
    }

    // A non-zero exit WITH usable usage means the model worked and something else complained.
    // That is scored, because the transcript and the workspace are both real.
    const verdict = task.verify(workspace, data.transcript, data.toolsCalled);
    const first = data.toolsCalled[0];
    const expected = task.expectedTools;

    log('    -> ' + (verdict.passed ? 'PASS' : 'FAIL') + ' ' + data.totalTokens.toLocaleString()
      + ' tokens, ' + data.turns + ' turns, mcp=' + data.mcpToolCalls
      + ' builtin=' + data.builtinToolCalls + '  [' + verdict.detail + ']');

    return {
      abandoned: false,
      restarts,
      row: {
        runId: task.id + '__' + MODE,
        mode: MODE,
        taskId: task.id,
        band: 'medium',
        rep: 1,
        attempts: attempt,
        restarts,
        abandoned: false,
        passed: verdict.passed,
        detail: verdict.detail,
        turns: data.turns,
        promptTokens: data.promptTokens + data.cacheRead,
        completionTokens: data.completionTokens + data.reasoningTokens,
        totalTokens: data.totalTokens,
        toolsCalled: data.toolsCalled,
        firstToolCorrect: expected.length === 0 ? data.toolsCalled.length === 0 : Boolean(first && expected.includes(first)),
        wrongToolCalls: expected.length === 0 ? data.toolsCalled.length
          : data.toolsCalled.filter(name => !expected.includes(name)).length,
        gateBlocks: 0,
        discoveryMisses: 0,
        toolCallCount: data.toolsCalled.length,
        toolErrorCount: data.toolErrorCount,
        infraErrorCount: restarts,
        hitTurnCap: data.turns >= MAX_STEPS,
        catalogSize: 26,
        injectedPeak: 26,
        perTurn: data.perTurn,
        wallMs: 0,
        modelReported: MODEL,
        // OpenCode-only extras, kept out of the shared fields so nothing downstream breaks.
        opencode: {
          sessionId: data.sessionId,
          toolsCalledRaw: data.toolsCalledRaw,
          mcpToolCalls: data.mcpToolCalls,
          builtinToolCalls: data.builtinToolCalls,
          reasoningTokens: data.reasoningTokens,
          cacheRead: data.cacheRead,
          cacheWrite: data.cacheWrite,
          exitCode: result.code,
          workspace
        }
      }
    };
  }
  return { abandoned: true, abandonReason: 'exhausted attempts', restarts };
}

async function main() {
  if (!fs.existsSync(ocDbPath)) {
    log('FATAL: no OpenCode database at ' + ocDbPath);
    process.exit(1);
  }
  const globalNames = globalMcpNames();
  log('OpenCode arm A - plain OpenCode, ' + MODEL + ', variant ' + VARIANT);
  log('catalog pinned to benchfs + benchterm + benchmem (26 tools); disabling global: ' + globalNames.join(', '));
  log('results -> ' + path.relative(repoRoot, outDir));

  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
    arm: MODE, model: MODEL, variant: VARIANT, maxSteps: MAX_STEPS,
    tasks: (ONLY_TASKS.length > 0 ? ONLY_TASKS : TASKS.map(t => t.id)), catalog: ['filesystem', 'terminal', 'memory'], catalogSize: 26,
    disabledGlobalServers: globalNames, startedAt: new Date().toISOString(),
    caveat: 'OpenCode contributes its own system prompt and built-in tools; the gap to mode1/2/3 is not purely tool delivery.'
  }, null, 2));

  let spent = 0;
  const selected = ONLY_TASKS.length > 0 ? TASKS.filter(t => ONLY_TASKS.includes(t.id)) : TASKS;
  if (ONLY_TASKS.length > 0) log('restricted to: ' + selected.map(t => t.id).join(', '));
  for (const task of selected) {
    if (spent > BUDGET_TOKENS) {
      log('budget of ' + BUDGET_TOKENS.toLocaleString() + ' tokens reached, stopping');
      break;
    }
    log(task.id);
    let outcome: Awaited<ReturnType<typeof runTask>>;
    try {
      outcome = await runTask(task, globalNames);
    } catch (error) {
      if (error instanceof QuotaExhausted) {
        log('FATAL: provider quota exhausted. Nothing scored against the arm. Resume later.');
        break;
      }
      throw error;
    }
    if (outcome.abandoned || !outcome.row) {
      fs.appendFileSync(rawPath, JSON.stringify({
        runId: task.id + '__' + MODE, mode: MODE, taskId: task.id, abandoned: true,
        abandonReason: outcome.abandonReason, restarts: outcome.restarts, totalTokens: 0, turns: 0
      }) + '\n');
      log('  ABANDONED: ' + outcome.abandonReason + ' (not counted against the arm)');
      continue;
    }
    fs.appendFileSync(rawPath, JSON.stringify(outcome.row) + '\n');
    spent += outcome.row.totalTokens;
  }

  const rows = fs.readFileSync(rawPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const done = rows.filter(r => !r.abandoned);
  const lines = [
    '# OpenCode arm A',
    '',
    'Run `' + stamp + '` - ' + done.length + ' of ' + TASKS.length + ' tasks scored, '
      + rows.filter(r => r.abandoned).length + ' abandoned.',
    '',
    'Model `' + MODEL + '`, variant `' + VARIANT + '`, catalog 26 tools (filesystem + terminal + memory).',
    '',
    '| Task | Tokens | Turns | Result |',
    '|---|---|---|---|',
    ...done.map(r => '| `' + r.taskId + '` | ' + r.totalTokens.toLocaleString() + ' | ' + r.turns
      + ' | ' + (r.passed ? 'pass' : '**fail**') + ' |'),
    '',
    'Total ' + done.reduce((s, r) => s + r.totalTokens, 0).toLocaleString() + ' tokens.',
    '',
    'Caveat: OpenCode brings its own system prompt and built-in tools, so the difference between',
    'this arm and mode1/mode2/mode3 is not purely tool delivery.'
  ];
  fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n') + '\n');
  log('done. summary at ' + path.relative(repoRoot, path.join(outDir, 'summary.md')));
}

main().catch(error => {
  log('FATAL ' + String(error?.stack ?? error));
  process.exit(1);
});
