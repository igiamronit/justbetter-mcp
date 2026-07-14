/**
 * Tracks which tools were recently injected into the LLM context.
 * Used by the Hallucination Gate to block the AI from calling tools it
 * was never given (preventing hallucinated schema payloads).
 */

const g = global as any;
if (!g.__injectedTools) {
  g.__injectedTools = new Set<string>();
}

export function markToolInjected(toolName: string) {
  g.__injectedTools.add(toolName);
}

export function wasToolInjected(toolName: string): boolean {
  return g.__injectedTools.has(toolName);
}

export function clearInjectedTools() {
  g.__injectedTools.clear();
}
