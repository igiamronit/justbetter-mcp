export async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  let attempt = 0;
  const baseDelay = 2000; // 2 seconds base delay

  while (true) {
    const response = await fetch(url, options);

    // 429 Too Many Requests (Rate Limit)
    if (response.status === 429) {
      attempt++;
      
      // Attempt to respect Retry-After header if provided by API
      const retryAfterStr = response.headers.get('retry-after');
      let delayMs = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff: 2s, 4s, 8s
      
      if (retryAfterStr) {
        const retryAfterSeconds = parseInt(retryAfterStr, 10);
        if (!isNaN(retryAfterSeconds)) {
          delayMs = retryAfterSeconds * 1000;
        }
      }
      
      console.warn(`\n[LLM Proxy] ⚠️ Rate limit (429) hit. Retrying in ${delayMs / 1000}s... (Attempt ${attempt})`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    // Return the response if it's not a 429 or if we exhausted all retries
    return response;
  }
}
