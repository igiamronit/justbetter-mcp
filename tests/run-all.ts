import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// Keep stateful modules isolated from the user's real repository database.
// JUSTBETTER_HOME is what src/paths.ts honours, and it must be set before any src
// module is imported because catalog.ts opens its database at module load.
process.env.JUSTBETTER_HOME = tempRoot;
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

      const { CATALOG_DB_PATH } = await import(srcModule('src/paths.ts'));
      const db = new Database(CATALOG_DB_PATH());
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

      // Signature: (queryVector, connectedServers, excludedTools, threshold, topK)
      const results = catalog.searchTools(vector, ['fs', 'github'], [], 0.9, 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.tool_name, 'read_text_file_test');

      const noServerMatch = catalog.searchTools(vector, ['db'], [], 0.1, 10);
      assert.equal(noServerMatch.length, 0);

      const noThresholdMatch = catalog.searchTools(unrelated, ['fs'], [], 0.9, 10);
      assert.equal(noThresholdMatch.length, 0);

      const excluded = catalog.searchTools(vector, ['fs', 'github'], ['read_text_file_test'], 0.9, 10);
      assert.equal(excluded.length, 0);

      // A threshold passed where the exclusion list belongs used to be spread into the
      // SQL parameters and blow up deep inside better-sqlite3.
      assert.throws(() => catalog.searchTools(vector, ['fs'], 0.9 as any, 10), /excludedTools must be an array/);
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

      const { CATALOG_DB_PATH } = await import(srcModule('src/paths.ts'));
      const db = new Database(CATALOG_DB_PATH());
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

      const config = { pinnedTools: [], destructiveTools: [] };

      const blocked = validateToolCall('schema_gate_read', { path: 'package.json' }, config);
      assert.equal(blocked.allowed, false);
      assert.match(blocked.error || '', /not currently available/);

      // A missing config must not throw; the gate still has to reach a verdict.
      assert.equal(validateToolCall('schema_gate_read', { path: 'package.json' }).allowed, false);

      markToolInjected('schema_gate_read');
      const invalid = validateToolCall('schema_gate_read', { path: 123 }, config);
      assert.equal(invalid.allowed, false);
      assert.match(invalid.error || '', /Invalid arguments/);

      const valid = validateToolCall('schema_gate_read', { path: 'package.json' }, config);
      assert.equal(valid.allowed, true);
      // The gate reports which server it validated against, so routing cannot drift.
      assert.equal(valid.tool?.server_name, 'fs');

      assert.equal(validateToolCall('request_tools', {}, config).allowed, true);
      assert.equal(validateToolCall('batch_call', { calls: [] }, config).allowed, true);
    }
  },
  {
    name: 'hallucination gate: pinned tools stay callable without a per-turn injection',
    async fn() {
      const { default: Database } = await import('better-sqlite3');
      const { activeUpstreams } = await import(srcModule('src/upstream.ts'));
      const { validateToolCall } = await import(srcModule('src/gates/hallucination.ts'));
      const { CATALOG_DB_PATH } = await import(srcModule('src/paths.ts'));

      activeUpstreams.length = 0;
      activeUpstreams.push({
        name: 'fs',
        client: {} as any,
        tools: [{ name: 'pinned_gate_read', description: 'Read file', inputSchema: { type: 'object' } } as any]
      });

      const db = new Database(CATALOG_DB_PATH());
      db.prepare(`
        INSERT OR REPLACE INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint, approved_fingerprint, is_quarantined)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'fs:pinned_gate_read', 'fs', 'pinned_gate_read', 'Read file',
        JSON.stringify({ name: 'pinned_gate_read', inputSchema: { type: 'object', properties: {} } }),
        'fp-pinned', 'fp-pinned', 0
      );
      db.close();

      // Mode 2 never lists pinned tools and never marks them injected. Gating them on a
      // per-turn injection record made the core filesystem/terminal tools permanently
      // uncallable from Claude Desktop and Cursor.
      const unpinned = validateToolCall('pinned_gate_read', {}, { pinnedTools: [] });
      assert.equal(unpinned.allowed, false);

      const pinned = validateToolCall('pinned_gate_read', {}, { pinnedTools: ['pinned_gate_read'] });
      assert.equal(pinned.allowed, true);
    }
  },
  {
    name: 'catalog: quarantine survives a re-index and only a real approval clears it',
    async fn() {
      const catalog = await import(srcModule('src/catalog.ts'));

      const v1 = [{ name: 'drift_tool', description: 'Original', inputSchema: { type: 'object', properties: {} } }];
      const v2 = [{ name: 'drift_tool', description: 'Changed upstream', inputSchema: { type: 'object', properties: { danger: { type: 'string' } } } }];

      await catalog.indexTools('drift', v1);
      assert.equal(catalog.getToolByName('drift_tool', ['drift'])?.tool_name, 'drift_tool');

      // Upstream changes the schema: the tool is quarantined and disappears from search.
      await catalog.indexTools('drift', v2);
      assert.equal(catalog.getToolByName('drift_tool', ['drift']), undefined);

      // Re-indexing again (a gateway restart) must NOT silently clear the quarantine.
      await catalog.indexTools('drift', v2);
      assert.equal(catalog.getToolByName('drift_tool', ['drift']), undefined);

      // Approval recomputes the fingerprint server-side and restores the tool.
      const approval = catalog.clearQuarantine('drift_tool', 'drift');
      assert.equal(approval.approved, true);
      assert.equal(typeof approval.fingerprint, 'string');
      assert.equal(catalog.getToolByName('drift_tool', ['drift'])?.tool_name, 'drift_tool');

      // And it stays cleared once the approved schema is what upstream advertises.
      await catalog.indexTools('drift', v2);
      assert.equal(catalog.getToolByName('drift_tool', ['drift'])?.tool_name, 'drift_tool');
    }
  },
  {
    name: 'agent-common: pruneMessages keeps assistant tool_calls with their results',
    async fn() {
      const { pruneMessages } = await import(srcModule('src/agent-common.ts'));

      const messages = [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'x'.repeat(400) },
        { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'y'.repeat(400) },
        { role: 'user', content: 'latest question' }
      ];

      const pruned = pruneMessages(messages, 200);

      assert.equal(pruned[0]?.role, 'system');
      assert.equal(pruned.at(-1)?.content, 'latest question');

      // No tool result may survive without the assistant turn that requested it.
      const toolIds = pruned.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id);
      const callIds = pruned
        .filter((m: any) => Array.isArray(m.tool_calls))
        .flatMap((m: any) => m.tool_calls.map((c: any) => c.id));
      for (const id of toolIds) {
        assert.ok(callIds.includes(id), `orphaned tool result ${id}`);
      }
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
    name: 'upstream: workspace tokens expand to the user folders, not the install directory',
    async fn() {
      const { resolveServerArgs } = await import(srcModule('src/upstream.ts'));
      const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

      const fsArgs = ['-y', '@modelcontextprotocol/server-filesystem', '.'];

      // The bug this guards: "." used to resolve against the package root, so a global
      // install confined the agent to node_modules/justbetter-mcp and every file
      // operation on the user's own project failed.
      const scoped = resolveServerArgs(fsArgs, [path.join(tempRoot, 'project')]);
      assert.equal(scoped.length, 3);
      assert.ok(samePath(scoped[2], path.join(tempRoot, 'project')), scoped[2]);
      assert.ok(!scoped[2].includes('node_modules'), scoped[2]);

      process.env.JUSTBETTER_INVOCATION_CWD = path.join(tempRoot, 'launched-here');
      const fallback = resolveServerArgs(fsArgs, []);
      assert.ok(samePath(fallback[2], path.join(tempRoot, 'launched-here')), fallback[2]);
      delete process.env.JUSTBETTER_INVOCATION_CWD;

      // One placeholder grants access to every configured folder.
      const many = resolveServerArgs(['-y', 'srv', '${JUSTBETTER_WORKSPACE}'], [tempRoot, testsDir]);
      assert.equal(many.length, 4);

      // Package-relative script args must still resolve against the installation.
      const script = resolveServerArgs(['tsx', 'src/terminal-server.ts'], [tempRoot]);
      assert.ok(samePath(script[1], path.join(repoRoot, 'src/terminal-server.ts')), script[1]);

      // Flags, absolute paths and bare package names are left alone.
      assert.deepEqual(
        resolveServerArgs(['-y', '@modelcontextprotocol/server-github'], [tempRoot]),
        ['-y', '@modelcontextprotocol/server-github']
      );
    }
  },
  {
    name: 'tui: setup wizard verifies the key, switches provider cleanly, and scopes the folder',
    async fn() {
      const React = (await import('react')).default;
      const { render } = await import('ink');
      const { PassThrough } = await import('node:stream');
      const { EventEmitter } = await import('node:events');
      const { readFileSync } = await import('node:fs');

      const projectDir = tempFile('wizard-project');
      mkdirSync(projectDir, { recursive: true });
      const wizardConfig = tempFile('wizard-config.json');
      writeJson(wizardConfig, {
        apiProvider: 'gemini',
        allowedDirectories: [],
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'YOUR-GEMINI-API-KEY', model: 'gemini-2.0-flash' }
      });

      // tui.tsx resolves its config path and reads the file at import time, so both the
      // argv slot and the no-autostart opt-out have to be in place before the import.
      const savedArgv = process.argv;
      const savedFetch = globalThis.fetch;
      process.argv = [savedArgv[0]!, 'test-harness', wizardConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';
      process.env.JUSTBETTER_INVOCATION_CWD = projectDir;

      const GOOD_KEY = 'sk-good-key-123456';
      const attempted: string[] = [];
      globalThis.fetch = (async (url: any, init: any) => {
        const auth = String(init?.headers?.Authorization ?? '');
        attempted.push(String(url));
        const ok = auth === `Bearer ${GOOD_KEY}` || auth === 'Bearer sk-new-mistral';
        return { ok, status: ok ? 200 : 401, text: async () => '', json: async () => ({}) };
      }) as any;

      const stripAnsi = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');

      function mountWizard(SetupWizard: any, withCancel: boolean) {
        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 100;
        stdout.rows = 30;
        // Ink emits one frame as several writes wrapped in synchronized-output markers.
        let buffer = '';
        stdout.write = (chunk: any) => {
          const text = String(chunk);
          if (text.includes('\u001B[?2026h')) buffer = '';
          buffer += text;
          return true;
        };

        const state: any = { completed: null, cancelled: false };
        const props: any = { onComplete: (summary: string[]) => { state.completed = summary; } };
        if (withCancel) props.onCancel = () => { state.cancelled = true; };

        const app = render(React.createElement(SetupWizard, props), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });
        return { app, stdin, state, frame: () => stripAnsi(buffer) };
      }

      const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      // Control keys must arrive one write at a time: ink parses a multi-character chunk
      // as a paste and inserts it literally instead of acting on it.
      const press = async (stdin: any, sequence: string, times = 1, ms = 30) => {
        for (let i = 0; i < times; i++) { stdin.write(sequence); await wait(ms); }
      };
      const ENTER = '\r';
      const DOWN = '\u001B[B';
      const BACKSPACE = '\u007F';

      try {
        const { SetupWizard } = await import(srcModule('src/tui.tsx'));

        // --- a wrong key must not be accepted, and must not be a dead end ---
        const first = mountWizard(SetupWizard, false);
        await wait(150);
        assert.ok(first.frame().includes('Which API provider'), 'expected the provider step');
        assert.ok(/>\s*1\. Google Gemini/.test(first.frame()), 'expected Gemini highlighted by default');
        assert.ok(!first.frame().includes('Esc to cancel'), 'a first run has nothing to cancel back to');

        await press(first.stdin, ENTER, 1, 120);
        assert.ok(first.frame().includes('Paste your Google Gemini API key'), first.frame());

        first.stdin.write('sk-typo');
        await wait(80);
        assert.ok(!first.frame().includes('sk-typo'), 'the key must be masked');

        await press(first.stdin, ENTER, 1, 350);
        assert.ok(first.frame().includes('Paste your Google Gemini API key'), 'a rejected key must keep you on the key step');
        assert.ok(/rejected that key \(HTTP 401\)/.test(first.frame()), first.frame());
        assert.ok(attempted.some(url => url.includes('/models')), 'the key should have been checked against the provider');

        await press(first.stdin, BACKSPACE, 12);
        first.stdin.write(GOOD_KEY);
        await wait(80);
        await press(first.stdin, ENTER, 1, 350);
        assert.ok(first.frame().includes('Which model?'), first.frame());
        assert.ok(first.frame().includes('gemini-2.0-flash'), 'the model default must match the provider');

        await press(first.stdin, ENTER, 1, 120);
        assert.ok(first.frame().includes('Which folder should the agent'), first.frame());
        assert.ok(first.frame().includes(projectDir), 'the folder must default to where the CLI was launched');

        await press(first.stdin, BACKSPACE, projectDir.length + 5, 3);
        first.stdin.write(path.join(tempRoot, 'does-not-exist'));
        await wait(80);
        await press(first.stdin, ENTER, 1, 150);
        assert.ok(first.frame().includes('No such folder'), 'a folder that does not exist must be rejected');

        await press(first.stdin, BACKSPACE, 200, 2);
        first.stdin.write(projectDir);
        await wait(80);
        await press(first.stdin, ENTER, 1, 250);
        assert.ok(first.state.completed !== null, 'the wizard should have completed');
        first.app.unmount();
        await wait(80);

        const saved = JSON.parse(readFileSync(wizardConfig, 'utf-8'));
        assert.equal(saved.apiProvider, 'gemini');
        assert.equal(saved.llmProxy.geminiApiKey, GOOD_KEY);
        assert.equal(saved.llmProxy.model, 'gemini-2.0-flash');
        assert.deepEqual(saved.allowedDirectories, [path.resolve(projectDir)]);

        // --- switching provider must bring its own model with it ---
        const second = mountWizard(SetupWizard, true);
        await wait(150);
        assert.ok(second.frame().includes('Esc to cancel'), 'a configured install must offer a way back');
        await press(second.stdin, DOWN);
        await press(second.stdin, ENTER, 1, 120);
        assert.ok(second.frame().includes('Paste your Mistral API key'), second.frame());
        assert.ok(!second.frame().includes('*'), 'the Gemini key must not be carried into the Mistral step');

        second.stdin.write('sk-new-mistral');
        await wait(80);
        await press(second.stdin, ENTER, 1, 350);
        assert.ok(second.frame().includes('mistral-large-latest'), second.frame());
        assert.ok(!second.frame().includes('gemini-2.0-flash'), 'the Gemini model must not follow the provider switch');

        await press(second.stdin, ENTER, 1, 120);
        await press(second.stdin, ENTER, 1, 250);
        assert.ok(second.state.completed !== null);
        second.app.unmount();
        await wait(80);

        const switched = JSON.parse(readFileSync(wizardConfig, 'utf-8'));
        assert.equal(switched.apiProvider, 'mistral');
        assert.equal(switched.llmProxy.model, 'mistral-large-latest');
        assert.equal(switched.llmProxy.mistralApiKey, 'sk-new-mistral');
        assert.equal(switched.llmProxy.geminiApiKey, GOOD_KEY, 'the other provider key must survive');

        // --- Esc must back out without touching the file ---
        const snapshot = readFileSync(wizardConfig, 'utf-8');
        const third = mountWizard(SetupWizard, true);
        await wait(150);
        third.stdin.write('\u001B');
        await wait(200);
        assert.equal(third.state.cancelled, true, 'Esc should cancel');
        assert.equal(readFileSync(wizardConfig, 'utf-8'), snapshot, 'Esc must not change the config');
        third.app.unmount();
        await wait(80);
      } finally {
        process.argv = savedArgv;
        globalThis.fetch = savedFetch;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
        delete process.env.JUSTBETTER_INVOCATION_CWD;
      }
    }
  },
  {
    name: 'tui: quiet mode hides tool traffic but never failures, and / lists the commands',
    async fn() {
      const savedArgv = process.argv;
      const quietConfig = tempFile('quiet-config.json');
      writeJson(quietConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', quietConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { renderEventsToLines, matchingCommands } = await import(srcModule('src/tui.tsx'));

        const events = [
          { id: 'a', type: 'user', text: 'list my files' },
          { id: 'b', type: 'system', detail: true, text: '[Gateway] Auto-injected 18 tools: read_text_file, write_file' },
          { id: 'c', type: 'tool_request', name: 'list_directory', argsText: '{"path":"."}' },
          { id: 'd', type: 'tool_result', name: 'list_directory', content: 'bin\nsrc', summary: 'Returned 8 characters' },
          { id: 'e', type: 'tool_result', name: 'read_text_file', content: 'ENOENT', isError: true, summary: 'Failed' },
          { id: 'f', type: 'assistant', text: 'Here are your files.' }
        ];

        const quiet = renderEventsToLines(events, 100, new Set(), false).map((line: any) => line.text).join('\n');
        assert.ok(quiet.includes('list my files'), 'the user turn must survive');
        assert.ok(quiet.includes('Here are your files.'), 'the answer must survive');
        assert.ok(!quiet.includes('Auto-injected'), 'the injection trace is machinery');
        assert.ok(!quiet.includes('Tool request'), 'tool calls are hidden by default');
        assert.ok(!quiet.includes('list_directory'), 'successful tool traffic is hidden by default');
        assert.ok(quiet.includes('read_text_file'), 'a FAILED tool must still be shown');

        const loud = renderEventsToLines(events, 100, new Set(), true).map((line: any) => line.text).join('\n');
        assert.ok(loud.includes('Auto-injected'), 'verbose restores the injection trace');
        assert.ok(loud.includes('Tool request > list_directory'), 'verbose restores tool calls');
        assert.ok(loud.includes('read_text_file'), 'verbose still shows failures');

        // Typing "/" alone offers everything; typing more narrows it down.
        const all = matchingCommands('/').map((command: any) => command.name);
        assert.ok(all.length > 0, 'a bare slash must list commands');
        assert.ok(all.includes('/setup') && all.includes('/help'), all.join(','));

        const narrowed = matchingCommands('/con').map((command: any) => command.name);
        assert.ok(narrowed.length > 0 && narrowed.every((name: string) => name.startsWith('/con')), narrowed.join(','));

        assert.deepEqual(matchingCommands('hello'), [], 'ordinary text must not open the menu');
        assert.deepEqual(matchingCommands('/zzz'), [], 'an unknown command matches nothing');
      } finally {
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'upstream: a server whose credential never resolved is skipped, not offered',
    async fn() {
      const { connectSingleUpstream, serverStatuses, activeUpstreams } = await import(srcModule('src/upstream.ts'));
      const { passesPreconditions } = await import(srcModule('src/gates/precondition.ts'));
      const { ConfigSchema } = await import(srcModule('src/config.ts'));

      const ABSENT = 'JUSTBETTER_TEST_ABSENT_TOKEN';
      delete process.env[ABSENT];

      const before = activeUpstreams.length;
      await connectSingleUpstream({
        name: 'needs-a-token',
        // A command that would fail loudly if it were ever spawned.
        command: 'definitely-not-a-real-command',
        args: [],
        env: { SOME_TOKEN: '${' + ABSENT + '}' }
      });

      assert.equal(serverStatuses['needs-a-token'], 'skipped');
      assert.equal(activeUpstreams.length, before, 'nothing should have been spawned or registered');

      // The point of skipping: the gate then hides every tool that server would own, so
      // the model is never offered a call that can only come back as a 401.
      const config = ConfigSchema.parse({ upstreamServers: [] });
      assert.equal(passesPreconditions('create_issue', 'needs-a-token', config), false);

      // With the credential present it is treated as a normal server again.
      process.env[ABSENT] = 'token-value';
      await connectSingleUpstream({
        name: 'has-a-token',
        command: 'definitely-not-a-real-command',
        args: [],
        env: { SOME_TOKEN: '${' + ABSENT + '}' }
      });
      assert.equal(serverStatuses['has-a-token'], 'failed', 'it should have been attempted, and failed to spawn');
      delete process.env[ABSENT];
    }
  },
  {
    name: 'embeddings: the model cache lives in the state directory, not node_modules',
    async fn() {
      const { env } = await import('@huggingface/transformers');
      await import(srcModule('src/embeddings.ts'));
      const { dataPath } = await import(srcModule('src/paths.ts'));

      assert.equal(env.cacheDir, dataPath('models'));
      assert.ok(!String(env.cacheDir).includes('node_modules'),
        `npm wipes node_modules on reinstall, so the model would re-download: ${env.cacheDir}`);
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
