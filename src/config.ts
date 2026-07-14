import { z } from "zod";
import { readFileSync } from "fs";

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
  }).optional(),
  pinnedTools: z.array(z.string()).default([]),  // Tool names always injected regardless of semantic match
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const fileContent = readFileSync(path, "utf-8");
  const json = JSON.parse(fileContent);
  return ConfigSchema.parse(json);
}
