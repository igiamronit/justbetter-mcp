import fs from 'fs';

const logFile = 'token_log.csv';

if (!fs.existsSync(logFile)) {
  console.log(`Log file '${logFile}' does not exist yet. Run some commands first.`);
  process.exit(0);
}

const content = fs.readFileSync(logFile, 'utf-8').trim();
const lines = content.split('\n');

if (lines.length <= 1) {
  console.log(`No data in '${logFile}' yet.`);
  process.exit(0);
}

let totalPrompt = 0;
let totalCompletion = 0;
let totalTokens = 0;
let totalTurns = 0;
let totalInjected = 0;

// Skip header (i=1)
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  
  const [timestamp, prompt, completion, total, injected] = line.split(',');
  
  totalPrompt += parseInt(prompt || '0', 10);
  totalCompletion += parseInt(completion || '0', 10);
  totalTokens += parseInt(total || '0', 10);
  totalInjected += parseInt(injected || '0', 10);
  totalTurns++;
}

console.log("==========================================");
console.log("📊 JustBetter MCP Token Usage Report");
console.log("==========================================\n");
console.log(`Total Turns (Requests): ${totalTurns}`);
console.log(`Avg Tools Injected per Turn: ${(totalInjected / totalTurns).toFixed(1)}`);
console.log("------------------------------------------");
console.log(`Prompt Tokens:      ${totalPrompt.toLocaleString()}`);
console.log(`Completion Tokens:  ${totalCompletion.toLocaleString()}`);
console.log("------------------------------------------");
console.log(`Total Tokens:       ${totalTokens.toLocaleString()}`);
console.log("==========================================");
