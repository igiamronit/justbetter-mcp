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

export async function embed(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  // Pooling mean and normalize true are standard for semantic similarity on this model
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return output.data as Float32Array;
}
