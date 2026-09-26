# Token-Efficiency Benchmark — Results

Run `2026-09-26T13-49-49-254Z` · 24 of 24 runs completed · 0 abandoned · 0 reruns ·
916,359 provider-reported tokens.

Design in `BENCHMARK.md`. Raw data in `benchmark/results/2026-09-26T13-49-49-254Z/`.

## 1. Summary

Three tool-delivery strategies were compared on eight verifiable tasks with one model and one
tool catalog. Mode 1 (semantic injection) was cheapest on every aggregate and used the fewest
turns. Mode 3 (inject-all) was both the most expensive and the least reliable.

The mechanism matters more than the totals: **per-turn cost was almost identical between Mode 1
and Mode 2 (4,542 vs 4,752 tokens). Mode 1's advantage came entirely from needing 29% fewer turns
to finish.** That is the claim in `README.md` — that pre-injecting schemas spares the model from
reasoning about which tool to fetch — expressed as turn count rather than as tokens per turn.

Two genuine bugs in the gateway were found during this work and fixed. Their measured effect was
larger than the difference between the modes, which is reported in section 6.

## 2. Setup

| | |
|---|---|
| Model | `nemotron-3-super` (Ollama Cloud, OpenAI-compatible endpoint) |
| Decoding | `temperature: 0`, `reasoning_effort: low`, no seed |
| Catalog | 26 tools: `filesystem` + `terminal` + `memory` |
| Turn cap | 20 per task |
| Tasks | 8, each with a programmatic verifier |
| Repetitions | 1 per cell |

Arms, all sharing one agentic loop with only the tool source differing:

- **Mode 1** — semantic injection. Harness posts to the gateway's proxy, which injects the top 5
  semantic matches plus up to 8 carry-over tools plus two fallbacks. The harness sends no tools.
- **Mode 2** — reactive discovery. Harness posts straight to the provider and supplies the tools
  the gateway advertises, **re-listed every turn**, as a real MCP client does after
  `tools/list_changed`.
- **Mode 3** — inject-all baseline. Every tool in the catalog, every turn, no retrieval.

Token counts are the provider's own `usage` object, read by the harness from the response it
received, identically for all three arms.

## 3. Headline results

| Arm | Mean tok/run | Median tok/run | Tok/turn | Turns/run | Passed |
|---|---|---|---|---|---|
| **Mode 1** — semantic injection | **27,251** | **21,977** | **4,542** | **6.0** | 7/8 |
| Mode 2 — reactive discovery | 39,798 | 25,255 | 4,752 | 8.4 | 7/8 |
| Mode 3 — inject-all baseline | 47,496 | 35,494 | 6,129 | 7.8 | 5/8 |

**Use the median.** Cost per run varies by 4–7× within a single arm (section 7), so the mean is
dragged around by one unlucky run. By median, Mode 1 is **13% cheaper than Mode 2** and **38%
cheaper than Mode 3** — a much more modest claim than the means suggest, and the defensible one.

## 4. Where the tokens go

| Arm | Prompt/run | Completion/run | Completion share | Prompt/turn | Completion/turn |
|---|---|---|---|---|---|
| Mode 1 | 26,484 | 766 | 2.8% | 4,414 | 127 |
| Mode 2 | 38,812 | 985 | 2.5% | 4,634 | 117 |
| Mode 3 | 46,013 | 1,482 | 3.1% | 5,937 | 191 |

Cost is **97% prompt** in every arm. Completion is a rounding error, so anything that re-sends the
transcript and the tool surface per turn dominates, and the number of turns is therefore the
lever that matters.

An earlier draft of this work claimed Mode 2 spent roughly twice Mode 1's completion tokens
reasoning about which tool to fetch. **That claim does not survive the corrected harness.** Per
turn, Mode 2's completion cost is marginally *lower* than Mode 1's (117 vs 127). The cost of
reactive discovery shows up as extra turns, not as extra thinking inside a turn.

### Tool surface carried, and how much of it was wasted

| Arm | Schemas carried (median) | Distinct tools actually used | Never called |
|---|---|---|---|
| Mode 1 | 15 | 3 | 80% |
| Mode 2 | 12 | 4 | 67% |
| Mode 3 | 26 | 3 | 88% |

Every arm carries far more than it uses. Mode 1 pays for 15 schemas per turn to use 3; the
retrieval is doing real work relative to Mode 3's 26, but a top-5 match plus 8 carry-over is
still around 5× the tools any of these tasks needed. **This is the clearest remaining
optimisation target, and it was deliberately not tuned for this run** — see section 8.

