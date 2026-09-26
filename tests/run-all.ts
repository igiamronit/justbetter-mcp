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

// Glyphs and key sequences as code points, so no editor or patch can mangle an escape.
const BULLET = String.fromCharCode(0x23fa);
const BRANCH = String.fromCharCode(0x23bf);
const FAIL = String.fromCharCode(0x2717);
const BOX_TOP_LEFT = String.fromCharCode(0x256d);
const ESC = String.fromCharCode(27);
const SYNC_START = ESC + '[?2026h';
const ARROW_UP = ESC + '[A';
const ARROW_DOWN = ESC + '[B';
const ENTER_KEY = String.fromCharCode(13);
const BACKSPACE_KEY = String.fromCharCode(127);

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
    name: 'config: upstream server with url is valid, with headers is valid, with neither command nor url is rejected, with both is rejected',
    async fn() {
      const { loadConfig } = await import(srcModule('src/config.ts'));

      const validHttpPath = tempFile('config-http-valid.json');
      writeJson(validHttpPath, {
        upstreamServers: [{ name: 'http-upstream', url: 'https://example.com/mcp' }]
      });
      const httpConfig = loadConfig(validHttpPath);
      assert.equal(httpConfig.upstreamServers[0]?.url, 'https://example.com/mcp');
      assert.equal(httpConfig.upstreamServers[0]?.command, undefined);

      const validHttpHeadersPath = tempFile('config-http-headers.json');
      writeJson(validHttpHeadersPath, {
        upstreamServers: [{ name: 'http-with-headers', url: 'https://example.com/mcp', headers: { 'X-Custom': 'value' } }]
      });
      const headersConfig = loadConfig(validHttpHeadersPath);
      assert.equal(headersConfig.upstreamServers[0]?.headers?.['X-Custom'], 'value');

      const stdioPath = tempFile('config-stdio-valid.json');
      writeJson(stdioPath, {
        upstreamServers: [{ name: 'stdio-upstream', command: 'node', args: ['server.js'] }]
      });
      const stdioConfig = loadConfig(stdioPath);
      assert.equal(stdioConfig.upstreamServers[0]?.command, 'node');
      assert.equal(stdioConfig.upstreamServers[0]?.url, undefined);

      // XOR: neither command nor url → reject
      const neitherPath = tempFile('config-neither.json');
      writeJson(neitherPath, {
        upstreamServers: [{ name: 'orphan-upstream' }]
      });
      await expectRejects(() => loadConfig(neitherPath));

      // XOR: both command and url → reject
      const bothPath = tempFile('config-both.json');
      writeJson(bothPath, {
        upstreamServers: [{ name: 'both-upstream', command: 'node', url: 'https://example.com/mcp' }]
      });
      await expectRejects(() => loadConfig(bothPath));

      // Invalid URL format → reject
      const invalidUrlPath = tempFile('config-invalid-url.json');
      writeJson(invalidUrlPath, {
        upstreamServers: [{ name: 'bad-url-upstream', url: 'not-a-valid-url' }]
      });
      await expectRejects(() => loadConfig(invalidUrlPath));
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

      // A project directory with a package.json, which is what `npm test` needs to find.
      const projectDir = path.join(tempRoot, 'terminal-workspace');
      mkdirSync(projectDir, { recursive: true });
      writeJson(path.join(projectDir, 'package.json'), { name: 'probe', version: '1.0.0' });

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          path.join(repoRoot, 'src', 'terminal-server.ts'),
          projectDir
        ],
        // The gateway spawns its upstreams from a temp directory, because a process sitting
        // in the install folder makes `npm install -g` fail with EBUSY on Windows. This
        // server took no path argument, so it inherited that and every command ran in
        // %TEMP%: `npm test` failed on a missing package.json.
        cwd: os.tmpdir(),
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

        // Commands must run in the named workspace, not wherever the server was spawned.
        const cwdResult = await client.callTool({
          name: 'run_terminal_command',
          arguments: { command: `${quotedNode} -e "console.log(process.cwd())"` }
        });
        const cwdText = ((cwdResult.content as any[])?.map(part => part.text).join(' ') || '').trim();
        assert.equal(path.resolve(cwdText).toLowerCase(), path.resolve(projectDir).toLowerCase(),
          `commands must run in the workspace, ran in ${cwdText}`);

        // JUSTBETTER_WORKSPACE is the fallback for configs passing no path argument, and is
        // what the gateway now publishes to every upstream.
        const { workspaceDirs } = await import(srcModule('src/upstream.ts'));
        assert.deepEqual(workspaceDirs([projectDir]), [path.resolve(projectDir)]);
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
      // A folder saved by an earlier run, in some other project. The wizard used to prefill
      // the workspace box from the config, so this stale path came back every time and the
      // folder you were actually standing in was ignored.
      const staleDir = tempFile('wizard-somewhere-else');
      mkdirSync(staleDir, { recursive: true });
      const wizardConfig = tempFile('wizard-config.json');
      writeJson(wizardConfig, {
        apiProvider: 'gemini',
        allowedDirectories: [staleDir],
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
        // Each provider lists only its own models, as it really would. Gemini prefixes its
        // ids with "models/" and Mistral does not, so the stripping is covered here too.
        const isMistral = String(url).includes('mistral');
        return {
          ok, status: ok ? 200 : 401, text: async () => '',
          json: async () => ({ data: isMistral
            ? [{ id: 'mistral-large-latest' }, { id: 'mistral-medium-latest' }]
            : [{ id: 'models/gemini-2.0-flash' }, { id: 'models/gemini-2.5-flash' }] })
        };
      }) as any;

      const stripAnsi = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');

      // Unmounted in the finally below even when an assertion throws.
      const mounted: any[] = [];

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
        mounted.push(app);
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

        await press(first.stdin, ENTER, 1, 250);
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
        // The step lists what the provider will actually accept, with the "models/" prefix
        // stripped so it matches what gets typed and what the config stores.
        assert.ok(first.frame().includes('gemini-2.5-flash'), 'the available models must be offered: ' + first.frame());
        assert.ok(!first.frame().includes('models/gemini'), 'the "models/" prefix must be stripped: ' + first.frame());

        // A model the provider does not have was accepted, saved and applied without a word,
        // and only the next message revealed it -- as an opaque 400 from the provider, long
        // after the setup that caused it.
        await press(first.stdin, BACKSPACE, 24, 3);
        first.stdin.write('gemini-3.8-flash');
        await wait(80);
        await press(first.stdin, ENTER, 1, 250);
        assert.ok(/no model called/.test(first.frame()),
          'a model the provider does not have must be refused: ' + first.frame());
        assert.ok(first.frame().includes('Which model?'), 'a refused model must keep you on the model step');

        await press(first.stdin, BACKSPACE, 24, 3);
        first.stdin.write('gemini-2.0-flash');
        await wait(80);
        await press(first.stdin, ENTER, 1, 200);
        assert.ok(first.frame().includes('Which folder should the agent'), first.frame());
        assert.ok(first.frame().includes(projectDir), 'the folder must default to where the CLI was launched');
        assert.ok(!first.frame().includes(staleDir),
          'the folder saved by an earlier run must not be prefilled: ' + first.frame());

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
        for (const app of mounted) {
          try { app.unmount(); } catch { /* already gone */ }
        }
        await wait(80);
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
        assert.ok(!quiet.includes('list_directory('), 'tool calls are hidden by default');
        assert.ok(!quiet.includes('list_directory'), 'successful tool traffic is hidden by default');
        assert.ok(quiet.includes('read_text_file'), 'a FAILED tool must still be shown');

        const loud = renderEventsToLines(events, 100, new Set(), true).map((line: any) => line.text).join('\n');
        assert.ok(loud.includes('Auto-injected'), 'verbose restores the injection trace');
        assert.ok(loud.includes('list_directory(.)'), 'verbose restores tool calls, with the argument that identifies them');
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
    name: 'tui theme: degrades to single-byte glyphs and drops colour on request',
    async fn() {
      const { resolveTheme, themeFromEnvironment, style, isNarrow, NARROW_COLUMNS } =
        await import(srcModule('src/tui/theme.ts'));

      const rich = resolveTheme({ columns: 100 });
      assert.equal(rich.color, true);
      assert.equal(rich.unicode, true);
      assert.deepEqual(style(rich, 'accent'), { color: 'cyan' });
      assert.deepEqual(style(rich, 'failure'), { color: 'red' });
      // Conversation text is deliberately unstyled so it stands out from dimmed machinery.
      assert.deepEqual(style(rich, 'conversation'), {});

      const plain = resolveTheme({ columns: 100, noColor: true, ascii: true });
      assert.equal(plain.color, false);
      assert.equal(plain.unicode, false);
      // Without colour, bold is the only way left to mark a failure.
      assert.deepEqual(style(plain, 'failure'), { bold: true });
      assert.deepEqual(style(plain, 'accent'), {});

      // Every fallback glyph must be one column wide, or wrapping shifts with the mode.
      for (const [name, glyph] of Object.entries(plain.glyph)) {
        assert.equal(String(glyph).length, 1, name + ' fallback must be one column, got ' + glyph);
      }

      // NO_COLOR is honoured by presence, per the convention.
      assert.equal(themeFromEnvironment(80, { NO_COLOR: '1' }).color, false);
      assert.equal(themeFromEnvironment(80, { NO_COLOR: '' }).color, true);
      assert.equal(themeFromEnvironment(80, {}).color, true);
      assert.equal(themeFromEnvironment(80, { JUSTBETTER_ASCII: '1' }).unicode, false);

      assert.equal(isNarrow(resolveTheme({ columns: NARROW_COLUMNS - 1 })), true);
      assert.equal(isNarrow(resolveTheme({ columns: NARROW_COLUMNS })), false);
    }
  },
  {
    name: 'tui render: marker vocabulary, argument summaries, and a failure always names its tool',
    async fn() {
      const { renderEventsToLines, renderEventLines, summariseArgs } =
        await import(srcModule('src/tui/render.ts'));
      const { resolveTheme } = await import(srcModule('src/tui/theme.ts'));
      const theme = resolveTheme({ columns: 78 });

      // A pretty-printed JSON blob per call is what made the old transcript unreadable.
      assert.equal(summariseArgs('{"path":"hello.py"}', 40), 'hello.py');
      assert.equal(summariseArgs('{"command":"python hello.py"}', 40), 'python hello.py');
      assert.equal(summariseArgs('{"limit":5}', 40), 'limit');
      assert.equal(summariseArgs(undefined, 40), '');
      assert.equal(summariseArgs('not json at all', 40), 'not json at all');

      const events: any[] = [
        { id: '1', type: 'user', text: 'run it' },
        { id: '2', type: 'tool_request', name: 'run_terminal_command', argsText: '{"command":"python hello.py"}' },
        { id: '3', type: 'tool_result', name: 'run_terminal_command', content: 'hi', summary: '1 line' },
        { id: '4', type: 'tool_result', name: 'write_file', content: 'EACCES', isError: true, summary: 'Failed' },
        { id: '5', type: 'assistant', text: 'Done.' }
      ];

      const loud = renderEventsToLines(events, 78, new Set(), true, theme).map((l: any) => l.text).join('\n');
      assert.ok(loud.includes('run_terminal_command(python hello.py)'), loud);
      assert.ok(loud.includes(BRANCH + ' 1 line'), loud);
      assert.ok(loud.includes(BULLET + ' Done.'), loud);

      // In quiet mode the call line above a failure is hidden, so the failure line itself
      // has to say which tool broke or there is nothing to act on.
      const quiet = renderEventsToLines(events, 78, new Set(), false, theme).map((l: any) => l.text).join('\n');
      assert.ok(quiet.includes(FAIL + ' write_file'), 'a failure must name its tool: ' + quiet);
      assert.ok(!quiet.includes('run_terminal_command'), 'successful tool traffic stays hidden');

      // renderEventLines is what Static commits, one event at a time. It must not emit the
      // "type a message" placeholder, or every hidden event would print it.
      assert.deepEqual(renderEventLines(events[1], 78, false, false, theme), []);
      assert.ok(renderEventLines(events[4], 78, false, false, theme).length > 0);

      const ascii = renderEventsToLines(events, 78, new Set(), true, resolveTheme({ columns: 78, ascii: true }))
        .map((l: any) => l.text).join('\n');
      assert.ok(ascii.includes('* run_terminal_command'), ascii);
      assert.ok(!ascii.includes(BULLET) && !ascii.includes(BRANCH) && !ascii.includes(FAIL),
        'the ascii theme must emit no box-drawing glyphs');
    }
  },
  {
    name: 'tui app: bordered input, slash-menu selection, command history, and no double-printing',
    async fn() {
      const savedArgv = process.argv;
      const appConfig = tempFile('app-config.json');
      writeJson(appConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', appConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 92;
        stdout.rows = 30;
        let frameBuffer = '';
        // Everything ever written, so a transcript printed twice is detectable. Static
        // re-printing its items is the classic ink bug and is invisible in a single frame.
        let allOutput = '';
        stdout.write = (chunk: any) => {
          const text = String(chunk);
          if (text.includes(SYNC_START)) frameBuffer = '';
          frameBuffer += text;
          allOutput += text;
          return true;
        };

        const strip = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        // One write per key: ink reads a multi-character chunk as a paste.
        const press = async (sequence: string) => { stdin.write(sequence); await wait(70); };

        const app = render(React.createElement(App, { mcpClient: null }), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });

        try {
          await wait(250);
          assert.ok(strip(frameBuffer).includes(BOX_TOP_LEFT), 'the input must sit inside a border');
          // The model name comes from whichever config was loaded at first import of
          // session.ts, which is test-order dependent, so the stable items are asserted.
          assert.ok(strip(frameBuffer).includes('/ for commands'), 'the hint line offers the command menu');
          assert.ok(strip(frameBuffer).includes('ctrl+c twice to exit'), 'the hint line says how to leave');

          // Typing "/" opens the menu with the first row marked.
          await press('/');
          await wait(150);
          let frame = strip(frameBuffer);
          assert.ok(frame.includes('/help'), frame);
          assert.match(frame, />\s+\/help/, 'the first suggestion must be selected');

          // Arrow keys move the selection rather than scrolling anything.
          await press(ARROW_DOWN);
          await wait(150);
          frame = strip(frameBuffer);
          assert.match(frame, />\s+\/setup/, 'down must move the selection');

          // Submit a command, then recall it from history with Up on an empty line.
          for (const character of 'help') await press(character);
          await press(ENTER_KEY);
          await wait(300);
          assert.ok(strip(frameBuffer).includes('Commands'), 'the /help output must reach the transcript');

          await press(ARROW_UP);
          await wait(150);
          assert.ok(strip(frameBuffer).includes('/help'), 'up must recall the last submission');

          // Committed output must not be re-printed. Ink re-prints a Static item whenever
          // its key changes, which silently duplicates the whole conversation -- and it is
          // invisible in any single frame. Counting a phrase that appears only in the /help
          // output (not in the menu descriptions, which legitimately repaint) and then
          // forcing several repaints isolates a Static re-print from ordinary redrawing.
          const countHelp = () => strip(allOutput).split('this list').length - 1;
          const afterCommit = countHelp();
          assert.ok(afterCommit >= 1, 'the /help output should have been printed once');
          for (const character of 'abcde') await press(character);
          await wait(200);
          assert.equal(countHelp(), afterCommit,
            'repainting the live region re-printed committed output: ' + afterCommit + ' -> ' + countHelp());
        } finally {
          app.unmount();
          await wait(60);
        }
      } finally {
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'tui app: Esc interrupts a running turn and keeps what already happened',
    async fn() {
      const savedArgv = process.argv;
      const savedFetch = globalThis.fetch;
      const abortConfig = tempFile('abort-config.json');
      writeJson(abortConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', abortConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        // A model call that never answers on its own, so the only way the turn ends is the
        // abort signal. Rejecting with AbortError is what a real fetch does when cancelled.
        let sawSignal = false;
        globalThis.fetch = ((_url: any, init: any) => {
          const signal: AbortSignal | undefined = init?.signal;
          sawSignal = Boolean(signal);
          return new Promise((_resolve, reject) => {
            if (!signal) return;
            signal.addEventListener('abort', () => {
              const error: any = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          });
        }) as any;

        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 92;
        stdout.rows = 30;
        let frameBuffer = '';
        let allOutput = '';
        stdout.write = (chunk: any) => {
          const text = String(chunk);
          if (text.includes(SYNC_START)) frameBuffer = '';
          frameBuffer += text;
          allOutput += text;
          return true;
        };

        const strip = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const press = async (sequence: string) => { stdin.write(sequence); await wait(70); };

        // The loop only runs with a client attached; it never gets as far as calling it.
        const fakeClient: any = { callTool: async () => ({ content: [] }) };
        const app = render(React.createElement(App, { mcpClient: fakeClient }), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });

        try {
          await wait(250);
          for (const character of 'hi') await press(character);
          await press(ENTER_KEY);
          await wait(300);

          // While busy the input is replaced by the working line, which says how to stop.
          const busy = strip(frameBuffer);
          assert.ok(busy.includes('esc to interrupt'), 'the working line must offer the interrupt: ' + busy);
          assert.ok(!busy.includes(BOX_TOP_LEFT), 'the input box is replaced while a turn runs');
          assert.equal(sawSignal, true, 'the model request must carry an abort signal');

          await press(ESC);
          await wait(400);

          const after = strip(frameBuffer);
          assert.ok(after.includes('Interrupted'), 'the transcript must record the interrupt: ' + after);
          // The turn ended, so the prompt comes back.
          assert.ok(after.includes(BOX_TOP_LEFT), 'the input box must return after an interrupt');
          // What the user typed is still there; an interrupt that erased history would be worse.
          // Checked against everything written rather than the newest frame: the submitted
          // line is printed once by <Static>, so by now it is scrollback, not live output.
          assert.ok(strip(allOutput).includes('hi'), 'the submitted message must survive the interrupt');
        } finally {
          app.unmount();
          await wait(60);
        }
      } finally {
        globalThis.fetch = savedFetch;
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'tui app: a message typed before the gateway is ready is not silently dropped',
    async fn() {
      const savedArgv = process.argv;
      const bootConfig = tempFile('boot-config.json');
      writeJson(bootConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', bootConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 100;
        stdout.rows = 30;
        let frameBuffer = '';
        let allOutput = '';
        stdout.write = (chunk: any) => {
          const text = String(chunk);
          if (text.includes(SYNC_START)) frameBuffer = '';
          frameBuffer += text;
          allOutput += text;
          return true;
        };

        const strip = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        // The gateway is a child process: the TUI renders and accepts input for the seconds
        // it takes to come up, and mcpClient is null for all of them. The agentic loop used
        // to be a `while (mcpClient)`, so a message sent in that window was echoed into the
        // transcript and then dropped without a word -- no reply, no error, nothing.
        const app = render(React.createElement(App, { mcpClient: null }), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });

        try {
          await wait(250);
          const message = 'are you there';
          for (const character of message) { stdin.write(character); await wait(12); }
          stdin.write(ENTER_KEY);
          await wait(400);

          const seen = strip(allOutput);
          assert.ok(seen.includes('still starting'),
            'a submit before the gateway is up must say why nothing happened: ' + seen.slice(-500));
          // Losing what someone typed is the other half of the bug.
          assert.ok(strip(frameBuffer).includes(message),
            'the unsent message must be left in the input box: ' + strip(frameBuffer));
          // It was never sent, so it must not appear as a turn in the transcript.
          const asTurn = seen.split(BULLET + ' ' + message).length - 1;
          assert.equal(asTurn, 0, 'the unsent message must not be recorded as a turn');
        } finally {
          app.unmount();
          await wait(60);
        }
      } finally {
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'tui app: Enter submits once whether the terminal sends CR, LF or CRLF',
    async fn() {
      const savedArgv = process.argv;
      const savedFetch = globalThis.fetch;
      const enterConfig = tempFile('enter-config.json');
      writeJson(enterConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', enterConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      // ink sets key.return only for a carriage return. A line feed and a CRLF are parsed as
      // a key it calls "enter", with no flag exposed for it, so ink-text-input never saw a
      // submit -- on a terminal that sends either, nothing could be sent at all. One turn
      // per press is the other half: a second handler firing as well would double-submit.
      const cases: [string, string][] = [
        ['CR', String.fromCharCode(13)],
        ['LF', String.fromCharCode(10)],
        ['CRLF', String.fromCharCode(13) + String.fromCharCode(10)]
      ];

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        for (const [label, sequence] of cases) {
          // One POST per started turn, and it never answers, so the count is exact.
          let turnsStarted = 0;
          globalThis.fetch = (() => {
            turnsStarted++;
            return new Promise(() => { /* the turn stays open; we only count starts */ });
          }) as any;

          const stdin: any = new PassThrough();
          stdin.isTTY = true;
          stdin.setRawMode = () => stdin;
          stdin.ref = () => undefined;
          stdin.unref = () => undefined;

          const stdout: any = new EventEmitter();
          stdout.isTTY = true;
          stdout.columns = 90;
          stdout.rows = 30;
          stdout.write = () => true;

          const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
          const fakeClient: any = { callTool: async () => ({ content: [] }) };
          const app = render(React.createElement(App, { mcpClient: fakeClient }), {
            stdin, stdout, exitOnCtrlC: false, patchConsole: false
          });

          try {
            await wait(250);
            for (const character of 'ping') { stdin.write(character); await wait(12); }
            stdin.write(sequence);
            await wait(400);
            assert.equal(turnsStarted, 1, `Enter as ${label} must start exactly one turn`);
          } finally {
            app.unmount();
            await wait(60);
          }
        }
      } finally {
        globalThis.fetch = savedFetch;
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'tui app: an empty model reply is reported instead of ending the turn in silence',
    async fn() {
      const savedArgv = process.argv;
      const savedFetch = globalThis.fetch;
      const emptyConfig = tempFile('empty-reply-config.json');
      writeJson(emptyConfig, {
        apiProvider: 'mistral',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', mistralApiKey: 'sk-real-key', model: 'mistral-medium-latest' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', emptyConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        // What a rate-limiting provider actually returns before it starts returning 429s: a
        // perfectly valid 200 with nothing in it. The turn used to put a "[Empty response]"
        // sentinel in the model's history, filter that sentinel out of the transcript, and
        // break -- so the message was echoed and then absolutely nothing was printed.
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '', tool_calls: [] } }] }),
          headers: { get: () => null }
        })) as any;

        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 100;
        stdout.rows = 30;
        let allOutput = '';
        stdout.write = (chunk: any) => { allOutput += String(chunk); return true; };

        const strip = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        const fakeClient: any = { callTool: async () => ({ content: [] }) };
        const app = render(React.createElement(App, { mcpClient: fakeClient }), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });

        try {
          await wait(250);
          for (const character of 'hello') { stdin.write(character); await wait(12); }
          stdin.write(ENTER_KEY);
          await wait(500);

          const seen = strip(allOutput);
          assert.ok(seen.includes('empty reply'),
            'a blank answer must be reported, not swallowed: ' + seen.slice(-500));
          // The sentinel is for the model's history only and must never reach the screen.
          assert.ok(!seen.includes('[Empty response]'),
            'the internal sentinel must not be shown to the user');
        } finally {
          app.unmount();
          await wait(60);
        }
      } finally {
        globalThis.fetch = savedFetch;
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'tui app: the submitted line is printed once, not rewritten on every repaint',
    async fn() {
      const savedArgv = process.argv;
      const savedFetch = globalThis.fetch;
      const repaintConfig = tempFile('repaint-config.json');
      writeJson(repaintConfig, {
        apiProvider: 'mistral',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', mistralApiKey: 'sk-real-key', model: 'mistral-medium-latest' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', repaintConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        // A turn that never answers, so the spinner keeps the live region repainting.
        globalThis.fetch = (() => new Promise(() => { /* never settles */ })) as any;

        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 120;
        stdout.rows = 30;
        // Only what is written from the moment the line is submitted.
        let written = '';
        let counting = false;
        stdout.write = (chunk: any) => { if (counting) written += String(chunk); return true; };

        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const fakeClient: any = { callTool: async () => ({ content: [] }) };
        const app = render(React.createElement(App, { mcpClient: fakeClient }), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });

        try {
          await wait(250);
          const message = 'hello';
          for (const character of message) { stdin.write(character); await wait(12); }
          counting = true;
          stdin.write(ENTER_KEY);
          await wait(2600);

          // The submitted line is final the moment it is sent, so it belongs in <Static>,
          // which writes each item once. It used to stay in the live region for the whole
          // turn instead, and the live region is rewritten on every spinner frame -- dozens
          // of times over a few seconds. Ink writes those frames through a throttle but
          // writes static output immediately, so a frame in flight could land after a static
          // write and leave the line behind again, turning one "hello" into several.
          const times = written.split('> ' + message).length - 1;
          assert.ok(times <= 3,
            'the submitted line must be printed once, not redrawn on every frame; it was written '
            + times + ' times');
        } finally {
          app.unmount();
          await wait(60);
        }
      } finally {
        globalThis.fetch = savedFetch;
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'proxy: a gateway left running on the port is reported, not silently used',
    async fn() {
      const { createServer } = await import('node:http');
      const { waitForOwnProxy } = await import(srcModule('src/agent-common.ts'));

      // A gateway orphaned by an earlier session: same /health, same service name, but it
      // loaded a different provider, key and model whenever it started. waitForProxy only
      // asked whether anything answered, so this was indistinguishable from a fresh start --
      // the new proxy lost the bind, every request went here, and a config set to Gemini came
      // back with Mistral's errors under a cheerful "Gateway ready."
      const orphan = createServer((req, res) => {
        if (req.url === '/health') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            status: 'ok',
            service: 'justbetter-mcp-llm-proxy',
            instance: 'a-previous-session',
            pid: 4242,
            provider: 'mistral',
            model: 'mistral-medium-latest',
            apiBase: 'https://api.mistral.ai/v1'
          }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>(resolve => orphan.listen(0, '127.0.0.1', () => resolve()));
      const port = (orphan.address() as any).port as number;
      const base = `http://127.0.0.1:${port}`;

      try {
        // Short timeout: the answer is already known, there is no point waiting 20s for it.
        const foreign = await waitForOwnProxy(base, 'the-instance-we-just-started', 1200);
        assert.equal(foreign.status, 'foreign',
          'a proxy that is not the one we started must not be accepted as ours');
        if (foreign.status === 'foreign') {
          // These are what make the message actionable: which process to kill, and what it is
          // actually serving, which is the part that explains the confusing provider errors.
          assert.equal(foreign.pid, 4242);
          assert.equal(foreign.provider, 'mistral');
          assert.equal(foreign.model, 'mistral-medium-latest');
          assert.equal(foreign.service, 'justbetter-mcp-llm-proxy');
        }

        // The same endpoint, asked for the token it is actually carrying, is ours.
        const ours = await waitForOwnProxy(base, 'a-previous-session', 1200);
        assert.equal(ours.status, 'ours', 'a matching instance token must be accepted');
        if (ours.status === 'ours') assert.equal(ours.provider, 'mistral');

        // Nothing listening at all is a third, different outcome, and must not be reported as
        // somebody else's proxy.
        await new Promise<void>(resolve => orphan.close(() => resolve()));
        const absent = await waitForOwnProxy(base, 'anything', 700);
        assert.equal(absent.status, 'absent');
      } finally {
        try { orphan.close(); } catch { /* already closed */ }
      }
    }
  },
  {
    name: 'tui: the gateway cannot write over the TUI, and every log channel is silenced',
    async fn() {
      const savedArgv = process.argv;
      const stderrConfig = tempFile('gateway-stderr-config.json');
      writeJson(stderrConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', stderrConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { gatewayTransportOptions } = await import(srcModule('src/tui.tsx'));
        const options = gatewayTransportOptions();

        // The MCP SDK spawns with `stdio: ['pipe', 'pipe', params.stderr ?? 'inherit']`, so
        // leaving this unset hands the gateway a direct write to the terminal the TUI is
        // drawing on. Anything it printed landed inside ink's live region and pushed the
        // cursor down, stranding the frame already there -- a leftover "Thinking" line per
        // gateway message. Capturing the stream is what makes that structurally impossible.
        assert.equal(options.stderr, 'pipe',
          "the gateway's stderr must be captured, never inherited onto the TUI's terminal");
        assert.equal(options.env.SILENCE_LOGS, '1', 'the gateway must be told to stay quiet');

        // Belt and braces: the quiet switch has to cover every channel that reaches stderr.
        // It silenced log and error but not warn, and the rate-limit retry notice in
        // fetch-retry.ts is a console.warn -- so the one message that fired during a
        // rate-limited turn was the one that got through.
        const { readFileSync } = await import('node:fs');
        const proxySource = readFileSync(path.join(repoRoot, 'src', 'proxy.ts'), 'utf-8');
        const silenced = proxySource.slice(
          proxySource.indexOf('SILENCE_LOGS'),
          proxySource.indexOf('REQUEST_TOOLS_MCP_SCHEMA')
        );
        for (const channel of ['log', 'error', 'warn', 'info', 'debug']) {
          assert.ok(silenced.includes(`console.${channel} = () => {}`),
            `console.${channel} must be silenced under the TUI, or it writes over the live region`);
        }
      } finally {
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'tui app: a bare slash never reaches the model',
    async fn() {
      const savedArgv = process.argv;
      const savedFetch = globalThis.fetch;
      const slashConfig = tempFile('slash-config.json');
      writeJson(slashConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', slashConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        // Any model call at all is the bug: "/" and "/nonsense" are for the TUI to answer.
        let modelCalls = 0;
        globalThis.fetch = ((..._args: any[]) => {
          modelCalls++;
          return new Promise(() => { /* never settles; the turn would hang visibly */ });
        }) as any;

        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 92;
        stdout.rows = 30;
        let frameBuffer = '';
        let allOutput = '';
        stdout.write = (chunk: any) => {
          const text = String(chunk);
          if (text.includes(SYNC_START)) frameBuffer = '';
          frameBuffer += text;
          allOutput += text;
          return true;
        };

        const strip = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const press = async (sequence: string) => { stdin.write(sequence); await wait(60); };

        const fakeClient: any = { callTool: async () => ({ content: [] }) };
        const app = render(React.createElement(App, { mcpClient: fakeClient }), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });

        try {
          await wait(250);

          // Enter on a bare "/" used to submit it as a chat message, so the gateway spent a
          // turn thinking about a slash. It must complete from the menu instead.
          await press('/');
          await press(ENTER_KEY);
          await wait(250);
          assert.equal(modelCalls, 0, 'a bare "/" must not be sent to the model');
          const completed = strip(frameBuffer);
          assert.ok(completed.includes('/help'),
            'Enter on "/" should put the highlighted command in the field: ' + completed);

          // Clear the completed command out of the field.
          for (let i = 0; i < 10; i++) await press(BACKSPACE_KEY);

          // A command that does not exist is the TUI's to answer too, not the model's.
          for (const character of '/nope') await press(character);
          await press(ENTER_KEY);
          await wait(250);
          assert.equal(modelCalls, 0, 'an unknown command must not be sent to the model');
          assert.ok(strip(allOutput).includes('Unknown command'),
            'an unknown command must say so: ' + strip(allOutput).slice(-400));

          // "/config set" with no value matched only the spaced form, so the bare command
          // fell past every branch and became a chat message. It must print its usage.
          for (const character of '/config set') await press(character);
          await press(ENTER_KEY);
          await wait(250);
          assert.equal(modelCalls, 0, '"/config set" must not be sent to the model');
          assert.ok(strip(allOutput).includes('Usage: /config set'),
            '"/config set" must print its usage: ' + strip(allOutput).slice(-400));
        } finally {
          app.unmount();
          await wait(60);
        }
      } finally {
        globalThis.fetch = savedFetch;
        process.argv = savedArgv;
        delete process.env.JUSTBETTER_TUI_NO_AUTOSTART;
      }
    }
  },
  {
    name: 'tui app: entering and leaving the wizard does not re-print the transcript',
    async fn() {
      const savedArgv = process.argv;
      const wizardConfig = tempFile('wizard-static-config.json');
      writeJson(wizardConfig, {
        apiProvider: 'gemini',
        upstreamServers: [],
        llmProxy: { enabled: true, port: 4141, host: '127.0.0.1', geminiApiKey: 'sk-real-key', model: 'gemini-2.0-flash' }
      });
      process.argv = [savedArgv[0]!, 'test-harness', wizardConfig];
      process.env.JUSTBETTER_TUI_NO_AUTOSTART = '1';

      try {
        const { App } = await import(srcModule('src/tui.tsx'));
        const { render } = await import('ink');
        const React = (await import('react')).default;
        const { PassThrough } = await import('node:stream');
        const { EventEmitter } = await import('node:events');

        const stdin: any = new PassThrough();
        stdin.isTTY = true;
        stdin.setRawMode = () => stdin;
        stdin.ref = () => undefined;
        stdin.unref = () => undefined;

        const stdout: any = new EventEmitter();
        stdout.isTTY = true;
        stdout.columns = 90;
        stdout.rows = 30;
        let allOutput = '';
        stdout.write = (chunk: any) => { allOutput += String(chunk); return true; };

        const strip = (value: string) => value.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const press = async (sequence: string) => { stdin.write(sequence); await wait(50); };
        const countHelp = () => strip(allOutput).split('this list').length - 1;

        const app = render(React.createElement(App, { mcpClient: null }), {
          stdin, stdout, exitOnCtrlC: false, patchConsole: false
        });

        try {
          await wait(250);
          for (const character of '/help') await press(character);
          await press(ENTER_KEY);
          await wait(350);
          const beforeWizard = countHelp();
          assert.ok(beforeWizard >= 1, 'the /help output should have been printed');

          // Returning <SetupWizard /> in place of the whole tree unmounted <Static>, and ink
          // re-prints every Static item when it remounts -- so leaving setup duplicated the
          // entire transcript. The wizard must be a state of the live region instead.
          for (const character of '/setup') await press(character);
          await press(ENTER_KEY);
          await wait(350);
          assert.ok(strip(allOutput).includes('JustBetter setup'), 'the wizard must be reachable');

          await press(ESC);
          await wait(400);
          assert.equal(countHelp(), beforeWizard,
            'the transcript was re-printed on return from the wizard: '
            + beforeWizard + ' -> ' + countHelp());
        } finally {
          app.unmount();
          await wait(60);
        }
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
    name: 'upstream: HTTP connection timing out is caught and reported, not hung',
    async fn() {
      const { connectSingleUpstream, serverStatuses } = await import(srcModule('src/upstream.ts'));
      const { createServer } = await import('node:http');

      // A server that accepts the TCP handshake but never sends a response
      // exercises the AbortController timeout path — the OS never aborts a
      // connected-but-stalling socket on its own.
      const server = createServer((_req, res) => {
        // Stall: write headers then go to sleep. The gateway will time out on
        // the SSE connection or on the initialize POST.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // never call res.end()
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : null;
      if (!port) throw new Error('failed to bind test server');

      try {
        const shortTimeoutMs = 2_000;
        const start = Date.now();
        await connectSingleUpstream(
          { name: 'stall-server', url: `http://127.0.0.1:${port}/mcp` },
          [],
          shortTimeoutMs
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 7_000, `timeout should fire in under 7s, took ${elapsed}ms`);
        assert.equal(serverStatuses['stall-server'], 'failed');
      } finally {
        (server as any).closeAllConnections?.();
        server.close();
        delete serverStatuses['stall-server'];
      }
    }
  },
  {
    name: 'upstream: HTTP server with missing header secret is skipped, not attempted',
    async fn() {
      const { connectSingleUpstream, serverStatuses } = await import(srcModule('src/upstream.ts'));
      const ABSENT = 'JUSTBETTER_TEST_ABSENT_HEADER_' + Date.now();
      delete process.env[ABSENT];

      await connectSingleUpstream({
        name: 'needs-header-token',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${' + ABSENT + '}' }
      });
      assert.equal(serverStatuses['needs-header-token'], 'skipped', 'server with unresolved header secret should be skipped');
      delete serverStatuses['needs-header-token'];
    }
  },
  {
    name: 'advertised: the Mode 2 surface starts empty, grows by discovery, and stays bounded',
    async fn() {
      const {
        advertiseTools, advertisedSchemas, advertisedCount, isToolAdvertised,
        clearAdvertised, ADVERTISED_LIMIT
      } = await import(srcModule('src/advertised.ts'));

      const indexed = (name: string) => ({
        id: `srv:${name}`,
        server_name: 'srv',
        tool_name: name,
        description: `does ${name}`,
        full_schema_json: JSON.stringify({
          name,
          description: `does ${name}`,
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }),
        fingerprint: `fp-${name}`
      });

      clearAdvertised();
      assert.equal(advertisedCount(), 0, 'nothing is advertised until something is discovered');

      advertiseTools([indexed('write_file')], { sticky: true });
      const added = advertiseTools([indexed('search_repositories'), indexed('create_issue')]);
      assert.deepEqual(added, ['search_repositories', 'create_issue']);

      // Re-requesting an already-advertised tool is not a new advertisement, so the
      // caller can skip a tools/list_changed that would tell the client nothing.
      assert.deepEqual(advertiseTools([indexed('create_issue')]), []);

      // The schema handed to the client has to be the real one, not a name in prose.
      const issue = advertisedSchemas().find((t: any) => t.name === 'create_issue');
      assert.deepEqual(issue?.inputSchema,
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });

      // Pinned tools lead, so the front of the list does not reshuffle on every discovery.
      assert.equal(advertisedSchemas()[0]?.name, 'write_file');

      assert.equal(isToolAdvertised('create_issue'), true);
      assert.equal(isToolAdvertised('never_found'), false);

      // An advertised set that only grows converges on the full catalog, which is the
      // dump-everything baseline this whole design exists to avoid.
      for (let i = 0; i < ADVERTISED_LIMIT + 10; i++) {
        advertiseTools([indexed(`filler_${i}`)]);
      }
      assert.ok(advertisedCount() <= ADVERTISED_LIMIT,
        `advertised surface must stay bounded, got ${advertisedCount()}`);
      assert.equal(isToolAdvertised('write_file'), true, 'pinned tools are never evicted');
      assert.equal(isToolAdvertised('search_repositories'), false, 'oldest discovery is evicted first');

      clearAdvertised();
    }
  },
  {
    name: 'hallucination gate: a tool advertised over stdio is callable without a fresh injection',
    async fn() {
      const { default: Database } = await import('better-sqlite3');
      const { activeUpstreams } = await import(srcModule('src/upstream.ts'));
      const { validateToolCall } = await import(srcModule('src/gates/hallucination.ts'));
      const { advertiseTools, clearAdvertised } = await import(srcModule('src/advertised.ts'));
      const { CATALOG_DB_PATH } = await import(srcModule('src/paths.ts'));

      activeUpstreams.length = 0;
      activeUpstreams.push({
        name: 'fs',
        client: {} as any,
        tools: [{ name: 'advertised_read', description: 'Read file', inputSchema: { type: 'object' } } as any]
      });

      const schema = JSON.stringify({
        name: 'advertised_read',
        description: 'Read file',
        inputSchema: { type: 'object', properties: {} }
      });
      const db = new Database(CATALOG_DB_PATH());
      db.prepare(`
        INSERT OR REPLACE INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint, approved_fingerprint, is_quarantined)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('fs:advertised_read', 'fs', 'advertised_read', 'Read file', schema, 'fp-adv', 'fp-adv', 0);
      db.close();

      clearAdvertised();
      const config = { pinnedTools: [], destructiveTools: [] };
      assert.equal(validateToolCall('advertised_read', {}, config).allowed, false);

      // Over stdio the advertised set is our own answer to tools/list, so it is a fact
      // about what the client holds -- not the timed guess Mode 1 has to make.
      advertiseTools([{
        id: 'fs:advertised_read',
        server_name: 'fs',
        tool_name: 'advertised_read',
        description: 'Read file',
        full_schema_json: schema,
        fingerprint: 'fp-adv'
      }]);
      assert.equal(validateToolCall('advertised_read', {}, config).allowed, true);

      clearAdvertised();
      assert.equal(validateToolCall('advertised_read', {}, config).allowed, false,
        'an evicted tool loses its authority with it');
    }
  },
  {
    name: 'config template: the shipped defaults start a terminal and resolve bundled servers',
    async fn() {
      const { readFileSync } = await import('node:fs');
      const { existsSync } = await import('node:fs');
      const {
        resolveServerArgs, resolveServerCommand, NODE_TOKEN, TSX_TOKEN
      } = await import(srcModule('src/upstream.ts'));
      const { resolveServerEnv } = await import(srcModule('src/config.ts'));
      const { dataDir } = await import(srcModule('src/paths.ts'));

      const template = JSON.parse(readFileSync(path.join(repoRoot, 'config.example.json'), 'utf-8'));
      const names = template.upstreamServers.map((s: any) => s.name);

      // Terminal access is in CORE_PINNED_TOOLS, so a template that never starts the
      // server leaves a pinned tool permanently unresolvable and the agent unable to run
      // anything -- which is exactly what shipped through 0.2.0.
      assert.ok(names.includes('terminal'),
        `the shipped template must start the terminal server, got: ${names.join(', ')}`);

      // @modelcontextprotocol/server-github is deprecated on npm and unmaintained.
      const commands = JSON.stringify(template.upstreamServers);
      assert.ok(!commands.includes('server-github'),
        'the deprecated @modelcontextprotocol/server-github must not ship as a default');

      // Every bundled server must name a file that really exists in the package, started
      // with the node+tsx already installed rather than `npx tsx`, which cannot resolve a
      // nested dependency's bin under a real install.
      const bundled = template.upstreamServers.filter(
        (s: any) => Array.isArray(s.args) && s.args.some((a: string) => a === TSX_TOKEN)
      );
      assert.ok(bundled.length >= 1, 'expected at least one bundled server in the template');

      for (const server of bundled) {
        assert.equal(server.command, NODE_TOKEN,
          `${server.name} must launch via ${NODE_TOKEN}, got ${server.command}`);
        assert.equal(resolveServerCommand(server.command), process.execPath);

        const resolved = resolveServerArgs(server.args, [tempRoot]);
        for (const arg of resolved) {
          assert.ok(!arg.includes('${'),
            `${server.name} left an unexpanded token in its args: ${arg}`);
          assert.ok(existsSync(arg),
            `${server.name} resolved to a path that does not exist: ${arg}`);
        }
      }
    }
  },
  {
    name: 'config template: ${JUSTBETTER_HOME} expands so upstream state lands in the state dir',
    async fn() {
      const { resolveServerEnv } = await import(srcModule('src/config.ts'));
      const { dataDir } = await import(srcModule('src/paths.ts'));

      // dataDir() publishes the resolved path back into the environment. Without that an
      // upstream env value naming ${JUSTBETTER_HOME} reads as an unfilled credential and
      // unresolvedSecrets() skips the server entirely.
      const dir = dataDir();
      assert.equal(process.env.JUSTBETTER_HOME, dir);

      const resolved = resolveServerEnv({ MEMORY_FILE_PATH: '${JUSTBETTER_HOME}/memory.json' });
      assert.equal(resolved?.MEMORY_FILE_PATH, `${dir}/memory.json`);
      assert.ok(!resolved?.MEMORY_FILE_PATH.includes('${'),
        'an unexpanded placeholder would make the memory server look uncredentialed and be skipped');
    }
  },
  {
    name: 'dashboard: a port clash disables the dashboard instead of killing the gateway',
    async fn() {
      const { createServer } = await import('node:http');
      const { startDashboard } = await import(srcModule('src/dashboard/server.ts'));

      // Take a port the way a leftover gateway would, then ask the dashboard for it.
      const squatter = createServer(() => {});
      await new Promise<void>(resolve => squatter.listen(0, '127.0.0.1', () => resolve()));
      const taken = (squatter.address() as any).port as number;

      // ws forwards the HTTP server's 'error' event onto the WebSocketServer as well, so
      // handling it only on the server left an unhandled duplicate -- and an unhandled
      // 'error' event throws. A dashboard port clash took the whole gateway down with
      // EADDRINUSE. An unhandled rejection or throw here fails the test.
      const configPath = tempFile('dashboard-clash.json');
      writeJson(configPath, {
        upstreamServers: [],
        dashboard: { enabled: true, port: taken, host: '127.0.0.1' },
        llmProxy: { enabled: false }
      });

      const config: any = {
        upstreamServers: [],
        dashboard: { enabled: true, port: taken, host: '127.0.0.1' },
        llmProxy: { enabled: false },
        pinnedTools: [],
        destructiveTools: []
      };

      const server = startDashboard(configPath, config);
      // Long enough for listen() to fail and the error to propagate to both emitters.
      await new Promise(resolve => setTimeout(resolve, 400));

      assert.ok(server, 'startDashboard must still return its server object');
      // Still ours, still listening: the clash did not take the other process down either.
      assert.equal(squatter.listening, true);

      try { server.close(); } catch { /* never bound */ }
      await new Promise<void>(resolve => squatter.close(() => resolve()));
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
