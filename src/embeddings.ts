import { pipeline } from '@huggingface/transformers';

let extractor: any = null;

async function getExtractor() {
  if (!extractor) {
    // Uses Xenova's all-MiniLM-L6-v2 directly in Node.js via ONNX
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    });
  }
  return extractor;
}

const embeddingCache = new Map<string, Float32Array>();

export async function embed(text: string): Promise<Float32Array> {
  if (embeddingCache.has(text)) {
    return embeddingCache.get(text)!;
  }
  
  const ext = await getExtractor();
  // Pooling mean and normalize true are standard for semantic similarity on this model
  const output = await ext(text, { pooling: 'mean', normalize: true });
  const vector = output.data as Float32Array;
  
  // Cap cache size to prevent memory leaks in extremely long sessions
  if (embeddingCache.size > 1000) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey) embeddingCache.delete(firstKey);
  }
  
  embeddingCache.set(text, vector);
  return vector;
}