Fixed cost of the tool surface, measured as the prompt jump when schemas first appear: about
**2,500 tokens** for Mode 1 and Mode 2, about **5,100** for Mode 3. Note that Mode 3's surface
appears one turn later than the others because the gateway indexes its catalog asynchronously at
startup, so the first turn or two of every run is under-provisioned. That affects all arms
equally and is a measurement artifact worth removing in a future run.

## 5. Per-task results

Tokens, with P for pass and F for fail.

| Task | Mode 1 | Mode 2 | Mode 3 |
|---|---|---|---|
| `t1-read-count` | 65,539 P | 15,663 P | 35,264 P |
| `t2-file-size-distractors` | 14,683 P | 20,738 P | 25,466 P |
| `t3-csv-sum` | 13,995 P | 20,653 P | 94,026 **F** |
| `t4-manifest` | 25,033 P | 20,626 P | 35,724 P |
| `t5-newest-file` | 39,966 P | 29,772 P | 86,714 P |
| `t6-recover-missing` | 9,204 P | 31,325 P | 23,544 P |
| `t7-absent-capability` | 30,666 P | 75,080 P | 33,526 **F** |
| `t8-ambiguous` | 18,921 **F** | 104,525 **F** | 45,706 **F** |

Mode 2 wins three of the eight tasks outright, so the ordering is not uniform.

## 6. Bugs found, and what fixing them was worth

Both were found by looking at *why* an arm was expensive rather than accepting the number. Each
is a defect in the gateway, not in the benchmark, and each is fixed with a regression test.

### 6.1 Carry-over was ordered alphabetically, not by recency

`getRecentlyInjectedTools` selected the most recent 8 tools with
`ORDER BY injected_at DESC, tool_name ASC`. But `injected_at` is `CURRENT_TIMESTAMP`, which
resolves only to the second, so every tool injected in one turn carried an identical timestamp.
The recency sort was a no-op and the real ordering was the tiebreak: **alphabetical by tool name.**

Among the filesystem tools, `write_file` sorts last. It could never survive an 8-slot window. On
any task that reads and then writes, the model discovered `write_file`, lost it, and rediscovered
it — measured at **ten consecutive `request_tools` calls on one task**.

Fixed with a monotonic sequence counter, so the ordering is the recency the query always claimed.

### 6.2 The model's own discoveries were outranked by routine injections

`markToolInjected` was called for every injected tool on every turn — 15 or more — and also for
tools the model explicitly requested through `request_tools`. Both went into the same pool with
equal standing, so 15 routine injections evicted the one tool the model had gone looking for. The
code comment said "recently **requested** tools"; nothing tracked requests.

Fixed: requested tools carry a flag that outranks routine injections, and it is sticky for the
session so a later injection cannot silently demote them.

### 6.3 Measured effect

Same two tasks, same model, before and after:

| Task | Mode 1 before | Mode 1 after | Change |
|---|---|---|---|
| `t1-read-count` | 76,305 / 10 turns | 10,788 / 4 turns | −86% |
| `t2-file-size-distractors` | 149,892 / 15 turns | 11,382 / 4 turns | **−92%** |

**These fixes were worth far more than the difference between any two modes.** Before them Mode 1
looked like the most expensive arm; after them it is the cheapest.

### 6.4 A third fix, in the prompt

The tool-access section of the system prompt always asserted that "capabilities listed below are
NOT yet loaded — you must call `request_tools`", followed by the list of tools *not* injected this
turn. When that list is empty — always true for `injectAllTools`, and true for Mode 1 whenever
retrieval covers the catalog — the instruction is false, and the model obeyed it anyway: one
`list_directory` followed by nine `request_tools` calls, 78,765 tokens, failed task. The
instruction is now issued only when something is genuinely undiscovered. On that task the cost
fell to 33,205 tokens and it passed.

### 6.5 A harness bug, for completeness

The harness originally listed the gateway's tools once, outside the agentic loop, so Mode 2
carried 2 schemas per turn while Mode 1 carried 15. That understated Mode 2's cost by roughly
half and would have produced a false result in Mode 2's favour. It now re-lists every turn.

## 7. Variance, and why single runs cannot settle this

Within a single arm, cost per task spans:

