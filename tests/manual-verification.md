# Manual Verification Runbook

These checks are intentionally outside `npm test` because they require a real MCP client, browser, local ports, OS dialogs, or external-client behavior. Run `npm test` first; this file covers the skipped and human-observable cases.

All commands below assume PowerShell from the repository root:

```powershell
F:\VS CODE\justbetter-mcp
```

## Before You Start

Run the automated suite first:

```powershell
npm test
```

Expected output:

```text
Summary: 9 passed, 0 failed, 3 skipped
```

Use a temporary config for manual tests when possible because dashboard add/remove and destructive-tool edits can write back to the config file.

Recommended temp config path:

```text
tests\manual-config.json
```

Create it from `config.example.json` or from `config.json`, then replace real API keys with dummy values when using the fake LLM server.

## Start The Gateway

Command:

```powershell
npx tsx src/proxy.ts tests/manual-config.json
```

If you are testing against your real current config, use:

```powershell
npx tsx src/proxy.ts config.json
```

Expected terminal output includes:

```text
[Dashboard] Local management UI running on http://localhost:4040
[LLM Proxy] Listening on http://localhost:4141/v1
Connecting to upstream server: filesystem...
Connecting to upstream server: terminal...
JustBetter MCP Gateway is running.
```

Pass criteria:

- Gateway stays running.
- Dashboard binds to `http://localhost:4040`.
- LLM proxy binds to `http://localhost:4141/v1` if `llmProxy` exists in the config.
- Upstream failures are reported but do not crash the process.

## Manual Test 1: MCP Client Static Tool List

Purpose: verify strict MCP clients see only gateway primitives, not the whole upstream tool catalog.

Run MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector npx tsx src/proxy.ts tests/manual-config.json
```

In the inspector, call `tools/list`.

Expected tools:

```text
request_tools
batch_call
```

Pass criteria:

- `request_tools` is listed.
- `batch_call` is listed.
- Filesystem tools like `read_file`, `write_file`, `list_directory`, or terminal tools like `run_terminal_command` are not directly listed in `tools/list`.

Fail criteria:

- Full upstream catalog appears in `tools/list`.
- `request_tools` is missing.
- `batch_call` is missing.

## Manual Test 2: request_tools Fallback

Purpose: verify the MCP fallback can discover relevant tools and mark them callable.

In MCP Inspector, call:

```json
{
  "name": "request_tools",
  "arguments": {
    "query": "read files and list allowed directories"
  }
}
```

Expected result contains text similar to:

```text
Found N matching tools:

Tool: list_allowed_directories
Description: ...
Parameters: ...
```

Then call one returned tool, for example:

```json
{
  "name": "list_allowed_directories",
  "arguments": {}
}
```

Expected result contains the allowed root directory list.

Pass criteria:

- `request_tools` returns relevant tool schemas/descriptions.
- The returned real tool can be called immediately after discovery.
- No unrelated destructive tool is required for this flow.

Fail criteria:

- `request_tools` returns no tools for a clear query.
- Calling the returned tool is blocked as hallucinated.

## Manual Test 3: Filesystem Allowed Directories

Purpose: verify filesystem scope boundaries.

Current default filesystem config:

```json
{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
}
```

When the gateway is launched from this repository, `.` should resolve to:

```text
F:\VS CODE\justbetter-mcp
```

First discover the tool with `request_tools`:

```json
{
  "name": "request_tools",
  "arguments": {
    "query": "show filesystem allowed directories"
  }
}
```

Then call:

```json
{
  "name": "list_allowed_directories",
  "arguments": {}
}
```

Expected output includes:

```text
F:\VS CODE\justbetter-mcp
```

To add an outside directory, update the filesystem server args, then restart the gateway:

```json
{
  "name": "filesystem",
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    ".",
    "F:\\AI-Test-Workspace"
  ]
}
```

Expected `list_allowed_directories` output after restart includes both:

```text
F:\VS CODE\justbetter-mcp
F:\AI-Test-Workspace
```

Boundary checks:

- Read a file inside `F:\VS CODE\justbetter-mcp`: should succeed after the tool is discovered/injected.
- Read a file inside `F:\AI-Test-Workspace`: should succeed only if that root was added.
- Read outside all allowed roots, such as `C:\Users\RONIT\.ssh\config`: should be rejected by the filesystem server.

Pass criteria:

- Allowed roots match config.
- Outside-root reads fail.
- Destructive filesystem tests are performed only inside `.test-sandbox` or a temp test directory.

Important caveat:

- This only applies to the official filesystem MCP server.
- `run_terminal_command` is not directory-restricted and can access anything the OS user can access.

## Manual Test 4: LLM Proxy Semantic Injection With Fake LLM

Purpose: verify the skipped LLM proxy test manually without calling a real LLM provider.

### Step 1: Start A Fake LLM Capture Server

Open Terminal A and run:

```powershell
node -e 'const http=require("http");let last=null;http.createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{if(req.url.endsWith("/chat/completions")){last=JSON.parse(body||"{}");console.log("CAPTURED_TOOLS",(last.tools||[]).map(t=>t.function&&t.function.name));console.log("CAPTURED_MESSAGES",(last.messages||[]).map(m=>m.role));res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"capture-ok"}}]}));return;}if(req.url==="/last"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(last,null,2));return;}res.writeHead(200,{"content-type":"application/json"});res.end("{}");});}).listen(5055,()=>console.log("fake LLM on http://127.0.0.1:5055/v1"));'
```

Expected output:

```text
fake LLM on http://127.0.0.1:5055/v1
```

### Step 2: Configure Gateway To Use The Fake LLM

In `tests/manual-config.json`, set:

```json
"llmProxy": {
  "port": 4141,
  "realApiBase": "http://127.0.0.1:5055/v1",
  "realApiKey": "fake-test-key",
  "model": "fake-model"
}
```

Start the gateway in Terminal B:

```powershell
npx tsx src/proxy.ts tests/manual-config.json
```

Wait until indexing finishes and LLM proxy is listening.

### Step 3: Send A Chat Completion Request

Open Terminal C and run:

```powershell
$body = @{
  model = "fake-model"
  messages = @(
    @{ role = "user"; content = "read the package json file and tell me the project name" }
  )
  tools = @()
} | ConvertTo-Json -Depth 20

