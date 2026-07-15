import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import { embed } from './embeddings.js';

export interface IndexedTool {
  id: string;
  server_name: string;
  tool_name: string;
  description: string;
  full_schema_json: string;
  fingerprint: string;
}

export interface SearchResult extends IndexedTool {
  score: number;
}

const db = new Database('catalog.db');
sqliteVec.load(db);

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

// Add column if it doesn't exist (for backward compatibility with Phase 2)
try {
  db.exec('ALTER TABLE tools ADD COLUMN is_quarantined INTEGER DEFAULT 0');
} catch (e) { /* ignore */ }

// Phase 5D: Create session_state table for cross-process concurrency
db.exec(`
  CREATE TABLE IF NOT EXISTS session_state (
    tool_name TEXT PRIMARY KEY,
    injected_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Clear stale session state on boot to enforce strict per-session hallucination gating
db.exec(`DELETE FROM session_state;`);

const insertToolStmt = db.prepare(`
  INSERT INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint, is_quarantined)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    description = excluded.description,
    full_schema_json = excluded.full_schema_json,
    fingerprint = excluded.fingerprint,
    is_quarantined = excluded.is_quarantined
`);

const insertVecStmt = db.prepare(`
  INSERT INTO vec_tools (id, embedding)
  VALUES (?, ?)
`);

export async function indexTools(serverName: string, tools: any[]) {
  const startTime = Date.now();
  let count = 0;

  for (const tool of tools) {
    const id = `${serverName}:${tool.name}`;
    const description = tool.description || '';
    const fullSchemaJson = JSON.stringify(tool);
    
    // Hash for fingerprinting
    const fingerprint = createHash('sha256').update(fullSchemaJson).digest('hex');

    // Quarantine Check
    const existingTool = db.prepare('SELECT fingerprint FROM tools WHERE id = ?').get(id) as any;
    let isQuarantined = 0;
    if (existingTool && existingTool.fingerprint !== fingerprint) {
      isQuarantined = 1;
      console.error(`\n⚠️  WARNING: Schema for tool '${tool.name}' has changed! It has been quarantined for safety.\n`);
    }

    // Generate semantic embedding vector
    const textToEmbed = `${tool.name} ${description}`;
    const vector = await embed(textToEmbed);

    // Convert Float32Array to Buffer for sqlite-vec
    const embeddingBuffer = Buffer.from(vector.buffer);

    db.transaction(() => {
      insertToolStmt.run(id, serverName, tool.name, description, fullSchemaJson, fingerprint, isQuarantined);
      // Remove old vector to avoid constraint failure
      db.prepare('DELETE FROM vec_tools WHERE id = ?').run(id);
      insertVecStmt.run(id, embeddingBuffer);
    })();
    count++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.error(`Indexed ${count} tools from ${serverName} in ${duration}s`);
}

/**
 * Searches the catalog for tools that match the query intent.
 * Implements Dynamic Thresholding: retrieves a wide topK, but strictly filters
 * out any tools that fall below the semantic similarity threshold.
 * Quarantined tools are completely ignored.
 */
export function searchTools(queryVector: Float32Array, connectedServers: string[], threshold: number = 0.28, topK: number = 15): SearchResult[] {
  if (connectedServers.length === 0) return [];
  const queryBuffer = Buffer.from(queryVector.buffer);
  const placeholders = connectedServers.map(() => '?').join(',');
  
  // vec_distance_cosine returns cosine distance (0 means identical, 2 means completely opposite).
  // Similarity is (1 - distance).
  const results = db.prepare(`
    SELECT t.*, (1.0 - vec_distance_cosine(v.embedding, ?)) as score
    FROM vec_tools v
    JOIN tools t ON v.id = t.id
    WHERE t.is_quarantined = 0 AND t.server_name IN (${placeholders})
    ORDER BY score DESC
    LIMIT ?
  `).all(queryBuffer, ...connectedServers, topK) as any[];

  // Dynamic Threshold Filter
  return results
    .filter(r => r.score >= threshold)
    .map(r => ({
      id: r.id,
      server_name: r.server_name,
      tool_name: r.tool_name,
      description: r.description,
      full_schema_json: r.full_schema_json,
      fingerprint: r.fingerprint,
      score: r.score
    }));
}

/**
 * Look up a single tool by its tool_name (e.g., "read_file").
 * Used for pinned tool injection.
 */
export function getToolByName(toolName: string, connectedServers: string[]): IndexedTool | undefined {
  if (connectedServers.length === 0) return undefined;
  const placeholders = connectedServers.map(() => '?').join(',');
  const row = db.prepare(`SELECT * FROM tools WHERE tool_name = ? AND server_name IN (${placeholders})`).get(toolName, ...connectedServers) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    server_name: row.server_name,
    tool_name: row.tool_name,
    description: row.description,
    full_schema_json: row.full_schema_json,
    fingerprint: row.fingerprint
  };
}

/**
 * Returns a compact summary of all indexed tools: "tool_name: first line of description"
 * Used for the summary pool system message.
 */
export function getAllToolSummaries(connectedServers: string[]): string {
  if (connectedServers.length === 0) return '';
  const placeholders = connectedServers.map(() => '?').join(',');
  const rows = db.prepare(`SELECT tool_name, description FROM tools WHERE server_name IN (${placeholders})`).all(...connectedServers) as any[];
  return rows.map(r => `- ${r.tool_name}: ${(r.description || '').split('\n')[0]}`).join('\n');
}

/**
 * Returns all indexed tools including their quarantine status.
 * Used by the Dashboard Tool Explorer.
 */
export function getAllTools(): any[] {
  return db.prepare(`SELECT * FROM tools ORDER BY server_name ASC, tool_name ASC`).all();
}

/**
 * Approves a quarantined tool by updating its stored fingerprint and unsetting the is_quarantined flag.
 */
export function clearQuarantine(toolName: string, newFingerprint: string): void {
  db.prepare(`
    UPDATE tools 
    SET is_quarantined = 0, fingerprint = ? 
    WHERE tool_name = ?
  `).run(newFingerprint, toolName);
}

// ============================================================================
// Phase 5D: Hallucination Gate State (Cross-Process Concurrency)
// ============================================================================

const markInjectedStmt = db.prepare(`
  INSERT INTO session_state (tool_name, injected_at)
  VALUES (?, CURRENT_TIMESTAMP)
  ON CONFLICT(tool_name) DO UPDATE SET
    injected_at = CURRENT_TIMESTAMP
`);

export function markToolInjected(toolName: string) {
  markInjectedStmt.run(toolName);
}

const checkInjectedStmt = db.prepare(`
  SELECT 1 FROM session_state 
  WHERE tool_name = ? 
  -- Trust expires after 1 hour to prevent stale state bleed across concurrent processes
  AND injected_at >= datetime('now', '-1 hour')
`);

export function isToolInjected(toolName: string): boolean {
  return checkInjectedStmt.get(toolName) !== undefined;
}
