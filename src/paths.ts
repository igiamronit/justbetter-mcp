import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

/**
 * Every piece of persistent state this gateway owns (the sqlite-vec tool catalog,
 * the token log) used to be opened with a bare relative path. That silently binds
 * them to process.cwd(), which we do not control: when Claude Desktop or Cursor
 * spawns the stdio gateway, cwd is the client's own working directory, so a fresh
 * empty catalog.db gets created there and the real catalog is ignored.
 *
 * Resolution order:
 *   1. JUSTBETTER_HOME env var (used by the test runner for isolation)
 *   2. ~/.justbetter-mcp
 *
 * The package root is deliberately NOT the default. For an npm install it points
 * inside node_modules/, which is wiped on every reinstall and is not reliably
 * writable for a global install.
 */

const thisFile = fileURLToPath(import.meta.url);

// src/paths.ts -> src -> <package root>
export const PACKAGE_ROOT = path.dirname(path.dirname(thisFile));

/** The user-owned state directory. Created on first access. */
export function dataDir(): string {
  const override = process.env.JUSTBETTER_HOME;
  const dir = override ? path.resolve(override) : path.join(os.homedir(), '.justbetter-mcp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Published back so upstream servers can be pointed here with ${JUSTBETTER_HOME}.
  // Without it a config naming that placeholder would look like an unresolved credential
  // and the server would be skipped. Writing the resolved absolute path is idempotent.
  process.env.JUSTBETTER_HOME = dir;
  return dir;
}

/**
 * Absolute path to the tsx CLI this package runs under, or null if it cannot be found.
 *
 * The bundled upstream servers (terminal, websearch) are TypeScript, and the package
 * deliberately ships no build step, so starting one means running it through tsx. A config
 * saying `npx tsx src/terminal-server.ts` does not survive a real install: tsx is a nested
 * dependency whose bin is never linked onto PATH, so npx either downloads a second copy
 * from the network or fails outright. Resolving it here uses the copy already installed.
 *
 * Mirrors resolveTsx() in bin/cli.js: npm hoists tsx into the installing project's
 * node_modules, and tsx does not export "./dist/cli.mjs", so resolve the package.json it
 * does export and walk to the binary from there.
 */
export function resolveTsxPath(): string | null {
  const require_ = createRequire(import.meta.url);
  const candidates: string[] = [];
  try {
    candidates.push(path.join(path.dirname(require_.resolve('tsx/package.json')), 'dist', 'cli.mjs'));
  } catch {
    // Not resolvable from here; fall through to the checkout layout.
  }
  candidates.push(path.join(PACKAGE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

/**
 * The directory the user launched the CLI from.
 *
 * bin/cli.js records it in the environment before deliberately discarding cwd (see the
 * EBUSY note there), so once the gateway is running out of a temp directory this env var
 * is the only reliable answer. Falling back to process.cwd() keeps `npm run dev` and the
 * tests, which never go through bin/cli.js, behaving the obvious way.
 */
export function invocationCwd(): string {
  const recorded = process.env.JUSTBETTER_INVOCATION_CWD;
  return recorded ? path.resolve(recorded) : process.cwd();
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

/**
 * Locates the config file every entry point should read.
 *
 *   1. an explicit path passed on the command line
 *   2. config.json beside the package itself, which is what a git checkout has and
 *      an npm install does not (this keeps `npm run dev` working unchanged)
 *   3. ~/.justbetter-mcp/config.json, seeded from config.example.json when absent
 *
 * Step 2 is deliberately anchored to the package, not process.cwd(): the gateway is
 * no longer launched from its own directory, and picking up a config.json from
 * whatever folder the user happens to be in would spawn that folder's upstream
 * commands.
 *
 * Step 3 is what makes the gateway runnable from an arbitrary directory: without a
 * config to fall back on, loadConfig throws ENOENT and the process dies before it
 * can say why.
 */
export function resolveConfigPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);

  const local = packagePath('config.json');
  if (fs.existsSync(local)) return local;

  const home = path.join(dataDir(), 'config.json');
  if (!fs.existsSync(home)) {
    const template = packagePath('config.example.json');
    if (fs.existsSync(template)) {
      fs.copyFileSync(template, home);
      console.error(`[JustBetter] No config found. Created a starter config at:\n  ${home}\nEdit it to add your API key, then run again.`);
    }
  }
  return home;
}
