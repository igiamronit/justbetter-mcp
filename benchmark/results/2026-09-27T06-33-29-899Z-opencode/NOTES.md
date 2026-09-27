# Corrections applied to this run

1. **Cached prompt tokens are additive.** `tokens_input` excludes what came from cache, so the
   originally recorded totals understated the prompt by about 36%. Verified on `t7`: one turn
   reported `input 13,441 / cache 0`, the next `input 5,051 / cache 8,448`. Totals here are now
   `input + cache_read + output + reasoning`, which is the whole prompt the arm sent and is what
   the other three arms' provider reported in `usage.prompt_tokens`.

2. **`t5-newest-file` was dropped and re-run.** The runner wrote `opencode.json` into the task
   workspace after the fixture, so it was genuinely the most recently modified file. The model
   answered `opencode.json` and was correct; the verifier called it a failure. That is a harness
   defect, not a model failure, so the row was voided rather than scored. The runner now
   back-dates its config file and keeps the memory server's store outside the workspace.

3. `t6-recover-missing` is a real model failure, kept as such: `finish: "length"` after emitting
   32,000 output tokens in a single turn without completing the task.

4. **A claim that was made and then withdrawn.** This arm was first reported as never having called
   an MCP tool at all, on the basis of a single smoke-test run rather than the eight recorded ones.
   That was wrong. OpenCode called the MCP tools 6 times out of 38 tool calls, on 3 of the 8 tasks,
   and solved `t3-csv-sum` with nothing else. The servers were connected and permitted the whole
   time -- six successful calls prove the schemas were in the tool array, and `action=allow` was
   logged for each. Rows now carry `opencode.toolsCalledRaw`, `mcpToolCalls` and `builtinToolCalls`
   so the split is recorded rather than inferred, because the normalised `toolsCalled` field strips
   the server prefix and hides it.
