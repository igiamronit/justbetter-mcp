import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * Every piece of persistent state this gateway owns (the sqlite-vec tool catalog,
 * the token log) used to be opened with a bare relative path. That silently binds
 * them to process.cwd(), which we do not control: when Claude Desktop or Cursor
 * spawns the stdio gateway, cwd is the client's own working directory, so a fresh
 * empty catalog.db gets created there and the real catalog is ignored.
 *
 * Resolution order:
 *   1. JUSTBETTER_HOME env var (used by the test runner for isolation)
 *   2. the installed package root, derived from this module's own URL
 */

const thisFile = fileURLToPath(import.meta.url);

// src/paths.ts -> src -> <package root>
export const PACKAGE_ROOT = path.dirname(path.dirname(thisFile));

export function dataDir(): string {
  const override = process.env.JUSTBETTER_HOME;
  const dir = override ? path.resolve(override) : PACKAGE_ROOT;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Absolute path for a file that lives alongside the gateway's own state. */
export function dataPath(fileName: string): string {
  return path.join(dataDir(), fileName);
}

/** Absolute path for a file shipped inside the package (never the data dir). */
export function packagePath(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}

export const CATALOG_DB_PATH = () => dataPath('catalog.db');
export const TOKEN_LOG_PATH = () => dataPath('token_log.csv');
