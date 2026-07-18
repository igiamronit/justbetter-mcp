import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";

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
  port: z.number().default(4141),
  realApiBase: z.string().optional(),
  realApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  mistralApiKey: z.string().optional(),
  model: z.string().optional(),
});

export const ConfigSchema = z.object({
  apiProvider: z.enum(["gemini", "mistral"]).default("gemini"),
  upstreamServers: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
    })
  ),
  llmProxy: LlmProxySchema.optional(),
  pinnedTools: z.array(z.string()).default([]),
  destructiveTools: z.array(z.string()).default([]),
  preconditions: z.record(z.string(), z.object({
    requiresSecret: z.string().optional(),
    requiresServer: z.string().optional()
  })).optional()
});

export type Config = z.infer<typeof ConfigSchema>;

export function getEffectiveApiBase(config: Config): string {
  const provider = config.apiProvider ?? "gemini";
  return config.llmProxy?.realApiBase ?? getProviderBase(provider);
}

export function getEffectiveApiKey(config: Config): string {
  const provider = config.apiProvider || "gemini";
  const llmConfig = config.llmProxy;
  if (!llmConfig) return "";
  if (provider === "gemini") {
    return llmConfig.geminiApiKey || llmConfig.realApiKey || "";
  }
  return llmConfig.mistralApiKey || llmConfig.realApiKey || "";
}

export function loadConfig(path: string): Config {
  const fileContent = readFileSync(path, "utf-8");
  const json = JSON.parse(fileContent);
  const config = ConfigSchema.parse(json);
  
  config.pinnedTools = Array.from(new Set([...CORE_PINNED_TOOLS, ...config.pinnedTools]));
  
  if (config.llmProxy && process.env.LLM_PORT) {
    config.llmProxy.port = parseInt(process.env.LLM_PORT, 10);
  }
  
  return config;
}

export function saveConfig(path: string, config: Config): void {
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
