/**
 * Measures the tool catalog itself: how many tools each MCP server offers and how many bytes its
 * schemas occupy. Costs no provider tokens -- it only starts the servers and asks them.
 *
 * This is what makes a "token heavy vs light" claim checkable rather than assumed, and it is how
 * the Q3 catalog bands are validated before spending anything on them.
 *
 *   node benchmark/catalog.mjs
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const node = process.execPath;
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-ws-'));

// Every server worth considering for a band, including ones that may not install -- finding that
// out is the point.
const CANDIDATES = [
  { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', workspace] },
  { name: 'terminal', command: node, args: [tsx, path.join(repoRoot, 'src', 'terminal-server.ts'), workspace] },
  { name: 'websearch', command: node, args: [tsx, path.join(repoRoot, 'src', 'websearch-server.ts')] },
  { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { name: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  { name: 'everything', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
  { name: 'git', command: 'npx', args: ['-y', '@cyanheads/git-mcp-server'] },
  { name: 'time', command: 'npx', args: ['-y', 'mcp-server-time'] },
  { name: 'fetch', command: 'npx', args: ['-y', 'mcp-server-fetch'] }
];

/** The same ratio the gateway uses when it reports savings, so the numbers are comparable. */
const CHARS_PER_TOKEN = 4;

async function inspect(candidate) {
  const transport = new StdioClientTransport({
    command: candidate.command,
    args: candidate.args,
    cwd: os.tmpdir(),
    env: { ...process.env, MEMORY_FILE_PATH: path.join(workspace, 'memory.json') },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'catalog-probe', version: '1.0.0' }, { capabilities: {} });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 60s')), 60_000));
  try {
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);
    const tools = listed.tools ?? [];
    const bytes = JSON.stringify(tools.map(t => ({
      name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? {}
    }))).length;
    return { ok: true, count: tools.length, bytes, names: tools.map(t => t.name) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

const rows = [];
for (const candidate of CANDIDATES) {
  process.stdout.write(`probing ${candidate.name} ... `);
  const result = await inspect(candidate);
  if (result.ok) {
    process.stdout.write(`${result.count} tools, ${result.bytes} bytes (~${Math.round(result.bytes / CHARS_PER_TOKEN)} tokens)\n`);
    rows.push({ name: candidate.name, ...result });
  } else {
    process.stdout.write(`UNAVAILABLE (${result.error})\n`);
    rows.push({ name: candidate.name, ok: false, error: result.error });
  }
}

const working = rows.filter(r => r.ok);
console.log('\n--- servers that work, heaviest first ---');
for (const row of [...working].sort((a, b) => b.bytes - a.bytes)) {
  console.log(`${String(row.name).padEnd(22)} ${String(row.count).padStart(3)} tools  ${String(row.bytes).padStart(6)} bytes  ~${Math.round(row.bytes / CHARS_PER_TOKEN)} tokens/turn if carried`);
}
const totalCount = working.reduce((sum, r) => sum + r.count, 0);
const totalBytes = working.reduce((sum, r) => sum + r.bytes, 0);
console.log(`\nall working servers: ${totalCount} tools, ${totalBytes} bytes, ~${Math.round(totalBytes / CHARS_PER_TOKEN)} tokens carried per turn in an inject-all baseline`);

fs.writeFileSync(path.join(here, 'catalog.json'), JSON.stringify(rows, null, 2));
console.log(`\nwritten to benchmark/catalog.json`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
