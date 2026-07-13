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
    fingerprint TEXT
  );
  
  -- Create virtual table for sqlite-vec vector search
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_tools USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[384]
  );
`);

const insertToolStmt = db.prepare(`
  INSERT INTO tools (id, server_name, tool_name, description, full_schema_json, fingerprint)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    description = excluded.description,
    full_schema_json = excluded.full_schema_json,
    fingerprint = excluded.fingerprint
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

    // Generate semantic embedding vector
    const textToEmbed = `${tool.name} ${description}`;
    const vector = await embed(textToEmbed);

    // Convert Float32Array to Buffer for sqlite-vec
    const embeddingBuffer = Buffer.from(vector.buffer);

    db.transaction(() => {
      insertToolStmt.run(id, serverName, tool.name, description, fullSchemaJson, fingerprint);
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
 */
export function searchTools(queryVector: Float32Array, threshold: number = 0.28, topK: number = 15): SearchResult[] {
  const queryBuffer = Buffer.from(queryVector.buffer);
  
  // vec_distance_cosine returns cosine distance (0 means identical, 2 means completely opposite).
  // Similarity is (1 - distance).
  const results = db.prepare(`
    SELECT t.*, (1.0 - vec_distance_cosine(v.embedding, ?)) as score
    FROM vec_tools v
    JOIN tools t ON v.id = t.id
    ORDER BY score DESC
    LIMIT ?
  `).all(queryBuffer, topK) as any[];

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
