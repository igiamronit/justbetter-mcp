import { embed } from '../src/embeddings.js';
import { searchTools } from '../src/catalog.js';

async function run() {
  console.log("Testing Semantic Search...");

  const query = "I was working on a project yesterday and saved some configuration details in a file on my laptop. Can you open that file and tell me what is written inside it? I don't want to modify anything, just read the contents.";
  console.log(`\nEmbedding user query: "${query}"`);

  const queryVector = await embed(query);
  console.log(`Generated vector of length ${queryVector.length}`);

  console.log("\nSearching SQLite vector catalog (Threshold: 0.28)...");
  // Assuming proxy.ts has been run at least once to populate catalog.db
  const results = searchTools(queryVector, 0.28, 10);

  if (results.length === 0) {
    console.log("No tools matched the threshold. (Did you run the proxy first?)");
  } else {
    results.forEach((r, idx) => {
      console.log(`[${idx + 1}] Tool: ${r.tool_name} (Score: ${r.score.toFixed(4)})`);
    });
  }
}

run().catch(console.error);
