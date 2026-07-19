import _Ajv from 'ajv';
import { getToolByName, isToolInjected } from '../catalog.js';
import { activeUpstreams } from '../upstream.js';
import { passesPreconditions } from './precondition.js';

const Ajv = _Ajv as any;
const ajv = new Ajv({ strict: false });

interface CachedValidator {
  fingerprint: string;
  validate: any;
}
const validatorCache = new Map<string, CachedValidator>();

export interface GateResult {
  allowed: boolean;
  error?: string;
}

/**
 * Validates a tool call against the Hallucination and Schema gates.
 * 1. Was the tool injected into the LLM context this session?
 * 2. Do the arguments match the tool's JSON schema?
 */
export function validateToolCall(toolName: string, args: any, config: any): GateResult {
  // 1. Hallucination Gate
  // The 'request_tools' tool is always allowed (it's our safety net).
  if (toolName !== 'request_tools' && toolName !== 'batch_call' && !isToolInjected(toolName)) {
    console.error(`[Hallucination Gate] BLOCKED: LLM hallucinated call to non-injected tool: ${toolName}`);
    
    if (config.injectAllTools) {
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

  // 2. Schema Validation Gate (skip for virtual gateway tools since they are hardcoded in proxy.ts)
  if (toolName !== 'request_tools' && toolName !== 'batch_call') {
    const connectedServers = activeUpstreams.map(u => u.name);
    const tool = getToolByName(toolName, connectedServers);
    if (!tool) {
      return { allowed: false, error: `Tool '${toolName}' does not exist in the catalog.` };
    }

    if (!passesPreconditions(tool.tool_name, tool.server_name, config)) {
      return { allowed: false, error: `Tool '${toolName}' failed runtime precondition checks (e.g., missing secrets).` };
    }

    const schema = JSON.parse(tool.full_schema_json);
    const parametersSchema = schema.inputSchema || schema.parameters || {};

    try {
      let validate;
      const cached = validatorCache.get(toolName);
      if (cached && cached.fingerprint === tool.fingerprint) {
        validate = cached.validate;
      } else {
        validate = ajv.compile(parametersSchema);
        validatorCache.set(toolName, { fingerprint: tool.fingerprint, validate });
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
  }

  return { allowed: true };
}
