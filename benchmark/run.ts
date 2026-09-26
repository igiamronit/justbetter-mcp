/**
 * Token-efficiency benchmark harness. See BENCHMARK.md for the design this implements.
 *
 * The central rule: ONE agentic loop, three tool sources. Mode 1 and Mode 3 send their chat
 * requests to the gateway's own proxy and let it inject schemas; Mode 2 sends them straight to
 * the provider and supplies the tool list itself. Tool *execution* always goes through the same
 * MCP client. If each arm had its own loop the experiment would measure the loops.
 *
 * Token counts come from the `usage` object on the response the harness itself receives, for all
 * three arms, so "one turn" and "total tokens" mean exactly the same thing everywhere. The proxy
 * keeps its own token_log.csv; this deliberately does not rely on it, because it never sees
 * Mode 2.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TASKS, TASKS_BY_ID, type Task } from './tasks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const MODEL = process.env.BENCH_MODEL || 'nemotron-3-super';
const OLLAMA_BASE = 'https://ollama.com/v1';

/** Reasoning is billed as completion tokens, so it has to be pinned identically for every arm. */
const REASONING_EFFORT = process.env.BENCH_REASONING || 'low';

/** Hard ceilings. The free tier's real limits are unpublished, so this is the only brake. */
const BUDGET_TOKENS = parseInt(process.env.BENCH_BUDGET_TOKENS || '600000', 10);
const BUDGET_WALL_MS = parseInt(process.env.BENCH_BUDGET_MINUTES || '150', 10) * 60_000;

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 4;
const MAX_RESTARTS = 2;

type Mode = 'mode1' | 'mode2' | 'mode3';
const MODES: Mode[] = ['mode1', 'mode2', 'mode3'];
const MODE_LABEL: Record<Mode, string> = {
  mode1: 'Mode 1 (semantic injection)',
  mode2: 'Mode 2 (reactive discovery)',
  mode3: 'Mode 3 (inject-all baseline)'
};

// Servers enabled per catalog band. Cumulative: each band adds to the one before.
const BANDS: Record<string, string[]> = {
  small: ['filesystem'],
  medium: ['filesystem', 'terminal', 'memory'],
  large: ['filesystem', 'terminal', 'memory', 'sequential-thinking', 'git']
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();

function log(message: string) {
  process.stdout.write(`[${iso().slice(11, 19)}] ${message}\n`);
}

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port as number;
      server.close(() => resolve(port));
    });
  });
}

