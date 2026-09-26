/**
 * Helpers shared by the two JustBetter clients (src/cli.ts and src/tui.tsx).
 *
 * These were previously copy-pasted into both files and had already drifted apart, so
 * a fix applied to one silently missed the other.
 */

/** Default ceiling on the characters a single tool result may contribute. */
export const MAX_TOOL_CHARS = 15000;

/** Default ceiling on the characters the whole conversation may carry. */
export const MAX_CONTEXT_CHARS = 200000;

export function smartTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const halfLimit = Math.floor(maxLength / 2);

  // Find the last newline before halfLimit for the head
  let headEnd = text.lastIndexOf('\n', halfLimit);
  if (headEnd === -1) headEnd = halfLimit; // fallback if no newlines

  // Find the first newline after (text.length - halfLimit) for the tail
  const tailStartTarget = text.length - halfLimit;
  let tailStart = text.indexOf('\n', tailStartTarget);
  if (tailStart === -1) tailStart = tailStartTarget; // fallback

  // If we couldn't find good boundaries or they overlap weirdly, just hard cut
  if (headEnd >= tailStart) {
    headEnd = halfLimit;
    tailStart = text.length - halfLimit;
  }

  const head = text.substring(0, headEnd);
  const tail = text.substring(tailStart);
  const omitted = text.length - (head.length + tail.length);

  return `${head}\n\n...[SYSTEM WARNING: OUTPUT TRUNCATED. OMITTED ${omitted} CHARACTERS TO PREVENT CONTEXT EXHAUSTION]...\n\n${tail}`;
}

/**
 * Flattens an MCP tool result's content blocks to text. Non-text blocks (images,
 * resources) are serialized rather than dropped: mapping straight to `.text` yields
 * `undefined` for them, which then reaches the model as the literal string "undefined".
 */
export function toolContentToText(content: any): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content ?? '');
  }

  return content.map((part) => {
    if (typeof part?.text === 'string') return part.text;
    return JSON.stringify(part);
  }).join('\n');
}

/** Origin of the Mode 1 LLM proxy, honouring config and the LLM_PORT override. */
export function resolveProxyBase(cliConfig: any): string {
  const port = process.env.LLM_PORT
    ? parseInt(process.env.LLM_PORT, 10)
    : (cliConfig?.llmProxy?.port ?? 4141);
  const host = cliConfig?.llmProxy?.host || '127.0.0.1';
  return `http://${host}:${port}`;
}

/** Chat-completions endpoint of the Mode 1 LLM proxy. */
export function resolveProxyUrl(cliConfig: any): string {
  return `${resolveProxyBase(cliConfig)}/v1/chat/completions`;
}

/**
 * Waits for the proxy's health endpoint instead of sleeping a fixed interval and
 * hoping the HTTP server finished binding.
 */
/** What answered on the proxy port. */
export type ProxyProbe =
  /** Our own instance, the one whose token we passed in. */
  | { status: 'ours'; provider?: string; model?: string }
  /** Something else holds the port: another gateway, or an unrelated service. */
  | { status: 'foreign'; pid?: number; provider?: string; model?: string; apiBase?: string; service?: string }
  /** Nothing answered before the deadline. */
  | { status: 'absent' };

/**
 * Waits for the proxy *we* just started, not merely for something on the port.
 *
 * waitForProxy below returns true as soon as any /health answers, which is why a gateway
 * left running by an earlier session was indistinguishable from a fresh one. The orphan
 * keeps the port, the new proxy loses the bind, and every request goes to the old process
 * with the old provider and key -- so a config switched to Gemini kept returning Mistral's
 * errors and nothing anywhere said why. The caller passes the token it gave its child, and
 * a reply carrying a different token is reported as somebody else's proxy.
 */
export async function waitForOwnProxy(
  baseUrl: string,
  instance: string,
  timeoutMs: number = 20000
): Promise<ProxyProbe> {
  const deadline = Date.now() + timeoutMs;
  let lastForeign: ProxyProbe | null = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body: any = await res.json().catch(() => ({}));
        if (body?.instance === instance) {
          return { status: 'ours', provider: body?.provider, model: body?.model };
        }
        // Someone is there but it is not ours. Keep polling in case ours is still binding
        // and this is a race, but remember what we saw so it can be reported.
        lastForeign = {
          status: 'foreign',
          pid: typeof body?.pid === 'number' ? body.pid : undefined,
          provider: body?.provider,
          model: body?.model,
          apiBase: body?.apiBase,
          service: body?.service
        };
      }
    } catch {
      /* not listening yet */
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return lastForeign ?? { status: 'absent' };
}

export async function waitForProxy(baseUrl: string, timeoutMs: number = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return false;
}

function messageChars(message: any): number {
  if (typeof message?.content === 'string') return message.content.length;
  return JSON.stringify(message ?? {}).length;
}

/**
 * Trims the oldest turns once the transcript exceeds `maxChars`.
 *
 * The system message is always kept. Removal happens in whole groups: an assistant
 * message carrying tool_calls is dropped together with the tool results that answer it,
 * because an orphaned `role: "tool"` message (or a tool_call with no matching result)
 * is rejected by the chat-completions API.
 */
export function pruneMessages(messages: any[], maxChars: number = MAX_CONTEXT_CHARS): any[] {
  let total = messages.reduce((sum, m) => sum + messageChars(m), 0);
  if (total <= maxChars) return messages;

  const system = messages.length > 0 && messages[0]?.role === 'system' ? [messages[0]] : [];
  let rest = messages.slice(system.length);

  while (total > maxChars && rest.length > 0) {
    // Size of the group starting at index 0: one message, plus any tool replies to it.
    let groupSize = 1;
    if (rest[0]?.role === 'assistant' && Array.isArray(rest[0]?.tool_calls)) {
      while (groupSize < rest.length && rest[groupSize]?.role === 'tool') groupSize++;
    }

    // Never strip the transcript down to nothing; the newest turn has to survive.
    if (groupSize >= rest.length) break;

    for (let i = 0; i < groupSize; i++) total -= messageChars(rest[i]);
    rest = rest.slice(groupSize);
  }

  return [...system, ...rest];
}
