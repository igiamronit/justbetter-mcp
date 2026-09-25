import fs from 'fs';
import path from 'path';
import { resolveConfigPath, invocationCwd } from '../paths.js';
import { isPlaceholderApiKey } from '../config.js';
import { resolveProxyUrl } from '../agent-common.js';

/**
 * Shared session state for the TUI: the config file in play, its parsed contents, and
 * the provider lookup tables.
 *
 * The path is resolved once, at first import, because every later read and write of the
 * config has to hit the same file even though the dashboard and the upstreams run with
 * their own working directories.
 *
 * `cliConfig` is a live binding. Other modules mutate its fields directly and read it
 * back; only reloadConfig() ever replaces the object, which is why that lives here
 * rather than at a call site.
 */
export const configPath = resolveConfigPath(process.argv[2]);
export let cliConfig: any = {};
try {
  cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e: any) {
  // The proxy will surface config errors if they matter at runtime.
}

/** Recomputed on demand: the setup wizard can change proxy settings at runtime. */
export const proxyUrl = () => resolveProxyUrl(cliConfig);

export const PROVIDERS = ['gemini', 'mistral'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = {
  gemini: 'Google Gemini',
  mistral: 'Mistral',
};

export const PROVIDER_KEY_FIELD: Record<Provider, string> = {
  gemini: 'geminiApiKey',
  mistral: 'mistralApiKey',
};

export const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-large-latest',
};

export const PROVIDER_KEY_URL: Record<Provider, string> = {
  gemini: 'aistudio.google.com/apikey',
  mistral: 'console.mistral.ai/api-keys',
};

/** True when the config cannot drive a chat turn yet, so the wizard runs first. */
export function configNeedsSetup(): boolean {
  return !cliConfig.llmProxy || isPlaceholderApiKey(cliConfig);
}

/** Folders the agent may touch, as configured. Empty means "wherever you ran the CLI". */
export function currentWorkspace(): string[] {
  const configured = Array.isArray(cliConfig.allowedDirectories) ? cliConfig.allowedDirectories : [];
  return configured.length > 0 ? configured : [invocationCwd()];
}

/** Accepts one path or several separated by commas, and rejects any that do not exist. */
export function parseWorkspaceInput(value: string): { dirs: string[] } | { error: string } {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return { error: 'Enter at least one folder.' };

  const dirs: string[] = [];
  for (const part of parts) {
    const resolved = path.resolve(part);
    if (!fs.existsSync(resolved)) return { error: `No such folder: ${resolved}` };
    dirs.push(resolved);
  }
  return { dirs };
}

/** Writes cliConfig back to disk. Returns an error message, or null on success. */
export function persistConfig(): string | null {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cliConfig, null, 2), 'utf-8');
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/** Replaces the parsed config from disk. The live binding means importers see the new object. */
export function reloadConfig(): void {
  cliConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/** Overwrites the config file with whatever is in memory. */
export function saveConfig(): void {
  fs.writeFileSync(configPath, JSON.stringify(cliConfig, null, 2), 'utf-8');
}

export function maskKey(key: string | undefined): string {
  if (!key || key.length < 8) return '********';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
