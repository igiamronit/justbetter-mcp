# OpenCode arm A - plain OpenCode

`ollama-cloud/nemotron-3-super`, variant `low`, catalog 26 tools (filesystem + terminal + memory),
same eight tasks and the same programmatic verifiers as the gateway benchmark.

Totals are `input + cache_read + output + reasoning`. See NOTES.md for the corrections applied.

| Task | Tokens | Turns | Result | Finish | MCP calls | Built-in calls |
|---|---|---|---|---|---|---|
| `t1-read-count` | 81,905 | 6 | pass | stop | 0 | 5 |
| `t2-file-size-distractors` | 40,386 | 3 | pass | stop | 1 | 1 |
| `t3-csv-sum` | 67,326 | 5 | pass | stop | 4 | 0 |
| `t4-manifest` | 59,038 | 4 | pass | stop | 1 | 2 |
| `t5-newest-file` | 40,433 | 3 | pass | stop | 0 | 2 |
| `t6-recover-missing` | 45,282 | 1 | **fail** | length | 0 | 0 |
| `t7-absent-capability` | 3,14,577 | 20 | **fail** | stop | 0 | 19 |
| `t8-ambiguous` | 54,725 | 4 | pass | stop | 0 | 3 |

**8 tasks, 6 passed, 7,03,672 tokens, 87,959 mean per run, 15,297 per turn.**

## Tool usage

OpenCode called the MCP tools **6 times out of 38 tool calls**, on 3 of the 8 tasks. On `t3-csv-sum` it used nothing else: `benchfs_list_directory`, `benchfs_read_text_file`, `benchfs_write_file`.

The remaining 32 calls went to its own built-ins, overwhelmingly `bash`. That is a
preference rather than a defect -- one `bash` call does `ls`, `cat` and `wc` in a single step where
the MCP route needs one call each. The servers were connected and permitted throughout: the six
successful calls prove the schemas were in the tool array, and OpenCode logged
`action=allow` for each one.

So the 26 MCP schemas were carried on every turn and used on three tasks. Mostly, not entirely,
dead weight -- which is still the carrying cost this project exists to remove, but it should not be
described as the tools never being touched.

## Caveat

OpenCode contributes its own system prompt and its own built-in tools, so the gap between this arm
and mode1/mode2/mode3 is not purely tool delivery.
