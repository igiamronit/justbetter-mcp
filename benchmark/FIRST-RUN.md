# First benchmark run — 26 Sep 2026

Read this first. Raw data is in `benchmark/results/2026-09-26T12-37-45-050Z/`.

Model `nemotron-3-super` on Ollama Cloud · `reasoning_effort: low` · `temperature: 0` ·
catalog band `medium` (filesystem + terminal + memory, 26 tools) · one repetition per cell.

## Headline

**Mode 1 was both the cheapest and the only arm that passed everything.**

| Arm | Tokens/run | vs Mode 1 | Passed | Turns/run |
|---|---|---|---|---|
| **Mode 1** — semantic injection | **19,255** | — | **4/4** | 5.3 |
| Mode 2 — reactive discovery | 24,361 | 1.27× | 3/4 | 7.5 |
| Mode 3 — inject-all baseline | 72,776 | 3.78× | 2/4 | 9.8 |

Per task, total tokens:

| Task | Mode 1 | Mode 2 | Mode 3 |
|---|---|---|---|
| `t1-read-count` | 15,174 ✓ | 40,384 ✗ | 78,765 ✗ |
| `t2-file-size-distractors` | 18,750 ✓ | 15,636 ✓ | 25,106 ✓ |
| `t3-csv-sum` | 17,746 ✓ | 30,738 ✓ | 106,413 ✗ |
| `t4-manifest` | 25,350 ✓ | 10,684 ✓ | 80,820 ✓ |

Note Mode 2 wins two of the four tasks outright. The per-run average favours Mode 1, but the
task-level picture is mixed, which is what one repetition on four tasks should look like.

## The prompt/completion split — the mechanism, measured

This is the part worth keeping, because it is the first direct evidence for the mechanism
`README.md` item 1 asserts.

| Arm | Prompt/run | Completion/run | Completion share |
|---|---|---|---|
| Mode 1 | 18,683 | 571 | 3.0% |
| Mode 2 | 23,243 | **1,117** | **4.6%** |
| Mode 3 | 71,579 | 1,196 | 1.6% |

**Mode 2 spends roughly twice the completion tokens of Mode 1.** Completion is where reasoning
lands on this model, and Mode 2's extra reasoning is exactly the "pause and work out which tool to
search for" step. The README claimed that costs something; here it costs about 2× the output
tokens and two extra turns per task.

That is the finding I would build on.

## What actually ran

- **12 of 24 runs completed.** The run stopped itself at 465,566 tokens against a 450,000 cap,
  as designed, at a task boundary — so tasks 1–4 have complete triples and tasks 5–8 have none.
- **0 abandoned, 0 retries, 0 context-loss restarts.** Nothing was papered over.
- 10 minutes wall clock.

## Honest problems with these numbers

**1. The Mode 3 arm is contaminated and its numbers are an upper bound, not a baseline.**
`src/llm-proxy.ts` splices in a `[CRITICAL GATEWAY INSTRUCTIONS]` system message telling the model
it must call `request_tools` before using capabilities — and it does that regardless of
`injectAllTools`. So Mode 3 is told to go discover tools it has already been handed. On `t1` it
called `list_directory` once and then `request_tools` **nine times in a row**, burning 78,765
tokens to fail a task Mode 1 passed in five turns and 15k. Some of that is genuinely what a Mode 3
user experiences, but it is *discovery* cost, not the *schema-carrying* cost the README means by
Mode 3. Fix is specified in `BENCHMARK.md`: Mode 3 must bypass the proxy and get the full catalog
from the upstream servers directly.

**2. `t1` was a badly written task and Mode 2's failure on it is not Mode 2's fault.**
The fixture is `alpha\nbeta\ngamma\n`. Asked "how many lines", Mode 2 answered **4** — which is
what splitting on newlines gives you. My verifier demanded 3. Both answers are defensible, so the
task was ambiguous, not the arm wrong. The prompt now says "non-empty lines". **Mode 2's 3/4 should
be read as 4/4 for anything other than that verifier.**

**3. One repetition, four tasks, one model.** Directional only. Nothing here supports a
significance claim, and `t2` and `t4` already show Mode 2 beating Mode 1, so the per-run average is
not a stable ordering.

**4. `offered=2` in the logs is expected, not a bug.** `tools/list` returns only `request_tools`
and `batch_call`, because that is the Mode 2 surface. The real tool surface shows up as
`injectedPeak` (15–16 for Mode 1, 26 for Mode 3, 0 for Mode 2 which never uses the proxy).

## Bugs found while building this

Three, all of which would have produced confident nonsense:

1. **Health check hit the wrong path.** The harness polled `/v1/health`; the proxy serves `/health`
   at the root. Every single run abandoned with "our proxy never answered". Caught because all
   three arms failed identically, which is never a real result.
2. **Mode 1 was starved of its own system prompt.** The proxy swaps a `JUSTBETTER_CLI_AGENT`
   sentinel for Mode 1's real instructions. The harness sent its own prompt instead, so Mode 1 had
   nothing telling it that injected tools are ready to call — it looped on `request_tools` six
   times and failed a trivial task. Had I not checked, Mode 1 would have "lost" its own benchmark.
3. **The turn cap was the binding constraint.** All three arms hit exactly 6 turns on the trivial
   task, so the cap was shaping the outcome rather than the mode. Caps raised to 10–14.

## What I did not do

- Did not run tasks 5–8 (`t5` retrieval-on-a-bad-query, `t6` recovery from failure, `t7` absent
  capability, `t8` ambiguity). These are the interesting ones for Tier 2 and Tier 3 and they need
  another ~350k tokens.
- Did not run Q3 (cost vs catalog size), which is the most valuable question in the design.
- Did not repeat anything, so there is no variance figure.

## Suggested next steps, in order

1. **Fix the Mode 3 arm** so it is a real baseline. Until then Mode 3's 3.78× is not quotable.
2. **Run tasks 5–8** with the same band. Budget roughly 350k tokens.
3. **Run Q3** — task 3 across the four catalog bands, 12 runs. This produces the tokens-per-extra-tool
   slope, which is the number that generalises beyond the catalog we happened to test.
4. Only then consider repetitions for variance.

Roughly 635k tokens of the Ollama free-tier quota went on this session, including the smoke runs
that found the three bugs. I stopped rather than push further into an unpublished monthly quota
without you awake to weigh it.
