import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash, randomUUID } from 'crypto';
import { embed } from './embeddings.js';
import { CATALOG_DB_PATH } from './paths.js';

export interface IndexedTool {
  id: string;
  server_name: string;
  tool_name: string;
  description: string;
  full_schema_json: string;
  fingerprint: string;
  approved_fingerprint?: string;
}

export interface SearchResult extends IndexedTool {
  score: number;
}

/**
 * How long an injected tool stays callable by the hallucination gate, and how far
 * back the LLM proxy will carry schemas forward into later turns. The carry-over is
 * deliberately tighter and capped: re-injecting everything from a rolling hour makes
 * the injected set grow monotonically until it approaches the full catalog, which
 * silently collapses Mode 1 back into the inject-all baseline.
 */
export const INJECTION_TRUST_WINDOW_MINUTES = 60;
export const CARRY_OVER_WINDOW_MINUTES = 30;
export const CARRY_OVER_LIMIT = 8;

/** Identifies this gateway process so concurrent instances cannot clear each other's state. */
export const SESSION_ID = randomUUID();

const db = new Database(CATALOG_DB_PATH());
sqliteVec.load(db);

// Multiple gateway processes (Claude Desktop + Cursor + CLI) share this file.
// WAL lets readers and a writer coexist instead of tripping SQLITE_BUSY.
try {
  db.pragma('journal_mode = WAL');
} catch {
  /* WAL is unavailable on some network filesystems; the default journal still works. */
}
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    server_name TEXT,
    tool_name TEXT,
    description TEXT,
    full_schema_json TEXT,
    fingerprint TEXT,
    is_quarantined INTEGER DEFAULT 0
  );

  -- Create virtual table for sqlite-vec vector search
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_tools USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[384]
  );
`);

function tableColumns(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

// Schema migrations. These are checked explicitly rather than wrapped in a bare
// try/catch, so a genuine corruption error surfaces instead of being swallowed.
{
  const cols = tableColumns('tools');

  if (!cols.has('is_quarantined')) {
    db.exec('ALTER TABLE tools ADD COLUMN is_quarantined INTEGER DEFAULT 0');
  }

  // approved_fingerprint is the hash a human has actually accepted. `fingerprint`
  // tracks whatever upstream is currently advertising. Keeping them apart is what
  // stops a quarantine from clearing itself on the next restart.
  if (!cols.has('approved_fingerprint')) {
    db.exec('ALTER TABLE tools ADD COLUMN approved_fingerprint TEXT');
    db.exec('UPDATE tools SET approved_fingerprint = fingerprint WHERE approved_fingerprint IS NULL');
  }
}

// Session state is scoped per gateway process. The previous version cleared the whole
// table at import time, so a second gateway booting would revoke the tools a running
// gateway had already handed to its model mid-conversation.
{
  const sessionCols = tableColumns('session_state');
  if (sessionCols.size > 0 && !sessionCols.has('session_id')) {
    db.exec('DROP TABLE session_state');
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    injected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, tool_name)
  );
`);

// Drop only our own session's rows (a stale id can never collide) plus anything that
// has aged out entirely, so the table cannot grow without bound across restarts.
db.prepare('DELETE FROM session_state WHERE session_id = ?').run(SESSION_ID);
db.prepare(
  `DELETE FROM session_state WHERE injected_at < datetime('now', '-${INJECTION_TRUST_WINDOW_MINUTES} minutes')`
).run();

const insertToolStmt = db.prepare(`
  INSERT INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint, approved_fingerprint, is_quarantined)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    description = excluded.description,
    full_schema_json = excluded.full_schema_json,
    fingerprint = excluded.fingerprint,
    approved_fingerprint = excluded.approved_fingerprint,
    is_quarantined = excluded.is_quarantined
`);

const insertVecStmt = db.prepare(`
  INSERT INTO vec_tools (id, embedding)
  VALUES (?, ?)
`);

export function fingerprintOf(schemaJson: string): string {
  return createHash('sha256').update(schemaJson).digest('hex');
}

