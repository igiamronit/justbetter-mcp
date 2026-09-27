# OpenCode arm A - plain OpenCode

`ollama-cloud/nemotron-3-super`, variant `low`, catalog 26 tools (filesystem + terminal + memory),
same eight tasks and the same programmatic verifiers as the gateway benchmark.

Totals are `input + cache_read + output + reasoning`. See NOTES.md for the two corrections applied.

| Task | Tokens | Turns | Result | Finish |
|---|---|---|---|---|
| `t1-read-count` | 81,905 | 6 | pass | stop |
| `t2-file-size-distractors` | 40,386 | 3 | pass | stop |
| `t3-csv-sum` | 67,326 | 5 | pass | stop |
| `t4-manifest` | 59,038 | 4 | pass | stop |
| `t5-newest-file` | 40,433 | 3 | pass | stop |
| `t6-recover-missing` | 45,282 | 1 | **fail** | length |
| `t7-absent-capability` | 3,14,577 | 20 | **fail** | stop |
| `t8-ambiguous` | 54,725 | 4 | pass | stop |

**8 tasks, 6 passed, 7,03,672 tokens, 87,959 mean per run, 15,297 per turn.**

OpenCode never called a single MCP tool - it solved every task with its own built-in `read`,
`write`, `bash` and `list`. The 26 MCP schemas were carried in every request and never used, which
is the carrying cost this project exists to remove.

Caveat: OpenCode contributes its own system prompt and its own built-in tools, so the gap to
mode1/mode2/mode3 is not purely tool delivery.
