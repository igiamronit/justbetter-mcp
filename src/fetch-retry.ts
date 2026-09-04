/** Rate-limit retries are bounded: an exhausted quota must surface, not stall forever. */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;

export async function fetchWithRetry(url: string, options: RequestInit, maxAttempts: number = MAX_ATTEMPTS): Promise<Response> {
  let attempt = 0;

  while (true) {
    const response = await fetch(url, options);

    // 429 Too Many Requests (Rate Limit)
    if (response.status !== 429) {
      return response;
    }

    attempt++;
    if (attempt >= maxAttempts) {
      console.warn(`\n[LLM Proxy] ⚠️ Rate limit (429) persisted after ${attempt} attempts. Returning the error to the caller.`);
      return response;
    }

    // Attempt to respect Retry-After header if provided by API
    const retryAfterStr = response.headers.get('retry-after');
    let delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff: 2s, 4s, 8s

    if (retryAfterStr) {
      const retryAfterSeconds = parseInt(retryAfterStr, 10);
      if (!isNaN(retryAfterSeconds)) {
        delayMs = retryAfterSeconds * 1000;
      }
    }

    delayMs = Math.min(delayMs, MAX_DELAY_MS);

    console.warn(`\n[LLM Proxy] ⚠️ Rate limit (429) hit. Retrying in ${delayMs / 1000}s... (Attempt ${attempt}/${maxAttempts - 1})`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