function ollamaKey(): string {
  const configPath = path.join(repoRoot, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const key = config?.llmProxy?.ollamaApiKey;
  if (!key || /^YOUR-/i.test(key)) {
    throw new Error('llmProxy.ollamaApiKey is missing or still a placeholder in config.json');
  }
  return key;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------------------------
// Gateway lifecycle: one fresh gateway per run, on its own port
// ---------------------------------------------------------------------------------------------

type Gateway = {
  client: Client;
  proxyBase: string;
  transport: StdioClientTransport;
  configPath: string;
  stop: () => Promise<void>;
};

async function startGateway(options: {
  workspace: string;
  servers: string[];
  mode: Mode;
  key: string;
}): Promise<Gateway> {
  const port = await freePort();
  const instance = `bench-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-state-'));
  const configPath = path.join(stateDir, 'config.json');

  const upstreams: any[] = [];
  const node = process.execPath;
  const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  if (options.servers.includes('filesystem')) {
    upstreams.push({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', options.workspace] });
  }
  if (options.servers.includes('terminal')) {
    upstreams.push({ name: 'terminal', command: node, args: [tsx, path.join(repoRoot, 'src', 'terminal-server.ts'), options.workspace] });
  }
  if (options.servers.includes('memory')) {
    upstreams.push({ name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: path.join(stateDir, 'memory.json') } });
  }
  if (options.servers.includes('sequential-thinking')) {
    upstreams.push({ name: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] });
  }
  if (options.servers.includes('git')) {
    upstreams.push({ name: 'git', command: 'npx', args: ['-y', '@cyanheads/git-mcp-server'] });
  }

  fs.writeFileSync(configPath, JSON.stringify({
    apiProvider: 'ollama',
    // Mode 1 injects; Mode 3 dumps everything; Mode 2 does neither because it never uses the proxy.
    semanticPromptInjection: options.mode !== 'mode2',
    injectAllTools: options.mode === 'mode3',
    allowedDirectories: [options.workspace],
    upstreamServers: upstreams,
    llmProxy: {
      enabled: true, port, host: '127.0.0.1',
      ollamaApiKey: options.key,
      model: MODEL
    },
    dashboard: { enabled: false },
    pinnedTools: [],
    destructiveTools: []
  }, null, 2));

  const transport = new StdioClientTransport({
    command: node,
    args: [path.join(repoRoot, 'bin', 'cli.js'), 'gateway', configPath],
    cwd: os.tmpdir(),
    env: {
      ...(process.env as Record<string, string>),
      SILENCE_LOGS: '1',
      JUSTBETTER_HOME: stateDir,
      JUSTBETTER_PROXY_INSTANCE: instance
    },
    stderr: 'pipe'
  });

  const client = new Client({ name: 'justbetter-benchmark', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // Wait for OUR proxy, not merely for something on the port. A stale gateway answering here
  // would run every arm against a different config while looking perfectly healthy.
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  let ours = false;
  while (Date.now() < deadline && !ours) {
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) {
        const body: any = await res.json().catch(() => ({}));
        if (body?.instance === instance) ours = true;
        else if (body?.instance) throw new Error(`port ${port} answered with a different instance`);
      }
    } catch (error: any) {
      if (String(error?.message).includes('different instance')) throw error;
    }
    if (!ours) await wait(400);
  }
  if (!ours) throw new Error(`our proxy never answered on port ${port}`);

  const stop = async () => {
    const pid = (transport as any).pid as number | undefined;
    try { await client.close(); } catch { /* ignore */ }
    killTree(pid);
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { client, proxyBase: origin, transport, configPath, stop };
}

// ---------------------------------------------------------------------------------------------
// Chat transport with retry, and the one place tokens are counted
// ---------------------------------------------------------------------------------------------

type Usage = { prompt: number; completion: number; total: number };
type ChatResult = {
  message: any;
  usage: Usage;
  injected: number | null;
  modelReported: string;
};

class QuotaExhausted extends Error {}
class ContextLost extends Error {}

let consecutiveRateLimits = 0;

async function chat(options: {
  url: string;
  key: string | null;
  messages: any[];
  tools: any[] | null;
}): Promise<ChatResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.key) headers.Authorization = `Bearer ${options.key}`;

  const body: any = {
    model: MODEL,
    messages: options.messages,
    temperature: 0,
    reasoning_effort: REASONING_EFFORT
  };
  // Mode 1 and Mode 3 send no tools at all: the proxy is what puts them in. Mode 2 sends its own.
  if (options.tools && options.tools.length > 0) body.tools = options.tools;

  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(options.url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal
      });

      if (res.status === 429) {
        consecutiveRateLimits++;
        // On a GPU-time-metered free tier a 429 can mean the month is gone, which no amount of
        // retrying fixes. Two in a row with no success between them stops everything.
        if (consecutiveRateLimits >= 2) {
          throw new QuotaExhausted('two consecutive rate limits with no successful call between');
        }
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10);
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1);
        if (attempt >= MAX_ATTEMPTS) throw new Error(`429 after ${attempt} attempts`);
        log(`    429 -> waiting ${Math.round(delay / 1000)}s (attempt ${attempt})`);
        await wait(delay);
        continue;
      }

      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          const delay = 2000 * 2 ** (attempt - 1);
          log(`    HTTP ${res.status} -> retrying in ${delay / 1000}s`);
          await wait(delay);
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      consecutiveRateLimits = 0;
      const payload: any = await res.json();
      const usage = payload?.usage ?? {};
      const message = payload?.choices?.[0]?.message;

      // An empty reply is one of the context-loss signals: the turn produced nothing to act on.
      if (!message) throw new ContextLost('response carried no message');
      const noContent = !message.content && !(Array.isArray(message.tool_calls) && message.tool_calls.length);
      if (noContent) throw new ContextLost('empty reply (no content and no tool calls)');

      const injectedHeader = res.headers.get('x-justbetter-injected-count');
      return {
        message,
        usage: {
          prompt: usage.prompt_tokens ?? 0,
          completion: usage.completion_tokens ?? 0,
          total: usage.total_tokens ?? 0
        },
        injected: injectedHeader ? parseInt(injectedHeader, 10) : null,
        modelReported: payload?.model ?? MODEL
      };
    } catch (error: any) {
      clearTimeout(timer);
      if (error instanceof QuotaExhausted || error instanceof ContextLost) throw error;
      const isTimeout = error?.name === 'AbortError';
      if (attempt >= MAX_ATTEMPTS) throw new Error(isTimeout ? `timed out after ${attempt} attempts` : String(error?.message ?? error));
      const delay = 2000 * 2 ** (attempt - 1);
      log(`    ${isTimeout ? 'timeout' : 'error: ' + error?.message} -> retrying in ${delay / 1000}s`);
      await wait(delay);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The shared agentic loop
// ---------------------------------------------------------------------------------------------

/**
 * System prompts.
 *
 * Mode 1 and Mode 3 send the sentinel the proxy looks for: `src/llm-proxy.ts` swaps it for the
 * real Mode 1 prompt, the one that explains that injected tools are ready to call and that
 * anything listed by name alone needs request_tools first. Sending our own prompt instead left
 * Mode 1 with no instructions about its own mechanism, and it spent six turns calling
 * request_tools in a loop and never touched the tools it had been given. That was a harness bug
 * that would have handed Mode 1 a catastrophic loss it did not earn.
 *
 * Mode 2 never passes through the proxy, so the harness has to supply the prompt. It mirrors the
 * proxy's text section for section, with only the tool-access paragraph swapped for Mode 2's
 * mechanism -- which is precisely the difference under test. Everything else, path resolution,
 * result validation, persistence, reflection, style, is identical.
 *
 * This duplicates wording from `src/llm-proxy.ts` around line 312. If that prompt changes, this
 * has to change with it or the comparison quietly stops being fair.
 */
const CLI_AGENT_SENTINEL = 'JUSTBETTER_CLI_AGENT';

const MODE2_SYSTEM_PROMPT = [
  'You are JustBetter CLI, an autonomous coding assistant operating through an MCP Gateway with tool discovery.',
  '',
  '## Path resolution',
  'If you already know the exact file path (the user gave it, or you have seen it already), open it directly. Only when the path is unknown or you are guessing, call list_directory on root first (cheap, always safe) to see the top-level folders, THEN scope your broad search to the specific subdirectory that looks relevant. Never call a read/write tool with a bare or guessed filename. Treat every path as unverified until a tool result confirms it.',
  '',
  '## Tool result validation',
  'A tool call that completes without throwing is NOT the same as success -- read the result content itself. If it contains an error, an empty result, or a "not found" message, that is a signal to retry with a different path or search strategy, not a final answer.',
  '',
  '## Persistence',
  'Never report "file not found" or "does not exist" after a single attempt. Try at least one alternate path, directory, or naming convention first. If you have exhausted reasonable search strategies, say what you tried before concluding it is missing.',
  '',
  '## Reflection',
  'Reflect on tool results before acting on them. After receiving tool results, carefully reflect on their quality and determine optimal next steps in your content output before proceeding with the next tool call.',
  '',
  '## Tool access (reactive discovery)',
  'Your tool array starts with request_tools and batch_call. When none of your current tools can do what is needed, call request_tools with a precise description of the capability you want; matching tools are then added to your array and can be called directly from then on. Do not call a tool that is not in your array yet.',
  '',
  '## Tool usage',
  'If the user simply says "hi", "hello", or engages in casual conversation where no action is required, DO NOT call any tools. Only call tools when strictly necessary to fulfill the user request.',
  '',
  '## Style',
  'Reference files by absolute path. No filler text before tool calls.'
].join(String.fromCharCode(10));

/**
 * Mode 3 is the naive baseline: every tool from every server sitting in the array, no retrieval.
 * It must NOT be told about request_tools. Given the sentinel it inherited Mode 1's prompt, which
 * says capabilities listed by name need loading first -- so it spent five of its six turns
 * calling request_tools for tools it had already been handed, and failed a task the other two
 * arms passed. That measured the prompt, not the baseline.
 */
const MODE3_SYSTEM_PROMPT = MODE2_SYSTEM_PROMPT
  .replace(
    '## Tool access (reactive discovery)',
    '## Tool access'
  )
  .replace(
    'Your tool array starts with request_tools and batch_call. When none of your current tools can do what is needed, call request_tools with a precise description of the capability you want; matching tools are then added to your array and can be called directly from then on. Do not call a tool that is not in your array yet.',
    'Every tool you could need is already in your tool array with full parameters. Call them directly. Do not call request_tools; there is nothing to discover.'
  );

type TurnRecord = {
  turn: number;
  prompt: number;
  completion: number;
  total: number;
  injected: number | null;
};

type RunOutcome = {
  passed: boolean;
  detail: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolsCalled: string[];
  firstToolCorrect: boolean | null;
  wrongToolCalls: number;
  gateBlocks: number;
  discoveryMisses: number;
  catalogSize: number;
  injectedPeak: number;
  perTurn: TurnRecord[];
  wallMs: number;
  modelReported: string;
};

function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

async function runOnce(options: {
  mode: Mode;
  task: Task;
  workspace: string;
  gateway: Gateway;
  key: string;
}): Promise<RunOutcome> {
  const { mode, task, gateway } = options;
  const started = Date.now();

  // The tool source. This is the ONLY difference between the arms.
  const listed = await gateway.client.listTools();
  const catalogTools = (listed.tools ?? []).map(tool => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema ?? { type: 'object', properties: {} } }
  }));
  const catalogSize = catalogTools.length;

  const url = mode === 'mode2' ? `${OLLAMA_BASE}/chat/completions` : `${gateway.proxyBase}/v1/chat/completions`;
  const key = mode === 'mode2' ? options.key : null;
  const tools = mode === 'mode2' ? catalogTools : null;

  const messages: any[] = [
    {
      role: 'system',
      content: mode === 'mode1' ? CLI_AGENT_SENTINEL
        : mode === 'mode2' ? MODE2_SYSTEM_PROMPT
        : MODE3_SYSTEM_PROMPT
    },
    { role: 'user', content: task.prompt }
  ];

  const perTurn: TurnRecord[] = [];
  const toolsCalled: string[] = [];
  const assistantText: string[] = [];
  let promptTokens = 0, completionTokens = 0, totalTokens = 0;
  let gateBlocks = 0, discoveryMisses = 0;
  let repeatGuard = new Map<string, number>();
  let modelReported = MODEL;
  let injectedPeak = 0;
  let turn = 0;

  while (turn < task.maxTurns) {
    turn++;
    const result = await chat({ url, key, messages, tools });
    modelReported = result.modelReported;
    promptTokens += result.usage.prompt;
    completionTokens += result.usage.completion;
    totalTokens += result.usage.total;
    perTurn.push({ turn, prompt: result.usage.prompt, completion: result.usage.completion, total: result.usage.total, injected: result.injected });
    if (result.injected !== null && result.injected > injectedPeak) injectedPeak = result.injected;

    const message = result.message;
    if (message.content) assistantText.push(contentToText(message.content));
    messages.push(message);

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) break;

    for (const call of calls) {
      const name = call?.function?.name ?? call?.name;
      const rawArgs = call?.function?.arguments ?? '{}';
      if (typeof name !== 'string' || !name.trim()) {
        messages.push({ role: 'tool', tool_call_id: call?.id, content: 'Error: tool call had no name.' });
        continue;
      }
      toolsCalled.push(name);

      // Identical call repeated three times means it is not making progress: that is the other
      // context-loss signal, and continuing just burns quota.
      const fingerprint = `${name}:${typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)}`;
      const seen = (repeatGuard.get(fingerprint) ?? 0) + 1;
      repeatGuard.set(fingerprint, seen);
      if (seen > 2) throw new ContextLost(`repeated identical call to ${name} ${seen} times`);

      let args: any = {};
      try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs; } catch { args = {}; }

      let resultText = '';
      try {
        const called = await gateway.client.callTool({ name, arguments: args });
        const parts = Array.isArray((called as any).content) ? (called as any).content : [];
        resultText = parts.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
        if (called.isError) {
          if (/hallucinat|not injected|not advertised/i.test(resultText)) gateBlocks++;
        }
      } catch (error: any) {
        resultText = `Error: ${error?.message ?? error}`;
        if (/hallucinat|not injected|not advertised/i.test(resultText)) gateBlocks++;
      }

      if (name === 'request_tools' && /no matching tools found/i.test(resultText)) discoveryMisses++;

      messages.push({
        role: 'tool',
        tool_call_id: call?.id,
        name,
        content: resultText.slice(0, 4000)
      });
    }
  }

  const transcript = assistantText.join('\n');
  const verdict = task.verify(options.workspace, transcript, toolsCalled);

  // request_tools and batch_call are plumbing, not task tools, so they are not "wrong".
  const plumbing = new Set(['request_tools', 'batch_call']);
  const realCalls = toolsCalled.filter(name => !plumbing.has(name));
  const firstToolCorrect = task.expectedTools.length === 0
    ? null
    : realCalls.length > 0 && task.expectedTools.includes(realCalls[0]!);
  const wrongToolCalls = task.expectedTools.length === 0
    ? realCalls.length
    : realCalls.filter(name => !task.expectedTools.includes(name)).length;

  return {
    passed: verdict.passed,
    detail: verdict.detail,
    turns: turn,
    promptTokens, completionTokens, totalTokens,
    toolsCalled,
    firstToolCorrect,
    wrongToolCalls,
    gateBlocks,
    discoveryMisses,
    catalogSize,
    injectedPeak,
    perTurn,
    wallMs: Date.now() - started,
    modelReported
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

type Row = {
  runId: string;
  mode: Mode;
  taskId: string;
  band: string;
  rep: number;
  attempts: number;
  restarts: number;
  abandoned: boolean;
  abandonReason?: string;
} & Partial<RunOutcome>;

const resultsRoot = path.join(repoRoot, 'benchmark', 'results');

async function main() {
  const key = ollamaKey();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(resultsRoot, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const rawPath = path.join(outDir, 'raw.jsonl');
  const turnsPath = path.join(outDir, 'turns.csv');
  fs.writeFileSync(turnsPath, 'run_id,mode,task_id,band,turn,prompt_tokens,completion_tokens,total_tokens,tools_injected\n');

  const band = process.env.BENCH_BAND || 'medium';
  const servers = BANDS[band] ?? BANDS.medium!;
  const only = process.env.BENCH_TASKS ? process.env.BENCH_TASKS.split(',') : null;
  const taskList = only ? only.map(id => TASKS_BY_ID.get(id)!).filter(Boolean) : TASKS;

  log(`model=${MODEL} band=${band} servers=${servers.join('+')} tasks=${taskList.length}`);
  log(`budget: ${BUDGET_TOKENS} tokens, ${Math.round(BUDGET_WALL_MS / 60000)} minutes`);
  log(`writing to benchmark/results/${stamp}/`);

  const rows: Row[] = [];
  let spentTokens = 0;
  const startedAt = Date.now();
  let stopReason: string | null = null;

  // Interleave by task, not by arm: running all of one mode first lets service drift and quota
  // throttling land unevenly on the arms and quietly become the finding.
  outer:
  for (const task of taskList) {
    for (const mode of MODES) {
      if (spentTokens > BUDGET_TOKENS) { stopReason = `token budget (${spentTokens} > ${BUDGET_TOKENS})`; break outer; }
      if (Date.now() - startedAt > BUDGET_WALL_MS) { stopReason = 'wall-clock budget'; break outer; }

      const runId = `${task.id}__${mode}`;
      let restarts = 0;
      let attempts = 0;
      let done = false;

      while (!done) {
        attempts++;
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ws-'));
        task.fixture(workspace);
        let gateway: Gateway | null = null;
        try {
          log(`${task.id} / ${mode} (attempt ${attempts})`);
          gateway = await startGateway({ workspace, servers, mode, key });
          const outcome = await runOnce({ mode, task, workspace, gateway, key });
          spentTokens += outcome.totalTokens;

          const row: Row = { runId, mode, taskId: task.id, band, rep: 1, attempts, restarts, abandoned: false, ...outcome };
          rows.push(row);
          fs.appendFileSync(rawPath, JSON.stringify(row) + '\n');
          for (const t of outcome.perTurn) {
            fs.appendFileSync(turnsPath, `${runId},${mode},${task.id},${band},${t.turn},${t.prompt},${t.completion},${t.total},${t.injected ?? ''}\n`);
          }
          log(`  -> ${outcome.passed ? 'PASS' : 'FAIL'} ${outcome.totalTokens} tokens, ${outcome.turns} turns, offered=${outcome.catalogSize} injectedPeak=${outcome.injectedPeak}  [${outcome.detail}]`);
          done = true;
        } catch (error: any) {
          if (error instanceof QuotaExhausted) {
            stopReason = `quota exhausted: ${error.message}`;
            try { await gateway?.stop(); } catch { /* ignore */ }
            fs.rmSync(workspace, { recursive: true, force: true });
            break outer;
          }
          if (error instanceof ContextLost && restarts < MAX_RESTARTS) {
            restarts++;
            log(`  context lost (${error.message}) -> binning transcript, restarting task clean`);
          } else {
            const reason = error instanceof ContextLost
              ? `context lost ${restarts + 1} times: ${error.message}`
              : String(error?.message ?? error);
            log(`  ABANDONED: ${reason}`);
            const row: Row = { runId, mode, taskId: task.id, band, rep: 1, attempts, restarts, abandoned: true, abandonReason: reason };
            rows.push(row);
            fs.appendFileSync(rawPath, JSON.stringify(row) + '\n');
            done = true;
          }
        } finally {
          try { await gateway?.stop(); } catch { /* ignore */ }
          try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    }
  }

  writeSummary(outDir, { rows, band, servers, spentTokens, stopReason, startedAt, stamp });
  log(`done. summary at benchmark/results/${stamp}/summary.md`);
}

function writeSummary(outDir: string, ctx: {
  rows: Row[]; band: string; servers: string[]; spentTokens: number;
  stopReason: string | null; startedAt: number; stamp: string;
}) {
  const { rows } = ctx;
  const lines: string[] = [];
  const done = rows.filter(r => !r.abandoned);
  const abandoned = rows.filter(r => r.abandoned);

  lines.push(`# Benchmark run ${ctx.stamp}`);
  lines.push('');
  lines.push(`Model \`${MODEL}\` · reasoning_effort \`${REASONING_EFFORT}\` · temperature 0 · band \`${ctx.band}\` (${ctx.servers.join(', ')})`);
  lines.push('');

  // Integrity first, per the design: a benchmark that hides its retries is not a benchmark.
  lines.push('## What actually ran');
  lines.push('');
  lines.push(`- runs completed: **${done.length}**`);
  lines.push(`- runs abandoned: **${abandoned.length}**`);
  lines.push(`- total retries beyond the first attempt: **${rows.reduce((sum, r) => sum + Math.max(0, (r.attempts ?? 1) - 1), 0)}**`);
  lines.push(`- task restarts after context loss: **${rows.reduce((sum, r) => sum + (r.restarts ?? 0), 0)}**`);
  lines.push(`- tokens spent: **${ctx.spentTokens}**`);
  lines.push(`- wall clock: **${Math.round((Date.now() - ctx.startedAt) / 60000)} min**`);
  if (ctx.stopReason) lines.push(`- **STOPPED EARLY: ${ctx.stopReason}** — results below are partial`);
  lines.push('');
  if (abandoned.length > 0) {
    lines.push('Abandoned runs:');
    lines.push('');
    for (const row of abandoned) lines.push(`- \`${row.taskId}\` / ${row.mode} — ${row.abandonReason}`);
    lines.push('');
  }

  lines.push('## Tier 1 — token efficiency');
  lines.push('');
  lines.push('| Arm | Runs | Passed | Total tokens | Prompt | Completion | Tokens/run | Turns/run |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const mode of MODES) {
    const mine = done.filter(r => r.mode === mode);
    if (mine.length === 0) { lines.push(`| ${MODE_LABEL[mode]} | 0 | — | — | — | — | — | — |`); continue; }
    const total = mine.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
    const prompt = mine.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
    const completion = mine.reduce((s, r) => s + (r.completionTokens ?? 0), 0);
    const turns = mine.reduce((s, r) => s + (r.turns ?? 0), 0);
    const passed = mine.filter(r => r.passed).length;
    lines.push(`| ${MODE_LABEL[mode]} | ${mine.length} | ${passed}/${mine.length} | ${total} | ${prompt} | ${completion} | ${Math.round(total / mine.length)} | ${(turns / mine.length).toFixed(1)} |`);
  }
  lines.push('');

  lines.push('### Per task, total tokens');
  lines.push('');
  lines.push('| Task | Mode 1 | Mode 2 | Mode 3 |');
  lines.push('|---|---|---|---|');
  const taskIds = [...new Set(rows.map(r => r.taskId))];
  for (const taskId of taskIds) {
    const cell = (mode: Mode) => {
      const row = done.find(r => r.taskId === taskId && r.mode === mode);
      if (!row) return rows.find(r => r.taskId === taskId && r.mode === mode)?.abandoned ? 'abandoned' : '—';
      return `${row.totalTokens} ${row.passed ? '✓' : '✗'}`;
    };
    lines.push(`| \`${taskId}\` | ${cell('mode1')} | ${cell('mode2')} | ${cell('mode3')} |`);
  }
  lines.push('');

  lines.push('## Tier 2 — tool-calling correctness');
  lines.push('');
  lines.push('| Arm | First tool correct | Wrong tool calls | Gate blocks | Discovery misses |');
  lines.push('|---|---|---|---|---|');
  for (const mode of MODES) {
    const mine = done.filter(r => r.mode === mode);
    if (mine.length === 0) { lines.push(`| ${MODE_LABEL[mode]} | — | — | — | — |`); continue; }
    const scored = mine.filter(r => r.firstToolCorrect !== null && r.firstToolCorrect !== undefined);
    const correct = scored.filter(r => r.firstToolCorrect).length;
    lines.push(`| ${MODE_LABEL[mode]} | ${correct}/${scored.length} | ${mine.reduce((s, r) => s + (r.wrongToolCalls ?? 0), 0)} | ${mine.reduce((s, r) => s + (r.gateBlocks ?? 0), 0)} | ${mine.reduce((s, r) => s + (r.discoveryMisses ?? 0), 0)} |`);
  }
  lines.push('');

  lines.push('## Tier 3 — outcomes');
  lines.push('');
  lines.push('| Task | Mode 1 | Mode 2 | Mode 3 |');
  lines.push('|---|---|---|---|');
  for (const taskId of taskIds) {
    const cell = (mode: Mode) => {
      const row = done.find(r => r.taskId === taskId && r.mode === mode);
      if (!row) return '—';
      return `${row.passed ? 'PASS' : 'FAIL'} — ${row.detail}`;
    };
    lines.push(`| \`${taskId}\` | ${cell('mode1')} | ${cell('mode2')} | ${cell('mode3')} |`);
  }
  lines.push('');

  lines.push('## Caveats');
  lines.push('');
  lines.push('- Tokens are provider-reported `usage`, counted by the harness from the response it received, identically for all three arms.');
  lines.push('- One repetition per cell. These numbers are **directional**, not significant.');
  lines.push('- Reasoning tokens are included in `completion`, pinned to the same effort for every arm.');
  lines.push('- Money and prompt caching are deliberately not measured. Do not read this as a cost claim.');
  lines.push('- One model. A result here is a result about this model.');

  fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
    model: MODEL,
    modelReported: done[0]?.modelReported ?? null,
    reasoningEffort: REASONING_EFFORT,
    temperature: 0,
    band: ctx.band,
    servers: ctx.servers,
    catalogSize: done[0]?.catalogSize ?? null,
    budgetTokens: BUDGET_TOKENS,
    stopReason: ctx.stopReason,
    gitSha: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).stdout?.trim()
  }, null, 2));
}

process.on('SIGINT', () => {
  log('interrupted — results written so far are on disk');
  process.exit(130);
});

void main().catch(error => {
  log(`FATAL: ${error?.message ?? error}`);
  process.exit(1);
});