export async function indexTools(serverName: string, tools: any[]) {
  const startTime = Date.now();
  let count = 0;
  let quarantinedCount = 0;

  for (const tool of tools) {
    const id = `${serverName}:${tool.name}`;
    const description = tool.description || '';
    const fullSchemaJson = JSON.stringify(tool);

    // Hash for fingerprinting
    const fingerprint = fingerprintOf(fullSchemaJson);

    // Quarantine check. Compare against the fingerprint a human approved, never
    // against the last thing we happened to observe — otherwise the flag clears
    // itself on the next boot because we just overwrote the value we compare to.
    const existingTool = db
      .prepare('SELECT fingerprint, approved_fingerprint, is_quarantined FROM tools WHERE id = ?')
      .get(id) as any;

    let isQuarantined = 0;
    // Trust-on-first-use: the first time we ever see a tool, its schema is the baseline.
    let approvedFingerprint = fingerprint;

    if (existingTool) {
      approvedFingerprint = existingTool.approved_fingerprint ?? existingTool.fingerprint;
      if (approvedFingerprint !== fingerprint) {
        isQuarantined = 1;
        if (!existingTool.is_quarantined) {
          console.error(
            `\n⚠️  WARNING: Schema for tool '${tool.name}' (${serverName}) has changed! ` +
            `It is quarantined until approved in the dashboard.\n`
          );
        }
        quarantinedCount++;
      } else if (existingTool.is_quarantined) {
        // Upstream reverted to the approved schema; the tool is trustworthy again.
        isQuarantined = 0;
      }
    }

    // Generate semantic embedding vector
    const textToEmbed = `${tool.name} ${description}`;
    const vector = await embed(textToEmbed);

    // Convert Float32Array to Buffer for sqlite-vec
    const embeddingBuffer = Buffer.from(vector.buffer);

    db.transaction(() => {
      insertToolStmt.run(
        id, serverName, tool.name, description, fullSchemaJson,
        fingerprint, approvedFingerprint, isQuarantined
      );
      // Remove old vector to avoid constraint failure
      db.prepare('DELETE FROM vec_tools WHERE id = ?').run(id);
      insertVecStmt.run(id, embeddingBuffer);
    })();
    count++;
  }

  // Sync phase: purge orphaned tools
  const existingIds = db.prepare('SELECT id FROM tools WHERE server_name = ?').all(serverName) as {id: string}[];
  const incomingIds = new Set(tools.map(t => `${serverName}:${t.name}`));
  const orphanedIds = existingIds.filter(row => !incomingIds.has(row.id));

  if (orphanedIds.length > 0) {
    db.transaction(() => {
      const deleteVecStmt = db.prepare('DELETE FROM vec_tools WHERE id = ?');
      const deleteToolStmt = db.prepare('DELETE FROM tools WHERE id = ?');
      for (const row of orphanedIds) {
        deleteVecStmt.run(row.id);
        deleteToolStmt.run(row.id);
      }
    })();
    console.error(`Purged ${orphanedIds.length} orphaned tools for server ${serverName}`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const quarantineNote = quarantinedCount > 0 ? ` (${quarantinedCount} quarantined)` : '';
  console.error(`Indexed ${count} tools from ${serverName} in ${duration}s${quarantineNote}`);
}

function rowToTool(r: any): IndexedTool {
  return {
    id: r.id,
    server_name: r.server_name,
    tool_name: r.tool_name,
    description: r.description,
    full_schema_json: r.full_schema_json,
    fingerprint: r.fingerprint,
    approved_fingerprint: r.approved_fingerprint
  };
}

/**
 * Searches the catalog for tools that match the query intent.
 * Implements Dynamic Thresholding: retrieves a wide topK, but strictly filters
 * out any tools that fall below the semantic similarity threshold.
 * Quarantined tools are completely ignored.
 */
export function searchTools(queryVector: Float32Array, connectedServers: string[], excludedTools: string[] = [], threshold: number = 0.28, topK: number = 15): SearchResult[] {
  if (connectedServers.length === 0) return [];

  if (!Array.isArray(excludedTools)) {
    throw new TypeError(
      'searchTools(queryVector, connectedServers, excludedTools, threshold, topK): ' +
      `excludedTools must be an array of tool names, received ${typeof excludedTools}.`
    );
  }

  const queryBuffer = Buffer.from(queryVector.buffer);
  const serverPlaceholders = connectedServers.map(() => '?').join(',');

  let excludeClause = "";
  if (excludedTools.length > 0) {
    const excludePlaceholders = excludedTools.map(() => '?').join(',');
    excludeClause = `AND t.tool_name NOT IN (${excludePlaceholders})`;
  }

  // vec_distance_cosine returns cosine distance (0 means identical, 2 means completely opposite).
  // Similarity is (1 - distance).
  const results = db.prepare(`
    SELECT t.*, (1.0 - vec_distance_cosine(v.embedding, ?)) as score
    FROM vec_tools v
    JOIN tools t ON v.id = t.id
    WHERE t.is_quarantined = 0 AND t.server_name IN (${serverPlaceholders}) ${excludeClause}
    ORDER BY score DESC
    LIMIT ?
  `).all(queryBuffer, ...connectedServers, ...excludedTools, topK) as any[];

  // Dynamic Threshold Filter
  return results
    .filter(r => r.score >= threshold)
    .map(r => ({ ...rowToTool(r), score: r.score }));
}

/**
 * Look up a single tool by its tool_name (e.g., "read_file").
 * Used for pinned tool injection and for resolving a call to its owning server.
 *
 * Two upstream servers can legitimately expose the same tool name. Resolution is
 * ordered by server_name so validation and routing always agree on the same row,
 * and the ambiguity is reported rather than silently resolved by iteration order.
 */
export function getToolByName(toolName: string, connectedServers: string[], serverName?: string): IndexedTool | undefined {
  if (connectedServers.length === 0) return undefined;
  const placeholders = connectedServers.map(() => '?').join(',');

  if (serverName) {
    const row = db.prepare(
      `SELECT * FROM tools WHERE id = ? AND is_quarantined = 0 AND server_name IN (${placeholders})`
    ).get(`${serverName}:${toolName}`, ...connectedServers) as any;
    return row ? rowToTool(row) : undefined;
  }

  const rows = db.prepare(
    `SELECT * FROM tools
     WHERE tool_name = ? AND is_quarantined = 0 AND server_name IN (${placeholders})
     ORDER BY server_name ASC`
  ).all(toolName, ...connectedServers) as any[];

  if (rows.length === 0) return undefined;
  if (rows.length > 1) {
    console.error(
      `[Catalog] Ambiguous tool name '${toolName}' is exposed by ${rows.length} servers ` +
      `(${rows.map(r => r.server_name).join(', ')}). Routing to '${rows[0].server_name}'.`
    );
  }
  return rowToTool(rows[0]);
}

/**
 * Returns a compact summary of all indexed tools: "tool_name: first line of description"
 * Used for the summary pool system message.
 */
export function getAllToolSummaries(connectedServers: string[], excludedToolNames: Set<string> = new Set()): string {
  if (connectedServers.length === 0) return '';
  const placeholders = connectedServers.map(() => '?').join(',');
  // Quarantined tools are excluded: advertising a capability the gate will refuse to
  // hand over just sends the model into a request_tools loop it cannot win.
  const rows = db.prepare(
    `SELECT tool_name, description FROM tools
     WHERE is_quarantined = 0 AND server_name IN (${placeholders})
     ORDER BY tool_name ASC`
  ).all(...connectedServers) as any[];

  return rows
    .filter(r => !excludedToolNames.has(r.tool_name))
    .map(r => `- ${r.tool_name}: ${(r.description || '').split('\n')[0]}`)
    .join('\n');
}

/**
 * Returns all indexed tools including their quarantine status.
 * Used by the Dashboard Tool Explorer.
 */
export function getAllTools(): any[] {
  return db.prepare(`SELECT * FROM tools ORDER BY server_name ASC, tool_name ASC`).all();
}

/**
 * Returns all active (non-quarantined) tools from connected servers.
 * Used for full tool injection.
 */
export function getActiveTools(connectedServers: string[]): any[] {
  if (connectedServers.length === 0) return [];
  const placeholders = connectedServers.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM tools WHERE is_quarantined = 0 AND server_name IN (${placeholders})`).all(...connectedServers);
}

/**
 * Total serialized schema size of every active tool. This is what a Mode 3 style
 * inject-all request would have to carry, and it is the only honest basis for the
 * "tokens saved" figure the dashboard reports.
 */
export function getActiveSchemaBytes(connectedServers: string[]): number {
  if (connectedServers.length === 0) return 0;
  const placeholders = connectedServers.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COALESCE(SUM(LENGTH(full_schema_json)), 0) AS total
     FROM tools WHERE is_quarantined = 0 AND server_name IN (${placeholders})`
  ).get(...connectedServers) as any;
  return row?.total ?? 0;
}

/**
 * Approves a quarantined tool. The fingerprint is always recomputed server-side from
 * the schema we actually hold, so a caller cannot approve a tool by supplying an
 * arbitrary string. Scoped by server when known so same-named tools stay independent.
 */
export function clearQuarantine(toolName: string, serverName?: string): { approved: boolean; fingerprint?: string | undefined } {
  const rows = serverName
    ? db.prepare('SELECT id, full_schema_json FROM tools WHERE id = ?').all(`${serverName}:${toolName}`) as any[]
    : db.prepare('SELECT id, full_schema_json FROM tools WHERE tool_name = ?').all(toolName) as any[];

  if (rows.length === 0) return { approved: false };

  const update = db.prepare(
    'UPDATE tools SET is_quarantined = 0, approved_fingerprint = ?, fingerprint = ? WHERE id = ?'
  );

  let lastFingerprint: string | undefined;
  db.transaction(() => {
    for (const row of rows) {
      const fp = fingerprintOf(row.full_schema_json);
      update.run(fp, fp, row.id);
      lastFingerprint = fp;
    }
  })();

  return { approved: true, fingerprint: lastFingerprint };
}

// ============================================================================
// Hallucination Gate State (scoped per gateway process)
// ============================================================================

const markInjectedStmt = db.prepare(`
  INSERT INTO session_state (session_id, tool_name, injected_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(session_id, tool_name) DO UPDATE SET
    injected_at = CURRENT_TIMESTAMP
`);

export function markToolInjected(toolName: string) {
  markInjectedStmt.run(SESSION_ID, toolName);
}

const checkInjectedStmt = db.prepare(`
  SELECT 1 FROM session_state
  WHERE session_id = ? AND tool_name = ?
  -- Trust expires so a long-idle session cannot keep handing out stale authority
  AND injected_at >= datetime('now', '-${INJECTION_TRUST_WINDOW_MINUTES} minutes')
`);

export function isToolInjected(toolName: string): boolean {
  return checkInjectedStmt.get(SESSION_ID, toolName) !== undefined;
}

/**
 * Tools to carry forward into the next turn's injection, most recent first.
 *
 * Bounded on purpose. `excluded` drops names that are re-added by another path
 * (pinned tools) so they cannot consume the whole carry-over budget.
 */
export function getRecentlyInjectedTools(excluded: string[] = [], limit: number = CARRY_OVER_LIMIT): any[] {
  const excludeClause = excluded.length > 0
    ? `AND t.tool_name NOT IN (${excluded.map(() => '?').join(',')})`
    : '';

  return db.prepare(`
    SELECT t.*
    FROM session_state s
    JOIN tools t ON s.tool_name = t.tool_name
    WHERE s.session_id = ?
      AND s.injected_at >= datetime('now', '-${CARRY_OVER_WINDOW_MINUTES} minutes')
      AND t.is_quarantined = 0
      ${excludeClause}
    ORDER BY s.injected_at DESC, t.tool_name ASC
    LIMIT ?
  `).all(SESSION_ID, ...excluded, limit);
}