Invoke-RestMethod -Method Post -Uri "http://localhost:4141/v1/chat/completions" -ContentType "application/json" -Body $body
```

Expected client response:

```text
choices
-------
{@{message=}}
```

or JSON containing:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "capture-ok"
      }
    }
  ]
}
```

Expected fake LLM terminal output includes something like:

```text
CAPTURED_TOOLS [ 'read_file', 'list_directory', 'request_tools', 'batch_call' ]
CAPTURED_MESSAGES [ 'system', 'user' ]
```

The exact matched filesystem tool names depend on the upstream filesystem server version, but `request_tools` and `batch_call` must always be present.

### Step 4: Inspect The Last Captured Request

Run:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:5055/last" | ConvertTo-Json -Depth 50
```

Pass criteria:

- `tools` exists and is not empty.
- `request_tools` is present.
- `batch_call` is present.
- Filesystem-related tools appear for filesystem prompts.
- Unrelated tools are absent or much fewer than the full catalog.
- `messages` includes a gateway-added system message with `Dynamic Semantic Tool Injection` for non-CLI requests.

Fail criteria:

- `tools` is empty.
- `request_tools` or `batch_call` is missing.
- Full upstream catalog is always injected regardless of prompt.
- The request is forwarded to the real provider instead of the fake server.

## Manual Test 5: Dashboard Hot-Add Upstream

Purpose: verify the skipped dashboard hot-reload test manually.

Start the gateway with a temp config:

```powershell
npx tsx src/proxy.ts tests/manual-config.json
```

Open:

```text
http://localhost:4040
```

API baseline check:

```powershell
Invoke-RestMethod -Uri "http://localhost:4040/api/servers" | ConvertTo-Json -Depth 20
```

Expected output includes configured servers with status fields:

```json
[
  {
    "name": "filesystem",
    "status": "connected"
  },
  {
    "name": "terminal",
    "status": "connected"
  }
]
```

Add a second harmless terminal MCP server through the API:

```powershell
$body = @{
  name = "manual-terminal"
  command = "npx"
  args = @("tsx", "src/terminal-server.ts")
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri "http://localhost:4040/api/servers" -ContentType "application/json" -Body $body
```

Expected output:

```json
{
  "success": true,
  "status": "connected"
}
```

Check tools:

```powershell
Invoke-RestMethod -Uri "http://localhost:4040/api/tools" | ConvertTo-Json -Depth 20
```

Expected:

- A `run_terminal_command` tool appears for connected terminal servers.
- Tool rows include `isPinned`, `isDestructive`, and `is_quarantined` fields.

Remove the manual server:

```powershell
Invoke-RestMethod -Method Delete -Uri "http://localhost:4040/api/servers/manual-terminal"
```

Expected output:

```json
{
  "success": true
}
```

Pass criteria:

- Dashboard page loads without browser console errors.
- Server appears after POST without gateway restart.
- Tool list refreshes after add.
- Server disappears after DELETE.
- Temp config is updated consistently.

Fail criteria:

- Duplicate server names are accepted.
- Hot-added server requires restart to appear.
- DELETE removes config but leaves active tools behind.

Cleanup:

- Ensure `manual-terminal` is removed from `tests/manual-config.json`.

## Manual Test 6: Dashboard Live Trace

Purpose: verify WebSocket discovery traces.

Steps:

1. Start fake LLM capture server from Manual Test 4.
2. Start gateway pointing to fake LLM.
3. Open `http://localhost:4040`.
4. Click `Live Trace`.
5. Send a chat completion request through `http://localhost:4141/v1/chat/completions`.

Expected UI result:

- A new trace item appears at the top.
- It shows the prompt text.
- It shows matched tool names and similarity scores.
- It shows estimated tokens saved.
- Fallback traces are labeled as `request_tools Fallback`.

Pass criteria:

- Trace appears without page refresh.
- Newest traces appear first.
- Feed keeps only recent entries.

## Manual Test 7: Approval Gate OS Dialog

Purpose: verify the skipped OS-dialog approval test manually.

Use a harmless tool for this. Recommended manual config change:

```json
"destructiveTools": [
  "list_allowed_directories"
]
```

Start gateway:

```powershell
npx tsx src/proxy.ts tests/manual-config.json
```

In MCP Inspector:

1. Call `request_tools` with query `show filesystem allowed directories`.
2. Call `list_allowed_directories` with `{}`.

Expected behavior:

- OS-native approval dialog appears.
- Gateway waits for your decision.

Deny test expected result:

```text
Error: Execution denied by user in the terminal.
```

Approve test expected result:

```text
Allowed directories:
F:\VS CODE\justbetter-mcp
```

Exact formatting depends on the filesystem server, but the allowed directory list should be returned only after approval.

Pass criteria:

- Deny blocks upstream execution.
- Approve allows upstream execution.
- No MCP stdin prompt is used; approval happens through OS dialog.

Fail criteria:

- Tool runs without approval.
- Deny still runs the tool.
- Dialog command crashes and defaults incorrectly to allow.

Cleanup:

- Remove `list_allowed_directories` from `destructiveTools` after this test.

## Manual Test 8: CLI Agent Loop

Purpose: verify the user-facing CLI agent.

Start:

```powershell
npx tsx src/cli.ts tests/manual-config.json
```

Test casual prompt:

```text
hello
```

Expected:

- Assistant replies conversationally.
- No tool execution log appears.

Test filesystem prompt:

```text
read package.json and tell me the package name
```

Expected:

- CLI starts tool execution.
- It uses the gateway and MCP tools, not direct file access.
- Tool failures trigger retry guidance instead of immediate give-up.
- Large outputs are truncated around `15000` characters.

Exit:

```text
exit
```

Pass criteria:

- CLI connects to gateway.
- Tool loop stops after final assistant response.
- Max-turn guard prevents infinite loops.
- `exit` closes the MCP client and exits.

## Manual Test 9: TUI Agent Loop

Purpose: verify the Ink TUI behavior.

Start:

```powershell
npx tsx src/tui.tsx tests/manual-config.json
```

Expected initial UI:

```text
JustBetter MCP TUI | Gateway Connected | Ready | Follow | PgUp/PgDn Ctrl+U/D Home/End Ctrl+X
```

Manual checks:

- Submit `hello`; expect no tool request for casual chat.
- Submit `read package.json`; expect tool request/running/result events.
- Press `PageUp` and `PageDown`; transcript scrolls.
- Press `Ctrl+X`; latest expandable event expands/collapses.
- Enter `/clear`; transcript clears.
- Enter `/exit`; TUI exits.

Pass criteria:

- TUI remains responsive while gateway connects.
- Tool request, running, success, and failure states render clearly.
- Scroll and expansion controls work.

## Manual Test 10: Security Review

Do this before any real project comparison or demo.

Secrets:

- Rotate any real API key that was ever placed in `config.json`.
- Use fake keys for fake LLM tests.
- Move production secrets to environment variables or the secret manager before real usage.
- Confirm dashboard responses never expose secret values.

Terminal tool:

- Treat `run_terminal_command` as high-risk.
- It is not directory-restricted.
- It can access anything the current OS user can access.
- Do not expose it in untrusted demos without sandboxing or an allowlist.

Dashboard exposure:

- Confirm you only use dashboard on trusted localhost.
- State-changing endpoints currently have no auth.
- Test server/tool names containing HTML only in a sandbox until frontend escaping is fixed.

Filesystem:

- Do not allow `C:\`, `F:\`, or your full home directory as filesystem roots for normal tests.
- Prefer `.test-sandbox` and temp directories for write/delete tests.

## Manual Verification Summary Template

Use this template when recording a manual run:

```text
Date:
Commit:
Config file:
OS:

Automated npm test: PASS / FAIL
MCP static tool list: PASS / FAIL
request_tools fallback: PASS / FAIL
Filesystem allowed directories: PASS / FAIL
LLM proxy fake capture: PASS / FAIL
Dashboard hot-add/remove: PASS / FAIL
Dashboard live trace: PASS / FAIL
Approval deny: PASS / FAIL
Approval approve: PASS / FAIL
CLI loop: PASS / FAIL
TUI loop: PASS / FAIL
Security review: PASS / FAIL

Notes:
```
