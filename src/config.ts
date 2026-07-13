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
  )
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const fileContent = readFileSync(path, "utf-8");
  const json = JSON.parse(fileContent);
  return ConfigSchema.parse(json);
}
