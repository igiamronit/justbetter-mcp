import _Ajv from 'ajv';
import { getToolByName, isToolInjected } from '../catalog.js';
import type { IndexedTool } from '../catalog.js';
import { activeUpstreams } from '../upstream.js';
import { passesPreconditions } from './precondition.js';

const Ajv = _Ajv as any;
const ajv = new Ajv({ strict: false });

interface CachedValidator {
  fingerprint: string;
  validate: any;
}
// Keyed by the catalog id (server:tool), never the bare name — two servers can expose
// the same tool name with different schemas, and a shared cache entry would let one
// server's schema validate the other's arguments.
const validatorCache = new Map<string, CachedValidator>();

/** Gateway primitives that have no catalog row; their schemas are hardcoded in proxy.ts. */
export const VIRTUAL_TOOLS = new Set(['request_tools', 'batch_call']);

export interface GateResult {
  allowed: boolean;
  error?: string;
  /** The resolved catalog entry, so callers route to the server that was validated. */
  tool?: IndexedTool;
}

/**
 * Validates a tool call against the Hallucination and Schema gates.
 * 1. Was the tool injected into the LLM context this session (or is it pinned)?
 * 2. Do the arguments match the tool's JSON schema?
 */
export function validateToolCall(toolName: string, args: any, config: any = {}): GateResult {
  const cfg = config ?? {};
  const pinnedTools: string[] = Array.isArray(cfg.pinnedTools) ? cfg.pinnedTools : [];

  if (VIRTUAL_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // 1. Hallucination Gate
  // Pinned tools are, by definition, always part of the environment: Mode 1 re-injects
  // them on every request, and Mode 2 advertises them through request_tools. Gating them
  // on a per-turn injection record would make them permanently uncallable over stdio.
  const isPinned = pinnedTools.includes(toolName);
  if (!isPinned && !isToolInjected(toolName)) {
    console.error(`[Hallucination Gate] BLOCKED: LLM hallucinated call to non-injected tool: ${toolName}`);

    if (cfg.injectAllTools) {
      return {
        allowed: false,
        error: `Tool '${toolName}' does not exist. You have ALL available tools loaded in your context. Please check your spelling against the provided tool schemas (e.g. hyphens vs underscores).`
      };
    }

    return {
      allowed: false,
      error: `Tool '${toolName}' is not currently available. Please use the 'request_tools' function to search for the right tool capabilities before calling them.`
    };
  }

  // 2. Schema Validation Gate
  const connectedServers = activeUpstreams.map(u => u.name);
  const tool = getToolByName(toolName, connectedServers);
  if (!tool) {
    return { allowed: false, error: `Tool '${toolName}' does not exist in the catalog.` };
  }

  if (!passesPreconditions(tool.tool_name, tool.server_name, cfg)) {
    return { allowed: false, error: `Tool '${toolName}' failed runtime precondition checks (e.g., missing secrets).` };
  }

  const schema = JSON.parse(tool.full_schema_json);
  const parametersSchema = schema.inputSchema || schema.parameters || {};

  try {
    let validate;
    const cached = validatorCache.get(tool.id);
    if (cached && cached.fingerprint === tool.fingerprint) {
      validate = cached.validate;
    } else {
      validate = ajv.compile(parametersSchema);
      validatorCache.set(tool.id, { fingerprint: tool.fingerprint, validate });
    }

    const valid = validate(args);

    if (!valid) {
      const errors = ajv.errorsText(validate.errors);
      console.error(`[Schema Gate] BLOCKED: Invalid arguments for ${toolName}: ${errors}`);
      return {
        allowed: false,
        error: `Invalid arguments for tool '${toolName}': ${errors}`
      };
    }
  } catch (err: any) {
    console.error(`[Schema Gate] Warning: Could not compile schema for ${toolName}:`, err.message);
    // If we can't compile the schema (e.g. invalid JSON schema from upstream), we let it pass
    // to the upstream server to handle the error natively.
  }

  return { allowed: true, tool };
}
