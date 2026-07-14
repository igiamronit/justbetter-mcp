import { serverStatuses } from '../upstream.js';
import type { Config } from '../config.js';

/**
 * Checks if a tool passes its configured preconditions (e.g. required server connection, required environment secrets).
 * Returns true if the tool should be exposed to the LLM, false if it should be hidden.
 */
export function passesPreconditions(toolName: string, serverName: string, config: Config): boolean {
  // 1. Is the upstream server that owns this tool currently connected?
  if (serverStatuses[serverName] !== 'connected') {
    console.error(`[Precondition Gate] Skipped ${toolName}: Server '${serverName}' is disconnected.`);
    return false;
  }
  
  const pre = config.preconditions?.[toolName];
  if (pre) {
    // 2. Does it require a specific environment variable secret?
    if (pre.requiresSecret && !process.env[pre.requiresSecret]) {
      console.error(`[Precondition Gate] Skipped ${toolName}: Missing required secret '${pre.requiresSecret}' in process.env.`);
      return false;
    }
    
    // 3. Does it explicitly require a different server to be connected?
    if (pre.requiresServer && serverStatuses[pre.requiresServer] !== 'connected') {
      console.error(`[Precondition Gate] Skipped ${toolName}: Dependent server '${pre.requiresServer}' is disconnected.`);
      return false;
    }
  }

  return true;
}
