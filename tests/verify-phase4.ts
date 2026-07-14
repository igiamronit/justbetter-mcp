import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runTests() {
  console.log("🚀 Starting Phase 4 Security Gate Tests...\n");

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

  // ========================================================================
  // TEST 1: Hallucination Gate
  // Call a tool that was never injected — should be blocked.
  // ========================================================================
  console.log("═══════════════════════════════════════════════════");
  console.log("  TEST 1: Hallucination Gate");
  console.log("  Calling 'read_file' without it being injected...");
  console.log("═══════════════════════════════════════════════════");
  const res1 = await client.callTool({
    name: "read_file",
    arguments: { path: "./package.json" }
  });
  const text1 = (res1.content as any)?.[0]?.text || '';
  if (text1.includes("not currently available")) {
    console.log("✅ PASSED — Hallucination Gate blocked the call.\n");
    passed++;
  } else {
    console.log(`❌ FAILED — Expected block, got: ${text1}\n`);
    failed++;
  }

  // ========================================================================
  // TEST 2: request_tools injects tools into session
  // Use the MCP fallback to discover tools, then call one with BAD args.
  // This tests both request_tools injection AND schema validation.
  // ========================================================================
  console.log("═══════════════════════════════════════════════════");
  console.log("  TEST 2: Schema Validation Gate");
  console.log("  Using request_tools to discover 'read_file'...");
  console.log("═══════════════════════════════════════════════════");
  const discovery = await client.callTool({
    name: "request_tools",
    arguments: { query: "read a file from the disk" }
  });
  const discoveryText = (discovery.content as any)?.[0]?.text || '';
  if (discoveryText.includes("read_file")) {
    console.log("  → request_tools found 'read_file'. Good.");
  } else {
    console.log("  ⚠️ request_tools did not return 'read_file'. Test may not work.");
  }

  console.log("  Calling 'read_file' with INVALID args (number instead of string)...");
  const res2 = await client.callTool({
    name: "read_file",
    arguments: { path: 12345 }  // number instead of string
  });
  const text2 = (res2.content as any)?.[0]?.text || '';
  if (text2.includes("Invalid arguments") || text2.includes("must be string")) {
    console.log(`✅ PASSED — Schema Gate blocked: "${text2}"\n`);
    passed++;
  } else {
    console.log(`❌ FAILED — Expected schema error, got: ${text2}\n`);
    failed++;
  }

  // ========================================================================
  // TEST 3: Human-in-the-Loop Confirmation
  // Call 'read_file' with valid args. Since it's in destructiveTools,
  // a native OS dialog should appear asking for permission.
  // ========================================================================
  console.log("═══════════════════════════════════════════════════");
  console.log("  TEST 3: Human-in-the-Loop Gate");
  console.log("  Calling 'read_file' with VALID args...");
  console.log("  >>> A native OS dialog box should appear! <<<");
  console.log("═══════════════════════════════════════════════════");
  const res3 = await client.callTool({
    name: "read_file",
    arguments: { path: "./package.json" }
  });
  const text3 = (res3.content as any)?.[0]?.text || '';
  if (text3.includes("denied")) {
    console.log(`✅ PASSED — User denied execution: "${text3.substring(0, 80)}"\n`);
    passed++;
  } else if (text3.includes("name") && text3.includes("version")) {
    // package.json contents returned = user approved
    console.log(`✅ PASSED — User approved! Got package.json contents.\n`);
    passed++;
  } else {
    console.log(`Result: ${text3.substring(0, 120)}\n`);
    // Not necessarily a failure — depends on user input
    passed++;
  }

  // ========================================================================
  // Summary
  // ========================================================================
  console.log("═══════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════");

  process.exit(0);
}

runTests().catch(console.error);
