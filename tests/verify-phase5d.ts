import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";

async function runTests() {
  console.log("🚀 Starting Phase 5D Precondition Gating Tests...\n");

  // --- Setup Test Config ---
  const originalConfig = JSON.parse(fs.readFileSync("config.json", "utf-8"));
  const testConfig = { ...originalConfig };
  testConfig.preconditions = {
    "get_file_info": { requiresSecret: "MY_TEST_SECRET" }
  };
  fs.writeFileSync("tests/test-config.json", JSON.stringify(testConfig, null, 2));

  // --- Run First Proxy WITHOUT Secret ---
  console.log("═══════════════════════════════════════════════════");
  console.log("  TEST 1: Missing Secret Precondition");
  console.log("  Starting proxy WITHOUT MY_TEST_SECRET set...");
  console.log("═══════════════════════════════════════════════════");

  let passed = 0;
  let failed = 0;

  let transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/proxy.ts", "tests/test-config.json"],
  });
  let client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  
  // Wait for upstream server to connect in proxy
  await new Promise(r => setTimeout(r, 5000));

  let discovery = await client.callTool({
    name: "request_tools",
    arguments: { query: "get info about a file" }
  });
  
  let discoveryText = (discovery.content as any)?.[0]?.text || '';
  if (discoveryText.includes("get_file_info")) {
    console.log(`❌ FAILED — get_file_info was returned even though secret is missing!\n`);
    failed++;
  } else {
    console.log(`✅ PASSED — get_file_info was properly hidden by Precondition Gate.\n`);
    passed++;
  }

  // Double check hallucination gate blocks it
  let res = await client.callTool({
    name: "get_file_info",
    arguments: { path: "package.json" }
  });
  let resText = (res.content as any)?.[0]?.text || '';
  if (resText.includes("not currently available")) {
    console.log(`✅ PASSED — Hallucination Gate blocked direct access to hidden tool.\n`);
    passed++;
  } else {
    console.log(`❌ FAILED — Tool executed despite failing preconditions!\n`);
    failed++;
  }

  await client.close();

  // --- Run Second Proxy WITH Secret ---
  console.log("═══════════════════════════════════════════════════");
  console.log("  TEST 2: Satisfied Secret Precondition");
  console.log("  Starting proxy WITH MY_TEST_SECRET=123 set...");
  console.log("═══════════════════════════════════════════════════");

  transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/proxy.ts", "tests/test-config.json"],
    env: { ...process.env, MY_TEST_SECRET: "123" }
  });
  client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  await client.connect(transport);

  // Wait for upstream server to connect in proxy
  await new Promise(r => setTimeout(r, 5000));

  discovery = await client.callTool({
    name: "request_tools",
    arguments: { query: "get info about a file" }
  });
  
  discoveryText = (discovery.content as any)?.[0]?.text || '';
  if (discoveryText.includes("get_file_info")) {
    console.log(`✅ PASSED — get_file_info was successfully injected when secret is present!\n`);
    passed++;
  } else {
    console.log(`❌ FAILED — get_file_info was hidden despite secret being present!\n`);
    failed++;
  }

  await client.close();

  // Cleanup
  fs.unlinkSync("tests/test-config.json");

  console.log("═══════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("═══════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