| Arm | Min | Median | Max | Spread |
|---|---|---|---|---|
| Mode 1 | 9,204 | 21,977 | 65,539 | 7.1× |
| Mode 2 | 15,663 | 25,255 | 104,525 | 6.7× |
| Mode 3 | 23,544 | 35,494 | 94,026 | 4.0× |

Some of that is task difficulty. Some is not: `t1-read-count` in Mode 1 cost **10,788 tokens in
4 turns** in one run and **65,539 in 10 turns** in another, with identical code, identical inputs
and `temperature: 0`. The model emits reasoning and no seed was set, so runs are not reproducible.

**Consequence: the per-arm ordering in section 3 is directional, not significant.** One
repetition per cell cannot separate a 13% median difference from noise of this size. Anyone
quoting these numbers should quote the medians, the spread, and this paragraph.

## 8. Failures, examined individually

Per the rule that infrastructure and provider faults must never be scored against a mode: **0
runs were abandoned and 0 were rerun.** Every failure below is the model failing the task.

- **`t3-csv-sum`, Mode 3 (94,026 tokens, 11 turns).** Called `request_tools` eight times despite
  being told explicitly that every tool was already in its array and not to. `batch_call`'s own
  description mentions "any tool name returned by `request_tools`", which may nudge it. Model
  behaviour against an explicit instruction, not a prompt defect this time.
- **`t7-absent-capability`, Mode 3.** Claimed the email was sent. There is no email tool. This is
  the failure mode the task exists to catch, and only the inject-all baseline fell for it.
- **`t8-ambiguous`, all three arms.** The task asks the model to "clean up my working folder",
  where the correct behaviour is to ask what that means. **No arm asked.** None destroyed data
  either — `keep.txt` survived in all three. Mode 2 spent 104,525 tokens and 17 turns, including
  eight consecutive `search_files` calls, exploring instead of asking.

  The verifier for this task requires a literal `?` in the assistant's text, which is crude. Read
  this row as "no arm sought clarification, none destroyed data" rather than as a clean
  three-way failure.

## 9. Threats to validity

- **One repetition.** See section 7. This is the dominant limitation.
- **One model.** A result on `nemotron-3-super` is a result about that model. Mistral was
  considered as a second model and dropped: its free tier is too degraded for clean runs.
- **Eight tasks**, all filesystem-and-shell shaped, written by the same person holding the
  hypothesis. The task set and its verifiers ship with the results so the choices can be
  disputed.
- **Tokens, not money.** Prompt caching is left enabled but not measured. Mode 3's prompt is the
  most static and will cache best, so its real-world *cost* is lower than its token count implies.
  Nothing here is a cost claim.
- **Reasoning tokens** are included in completion and pinned to the same effort for every arm, so
  these totals are not comparable to a non-reasoning model's.
- **Mode 2's harness is not Claude Desktop or Cursor.** Those bring their own prompts and loops.
  This measures the mode, not those products.
- **Catalog indexing is asynchronous**, so the first turn or two of every run carries only the
  fallback tools. Affects all arms; should be waited out in a future run.
- **Retrieval breadth was not tuned.** Mode 1 carries 15 schemas to use 3. Widening or narrowing
  the top-5 match and the 8-tool carry-over was deliberately left alone so this run measures the
  shipped configuration, not a configuration chosen to win.

## 10. What would strengthen this

In order of value per token spent:

1. **Repetitions.** Three per cell would turn section 3 from directional into arguable. This is
   the only change that addresses the dominant limitation.
2. **Catalog scaling (Q3 in the design).** One task across 10/25/50/100 tools, reporting tokens
   per additional tool. A slope predicts catalog sizes nobody tested, which is what the project's
   premise needs.
3. **A fixed seed**, to separate model nondeterminism from real effects.
4. **Tuning retrieval breadth** now that the carry-over bug is fixed — 80% of carried schemas
   were never called.

## 11. Reproducing

```
node benchmark/catalog.mjs          # measure the tool catalog, no API cost
npx tsx benchmark/run.ts            # full suite
node benchmark/status.mjs           # progress and interim results, safe mid-run
BENCH_RESUME=<dir> npx tsx benchmark/run.ts   # continue an interrupted run
```

Environment: `BENCH_MODEL`, `BENCH_BAND` (`small`/`medium`/`large`), `BENCH_TASKS` (comma list),
`BENCH_BUDGET_TOKENS`, `BENCH_BUDGET_MINUTES`, `BENCH_REASONING`.
