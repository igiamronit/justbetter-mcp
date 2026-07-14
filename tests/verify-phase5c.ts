import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runTests() {
  console.log("🚀 Starting Phase 5C Batch Execution Tests...\n");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/proxy.ts"],
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("✅ Connected to Gateway Proxy.\n");

  let passed = 0;
  let failed = 0;

  // Step 0: Ensure tools are "injected" using request_tools so the Hallucination Gate lets us call them
  console.log("  [Setup] Calling request_tools to inject tools into session...");
  await client.callTool({
    name: "request_tools",
    arguments: { query: "read files and list directories" }
  });

  // ========================================================================
  // TEST 1: Valid Batch Call
  // Execute two valid tools sequentially.
  // ========================================================================
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  TEST 1: Valid Batch Execution");
  console.log("  Executing list_allowed_directories and read_file together.");
  console.log("═══════════════════════════════════════════════════");
  
  // Note: read_file is in destructiveTools from config.json, so the Gateway will prompt for terminal approval!
  // We'll see if it pops up correctly.
  console.log("\n⚠️ ATTENTION: You will need to press 'Y' in the terminal to approve the read_file sub-call!\n");

  const res1 = await client.callTool({
    name: "batch_call",
    arguments: {
      calls: [
        { tool: "list_allowed_directories", args: {} },
        { tool: "read_file", args: { path: "package.json" } }
      ]
    }
  });

  const text1 = (res1.content as any)?.[0]?.text || '';
  try {
    const jsonResult = JSON.parse(text1);
    if (Array.isArray(jsonResult) && jsonResult.length === 2 && jsonResult[0].status === "success" && jsonResult[1].status === "success") {
      console.log("✅ PASSED — Batch call executed both tools successfully.\n");
      passed++;
    } else {
      console.log(`❌ FAILED — Unexpected batch array output: ${text1}\n`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ FAILED — Batch call did not return valid JSON array: ${text1}\n`);
    failed++;
  }

  // ========================================================================
  // TEST 2: Schema Validation during Batch
  // The second sub-call is invalid. The batch loop should catch it and halt.
  // ========================================================================
  console.log("═══════════════════════════════════════════════════");
  console.log("  TEST 2: Schema Validation inside Batch");
  console.log("  Executing list_allowed_directories + read_file (with BAD args).");
  console.log("═══════════════════════════════════════════════════");

  const res2 = await client.callTool({
    name: "batch_call",
    arguments: {
      calls: [
        { tool: "list_allowed_directories", args: {} },
        { tool: "read_file", args: { path: 12345 } } // invalid arg
      ]
    }
  });

  const text2 = (res2.content as any)?.[0]?.text || '';
  try {
    const jsonResult = JSON.parse(text2);
    if (Array.isArray(jsonResult) && jsonResult.length === 2) {
      if (jsonResult[0].status === "success" && jsonResult[1].status === "error" && jsonResult[1].error.includes("Invalid arguments")) {
        console.log(`✅ PASSED — Sub-call correctly caught by Schema Gate: "${jsonResult[1].error}"\n`);
        passed++;
      } else {
        console.log(`❌ FAILED — Schema gate did not behave as expected: ${text2}\n`);
        failed++;
      }
    } else {
      console.log(`❌ FAILED — Unexpected batch array output: ${text2}\n`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ FAILED — Batch call did not return valid JSON array: ${text2}\n`);
    failed++;
  }

  // ========================================================================
  // SUMMARY
  // ========================================================================
  console.log("═══════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("═══════════════════════════════════════════════════\n");

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("Test Harness Error:", err);
  process.exit(1);
});
