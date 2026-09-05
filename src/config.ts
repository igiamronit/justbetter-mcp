import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { getGlobalSecret } from "./secrets.js";

export const CORE_PINNED_TOOLS = [
  'read_text_file',
  'write_file',
  'edit_file',
  'search_files',
  'list_directory',
  'list_allowed_directories',
  'run_terminal_command'
];

export const PROVIDER_BASES: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  mistral: "https://api.mistral.ai/v1",
};

export function getProviderBase(provider: string): string {
  return PROVIDER_BASES[provider] ?? "https://generativelanguage.googleapis.com/v1beta/openai";
}

export const LlmProxySchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(4141),
  // Loopback by default. Binding 0.0.0.0 turns this into an open relay for the
  // provider API key it forwards, reachable by anything on the local network.
  host: z.string().default("127.0.0.1"),
  authToken: z.string().optional(),
  realApiBase: z.string().optional(),
  realApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  mistralApiKey: z.string().optional(),
  model: z.string().optional(),
});

export const DashboardSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(4040),
  host: z.string().default("127.0.0.1"),
});

export const ConfigSchema = z.object({
  semanticPromptInjection: z.boolean().default(true),
  injectAllTools: z.boolean().default(false),
  apiProvider: z.enum(["gemini", "mistral"]).default("gemini"),
  // Folders the agent is allowed to touch. Substituted into upstream server args
  // wherever "." or "${JUSTBETTER_WORKSPACE}" appears -- see resolveServerArgs.
  // Empty means "the directory the CLI was launched from".
  allowedDirectories: z.array(z.string()).default([]),
  upstreamServers: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
      // Working directory for the spawned server. Defaults to the gateway's package
      // root so relative args (e.g. "src/terminal-server.ts") resolve against the
      // installation rather than whatever directory the MCP client launched us from.
      cwd: z.string().optional(),
    })
  ),
  llmProxy: LlmProxySchema.optional(),
  dashboard: DashboardSchema.optional(),
  pinnedTools: z.array(z.string()).default([]),
  destructiveTools: z.array(z.string()).default([]),
  preconditions: z.record(z.string(), z.object({
    requiresSecret: z.string().optional(),
    requiresServer: z.string().optional()
  })).optional()
});

export type Config = z.infer<typeof ConfigSchema>;

/** Schema for a single upstream server, reused to validate dashboard input. */
export const UpstreamServerSchema = ConfigSchema.shape.upstreamServers.element;

export function getEffectiveApiBase(config: Config): string {
  const provider = config.apiProvider ?? "gemini";
  return config.llmProxy?.realApiBase ?? getProviderBase(provider);
}

/**
 * Resolves the provider key. Config first (existing behaviour), then the process
 * environment, then the 0600 secrets file in ~/.justbetter-mcp — so credentials can
 * live outside the project directory, where the filesystem MCP server cannot read
 * them back out and hand them to the model.
 */
export function getEffectiveApiKey(config: Config): string {
  const provider = config.apiProvider || "gemini";
  const llmConfig = config.llmProxy;

  const fromConfig = provider === "gemini"
    ? (llmConfig?.geminiApiKey || llmConfig?.realApiKey)
    : (llmConfig?.mistralApiKey || llmConfig?.realApiKey);
  if (fromConfig) return fromConfig;

  const envKey = provider === "gemini"
    ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
    : process.env.MISTRAL_API_KEY;
  if (envKey) return envKey;

  return getGlobalSecret(provider === "gemini" ? "geminiApiKey" : "mistralApiKey")
    || getGlobalSecret("realApiKey")
    || "";
}

/**
 * True when the resolved provider key is missing or still the shipped placeholder.
 * Editing the wrong config file otherwise surfaces only as an "invalid API key"
 * error from the provider, which gives the user nothing to act on.
 */
export function isPlaceholderApiKey(config: Config): boolean {
  const key = getEffectiveApiKey(config);
  return !key || /^YOUR-/i.test(key);
}

export type KeyCheck =
  | { status: "valid" }
  | { status: "rejected"; message: string }
  | { status: "unknown"; message: string };

/**
 * Asks the provider whether a key works, using the cheapest authenticated endpoint
 * both of them expose. The point is to reject a typo while the user still has the
 * paste buffer open: without this, a bad key is only ever reported as an opaque 401
 * on the first chat turn, long after the setup screen is gone.
 *
 * "unknown" is deliberately distinct from "rejected" -- being offline must not stop
 * someone configuring the tool.
 */
export async function verifyApiKey(
  provider: string,
  key: string,
  timeoutMs = 10_000
): Promise<KeyCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getProviderBase(provider)}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (response.ok) return { status: "valid" };
    if (response.status === 401 || response.status === 403) {
      return { status: "rejected", message: `The provider rejected that key (HTTP ${response.status}).` };
    }
    return { status: "unknown", message: `The provider answered HTTP ${response.status}.` };
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? "the request timed out" : (e?.message ?? String(e));
    return { status: "unknown", message: `Could not reach the provider: ${reason}.` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expands ${NAME} references in upstream env values against process.env and the
 * global secrets file, so an upstream server can be configured with a placeholder
 * instead of a literal token committed to config.json.
 */
export function resolveServerEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(env)) {
    resolved[key] = rawValue.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      return process.env[name] ?? getGlobalSecret(name) ?? match;
    });
  }
  return resolved;
}

export function loadConfig(path: string): Config {
  const fileContent = readFileSync(path, "utf-8");
  const json = JSON.parse(fileContent);
  const config = ConfigSchema.parse(json);

  config.pinnedTools = Array.from(new Set([...CORE_PINNED_TOOLS, ...config.pinnedTools]));

  if (config.llmProxy && process.env.LLM_PORT) {
    config.llmProxy.port = parseInt(process.env.LLM_PORT, 10);
  }

  if (process.env.DASHBOARD_PORT) {
    config.dashboard = {
      ...(config.dashboard ?? DashboardSchema.parse({})),
      port: parseInt(process.env.DASHBOARD_PORT, 10)
    };
  }

  return config;
}

export function saveConfig(path: string, config: Config): void {
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
