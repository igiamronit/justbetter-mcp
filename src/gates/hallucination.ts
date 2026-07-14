import _Ajv from 'ajv';
import { wasToolInjected } from '../session.js';
import { getToolByName } from '../catalog.js';

const Ajv = _Ajv as any;
const ajv = new Ajv({ strict: false });

export interface GateResult {
  allowed: boolean;
  error?: string;
}

/**
 * Validates a tool call against the Hallucination and Schema gates.
 * 1. Was the tool injected into the LLM context this session?
 * 2. Do the arguments match the tool's JSON schema?
 */
export function validateToolCall(toolName: string, args: any): GateResult {
  // 1. Hallucination Gate
  // The 'request_tools' tool is always allowed (it's our safety net).
  if (toolName !== 'request_tools' && !wasToolInjected(toolName)) {
    console.error(`[Hallucination Gate] BLOCKED: LLM hallucinated call to non-injected tool: ${toolName}`);
    return {
      allowed: false,
      error: `Tool '${toolName}' is not currently available. Please use the 'request_tools' function to search for the right tool capabilities before calling them.`
    };
  }

  // 2. Schema Validation Gate (skip for request_tools since it's hardcoded in proxy.ts)
  if (toolName !== 'request_tools') {
    const tool = getToolByName(toolName);
    if (!tool) {
      return { allowed: false, error: `Tool '${toolName}' does not exist in the catalog.` };
    }

    const schema = JSON.parse(tool.full_schema_json);
    const parametersSchema = schema.inputSchema || schema.parameters || {};

    try {
      const validate = ajv.compile(parametersSchema);
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
