import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type TestResult = {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
  reason?: string;
};

type TestCase = {
  name: string;
  fn?: () => Promise<void> | void;
  skip?: string;
};

const testFile = fileURLToPath(import.meta.url);
const testsDir = path.dirname(testFile);
const repoRoot = path.dirname(testsDir);
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'justbetter-mcp-tests-'));
const originalCwd = process.cwd();
const originalEnv = { ...process.env };

// Keep stateful modules that use relative paths, especially catalog.db, isolated
// from the user's real repository database.
process.chdir(tempRoot);

function srcModule(relativePath: string) {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

function tempFile(name: string) {
  return path.join(tempRoot, name);
}

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function expectRejects(fn: () => unknown | Promise<unknown>) {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, 'Expected function to throw/reject');
}

const tests: TestCase[] = [
  {
    name: 'config: loads defaults, core pinned tools, and LLM_PORT override',
    async fn() {
      const { loadConfig, CORE_PINNED_TOOLS } = await import(srcModule('src/config.ts'));
      const configPath = tempFile('config-defaults.json');
      writeJson(configPath, {
        upstreamServers: [{ name: 'mock', command: 'node' }],
        llmProxy: {
          port: 4141,
          realApiBase: 'http://127.0.0.1:9999/v1',
          realApiKey: 'test-key'
        },
        pinnedTools: ['custom_tool']
      });

      process.env.LLM_PORT = '5151';
      const config = loadConfig(configPath);
      delete process.env.LLM_PORT;

      assert.equal(config.upstreamServers[0]?.name, 'mock');
      assert.deepEqual(config.upstreamServers[0]?.args, []);
      assert.equal(config.llmProxy?.port, 5151);
      assert.equal(new Set(config.pinnedTools).size, config.pinnedTools.length);
      assert.ok(config.pinnedTools.includes('custom_tool'));
      for (const coreTool of CORE_PINNED_TOOLS) {
        assert.ok(config.pinnedTools.includes(coreTool), `Missing core pinned tool ${coreTool}`);
      }
      assert.deepEqual(config.destructiveTools, []);
    }
  },
  {
    name: 'config: saveConfig round-trips through loadConfig',
    async fn() {
      const { loadConfig, saveConfig } = await import(srcModule('src/config.ts'));
      const configPath = tempFile('config-roundtrip.json');
      const config = {
        upstreamServers: [{ name: 'fs', command: 'npx', args: ['server', '.'] }],
        llmProxy: {
          port: 4242,
          realApiBase: 'http://127.0.0.1:9999/v1',
          realApiKey: 'test-key',
          model: 'test-model'
        },
        pinnedTools: ['read_text_file'],
        destructiveTools: ['write_file'],
        preconditions: {
          write_file: { requiresSecret: 'TEST_SECRET' }
        }
      };

      saveConfig(configPath, config as any);
      const loaded = loadConfig(configPath);

      assert.equal(loaded.upstreamServers[0]?.name, 'fs');
      assert.equal(loaded.llmProxy?.model, 'test-model');
      assert.ok(loaded.pinnedTools.includes('read_text_file'));
      assert.ok(loaded.destructiveTools.includes('write_file'));
      assert.equal(loaded.preconditions?.write_file?.requiresSecret, 'TEST_SECRET');
    }
  },
  {
    name: 'config: rejects malformed upstream server entries',
    async fn() {
      const { loadConfig } = await import(srcModule('src/config.ts'));
      const configPath = tempFile('config-invalid.json');
      writeJson(configPath, {
        upstreamServers: [{ command: 'node' }]
      });

      await expectRejects(() => loadConfig(configPath));
    }
  },
  {
    name: 'grouping: current seam is passthrough',
    async fn() {
      const { resolveGroupedCall } = await import(srcModule('src/grouping.ts'));
      const args = { path: 'package.json', extra: true };
      const resolved = resolveGroupedCall('read_text_file', args);

      assert.equal(resolved.resolvedToolName, 'read_text_file');
      assert.equal(resolved.resolvedArgs, args);
    }
  },
  {
    name: 'precondition gate: server status, secrets, and dependent servers',
    async fn() {
      const { passesPreconditions } = await import(srcModule('src/gates/precondition.ts'));
      const { serverStatuses } = await import(srcModule('src/upstream.ts'));

      for (const key of Object.keys(serverStatuses)) delete serverStatuses[key];
      delete process.env.TEST_GATE_SECRET;

      serverStatuses.fs = 'connected';
      serverStatuses.db = 'failed';

      assert.equal(passesPreconditions('read_text_file', 'fs', { upstreamServers: [], pinnedTools: [], destructiveTools: [] } as any), true);
      assert.equal(passesPreconditions('read_text_file', 'missing', { upstreamServers: [], pinnedTools: [], destructiveTools: [] } as any), false);

      const secretConfig = {
        upstreamServers: [],
        pinnedTools: [],
        destructiveTools: [],
        preconditions: {
          write_file: { requiresSecret: 'TEST_GATE_SECRET' },
          db_query: { requiresServer: 'db' }
        }
      } as any;

      assert.equal(passesPreconditions('write_file', 'fs', secretConfig), false);
      process.env.TEST_GATE_SECRET = 'present';
      assert.equal(passesPreconditions('write_file', 'fs', secretConfig), true);

      assert.equal(passesPreconditions('db_query', 'fs', secretConfig), false);
      serverStatuses.db = 'connected';
      assert.equal(passesPreconditions('db_query', 'fs', secretConfig), true);
      delete process.env.TEST_GATE_SECRET;
    }
  },
  {
    name: 'catalog: injected-tool session state works in isolated database',
    async fn() {
      const { markToolInjected, isToolInjected } = await import(srcModule('src/catalog.ts'));

      assert.equal(isToolInjected('session_test_tool'), false);
      markToolInjected('session_test_tool');
      assert.equal(isToolInjected('session_test_tool'), true);
    }
  },
  {
    name: 'catalog: searchTools filters by server, threshold, and quarantine',
    async fn() {
      const catalog = await import(srcModule('src/catalog.ts'));
      const { default: Database } = await import('better-sqlite3');
      const sqliteVec = await import('sqlite-vec');

      const db = new Database('catalog.db');
      sqliteVec.load(db);

      const vector = new Float32Array(384);
      vector[0] = 1;
      const unrelated = new Float32Array(384);
      unrelated[1] = 1;

      db.prepare(`
        INSERT OR REPLACE INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint, is_quarantined)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'fs:read_text_file_test',
        'fs',
        'read_text_file_test',
        'Read a text file',
        JSON.stringify({ name: 'read_text_file_test', inputSchema: { type: 'object', properties: {} } }),
        'fingerprint-1',
        0
      );
      db.prepare('DELETE FROM vec_tools WHERE id = ?').run('fs:read_text_file_test');
      db.prepare('INSERT INTO vec_tools (id, embedding) VALUES (?, ?)').run('fs:read_text_file_test', Buffer.from(vector.buffer));

      db.prepare(`
        INSERT OR REPLACE INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint, is_quarantined)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'github:delete_repo_test',
        'github',
        'delete_repo_test',
        'Delete a repository',
        JSON.stringify({ name: 'delete_repo_test', inputSchema: { type: 'object', properties: {} } }),
        'fingerprint-2',
        1
      );
      db.prepare('DELETE FROM vec_tools WHERE id = ?').run('github:delete_repo_test');
      db.prepare('INSERT INTO vec_tools (id, embedding) VALUES (?, ?)').run('github:delete_repo_test', Buffer.from(vector.buffer));
      db.close();

      const results = catalog.searchTools(vector, ['fs', 'github'], 0.9, 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.tool_name, 'read_text_file_test');

      const noServerMatch = catalog.searchTools(vector, ['db'], 0.1, 10);
      assert.equal(noServerMatch.length, 0);

      const noThresholdMatch = catalog.searchTools(unrelated, ['fs'], 0.9, 10);
      assert.equal(noThresholdMatch.length, 0);
    }
  },
  {
    name: 'hallucination/schema gate: blocks uninjected calls and invalid args',
    async fn() {
      const { default: Database } = await import('better-sqlite3');
      const { activeUpstreams } = await import(srcModule('src/upstream.ts'));
      const { markToolInjected } = await import(srcModule('src/catalog.ts'));
      const { validateToolCall } = await import(srcModule('src/gates/hallucination.ts'));

      activeUpstreams.length = 0;
      activeUpstreams.push({
        name: 'fs',
        client: {} as any,
        tools: [{ name: 'schema_gate_read', description: 'Read file', inputSchema: { type: 'object' } } as any]
      });

      const db = new Database('catalog.db');
      db.prepare(`
        INSERT OR REPLACE INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint, is_quarantined)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'fs:schema_gate_read',
        'fs',
        'schema_gate_read',
        'Read file',
        JSON.stringify({
          name: 'schema_gate_read',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }),
        'fingerprint-schema-gate',
        0
      );
      db.close();

      const blocked = validateToolCall('schema_gate_read', { path: 'package.json' });
      assert.equal(blocked.allowed, false);
      assert.match(blocked.error || '', /not currently available/);

      markToolInjected('schema_gate_read');
      const invalid = validateToolCall('schema_gate_read', { path: 123 });
      assert.equal(invalid.allowed, false);
      assert.match(invalid.error || '', /Invalid arguments/);

      const valid = validateToolCall('schema_gate_read', { path: 'package.json' });
      assert.equal(valid.allowed, true);

      assert.equal(validateToolCall('request_tools', {}).allowed, true);
      assert.equal(validateToolCall('batch_call', { calls: [] }).allowed, true);
    }
  },
  {
    name: 'terminal server: lists and executes safe command over MCP stdio',
    async fn() {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          path.join(repoRoot, 'src', 'terminal-server.ts')
        ],
        env: process.env as Record<string, string>
      });
      const client = new Client({ name: 'terminal-test', version: '1.0.0' }, { capabilities: {} });

      try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool: any) => tool.name), ['run_terminal_command']);

        const missing = await client.callTool({ name: 'run_terminal_command', arguments: {} });
        assert.equal(missing.isError, true);

        const quotedNode = `"${process.execPath}"`;
        const result = await client.callTool({
          name: 'run_terminal_command',
          arguments: { command: `${quotedNode} -e "console.log('terminal-ok')"` }
        });
        const text = (result.content as any[])?.map(part => part.text).join('\n') || '';
        assert.equal(result.isError, undefined);
        assert.match(text, /terminal-ok/);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  },
  {
    name: 'llm proxy semantic injection with mocked embeddings',
    skip: 'Needs dependency injection or module mocking for embed()/searchTools(); current implementation calls the real local embedding model.'
  },
  {
    name: 'dashboard API hot-add upstream with mocked MCP server',
    skip: 'Needs exported dashboard app or injectable upstream manager to avoid binding real ports and spawning real servers.'
  },
  {
    name: 'approval gate OS dialogs',
    skip: 'Manual by design; automated tests should mock requireUserApproval() after approval.ts is dependency-injected.'
  }
];

async function runTest(test: TestCase): Promise<TestResult> {
  const start = Date.now();
  if (test.skip) {
    return { name: test.name, status: 'skipped', durationMs: 0, reason: test.skip };
  }

  try {
    await test.fn?.();
    return { name: test.name, status: 'passed', durationMs: Date.now() - start };
  } catch (error: any) {
    return {
      name: test.name,
      status: 'failed',
      durationMs: Date.now() - start,
      error: error?.stack || error?.message || String(error)
    };
  }
}

async function main() {
  const results: TestResult[] = [];

  console.log(`JustBetter MCP programmatic test runner`);
  console.log(`Repo: ${repoRoot}`);
  console.log(`Temp workspace: ${tempRoot}`);
  console.log('');

  for (const test of tests) {
    const result = await runTest(test);
    results.push(result);

    const label = result.status === 'passed' ? 'PASS' : result.status === 'failed' ? 'FAIL' : 'SKIP';
    const suffix = result.status === 'skipped' ? ` - ${result.reason}` : ` (${result.durationMs}ms)`;
    console.log(`[${label}] ${result.name}${suffix}`);
    if (result.error) {
      console.log(result.error.split('\n').map(line => `       ${line}`).join('\n'));
    }
  }

  const passed = results.filter(result => result.status === 'passed').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const skipped = results.filter(result => result.status === 'skipped').length;

  console.log('');
  console.log(`Summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch (error: any) {
    // catalog.ts owns a process-lifetime better-sqlite3 handle. On Windows that
    // can keep catalog.db locked until process exit. Schedule a tiny cleanup
    // process instead of turning a passing suite into a failure.
    const cleanup = spawn(
      process.execPath,
      [
        '-e',
        "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 500)",
        tempRoot
      ],
      { detached: true, stdio: 'ignore' }
    );
    cleanup.unref();
    console.log(`[INFO] Temp workspace cleanup scheduled after process exit: ${tempRoot}`);
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
