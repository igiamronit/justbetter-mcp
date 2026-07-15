import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";

export const ConfigSchema = z.object({
  upstreamServers: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
    })
  ),
  llmProxy: z.object({
    port: z.number().default(4141),
    realApiBase: z.string(),       // e.g. "https://api.openai.com/v1"
    realApiKey: z.string(),        // The real API key to forward requests with
    model: z.string().optional(),  // The model name to use (e.g. "gemini-1.5-flash")
  }).optional(),
  pinnedTools: z.array(z.string()).default([]),  // Tool names always injected regardless of semantic match
  destructiveTools: z.array(z.string()).default([]), // Tools that require explicit user confirmation
  preconditions: z.record(z.string(), z.object({
    requiresSecret: z.string().optional(),
    requiresServer: z.string().optional()
  })).optional()
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const fileContent = readFileSync(path, "utf-8");
  const json = JSON.parse(fileContent);
  const config = ConfigSchema.parse(json);
  
  if (config.llmProxy && process.env.LLM_PORT) {
    config.llmProxy.port = parseInt(process.env.LLM_PORT, 10);
  }
  
  return config;
}

export function saveConfig(path: string, config: Config): void {
  // Strip out llmProxy overrides (like port from ENV) if necessary, 
  // but to keep it simple we just serialize the whole validated config object.
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
