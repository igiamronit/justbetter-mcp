# Benchmark run 2026-09-26T12-37-45-050Z

Model `nemotron-3-super` · reasoning_effort `low` · temperature 0 · band `medium` (filesystem, terminal, memory)

## What actually ran

- runs completed: **12**
- runs abandoned: **0**
- total retries beyond the first attempt: **0**
- task restarts after context loss: **0**
- tokens spent: **465566**
- wall clock: **10 min**
- **STOPPED EARLY: token budget (465566 > 450000)** — results below are partial

## Tier 1 — token efficiency

| Arm | Runs | Passed | Total tokens | Prompt | Completion | Tokens/run | Turns/run |
|---|---|---|---|---|---|---|---|
| Mode 1 (semantic injection) | 4 | 4/4 | 77020 | 74735 | 2285 | 19255 | 5.3 |
| Mode 2 (reactive discovery) | 4 | 3/4 | 97442 | 92972 | 4470 | 24361 | 7.5 |
| Mode 3 (inject-all baseline) | 4 | 2/4 | 291104 | 286318 | 4786 | 72776 | 9.8 |

### Per task, total tokens

| Task | Mode 1 | Mode 2 | Mode 3 |
|---|---|---|---|
| `t1-read-count` | 15174 ✓ | 40384 ✗ | 78765 ✗ |
| `t2-file-size-distractors` | 18750 ✓ | 15636 ✓ | 25106 ✓ |
| `t3-csv-sum` | 17746 ✓ | 30738 ✓ | 106413 ✗ |
| `t4-manifest` | 25350 ✓ | 10684 ✓ | 80820 ✓ |

## Tier 2 — tool-calling correctness

| Arm | First tool correct | Wrong tool calls | Gate blocks | Discovery misses |
|---|---|---|---|---|
| Mode 1 (semantic injection) | 2/4 | 4 | 0 | 0 |
| Mode 2 (reactive discovery) | 2/4 | 3 | 0 | 0 |
| Mode 3 (inject-all baseline) | 2/4 | 9 | 0 | 0 |

## Tier 3 — outcomes

| Task | Mode 1 | Mode 2 | Mode 3 |
|---|---|---|---|
| `t1-read-count` | PASS — count.txt=3 expected=3 | FAIL — count.txt=4 expected=3 | FAIL — count.txt=null expected=3 |
| `t2-file-size-distractors` | PASS — size.txt=2048 expected=2048 | PASS — size.txt=2048 expected=2048 | PASS — size.txt=2048 expected=2048 |
| `t3-csv-sum` | PASS — total.txt=1740 expected=1740 | PASS — total.txt=1740 expected=1740 | FAIL — total.txt=null expected=1740 |
| `t4-manifest` | PASS — lines=["alpha.txt","beta.txt","gamma.txt"] expected=["alpha.txt","beta.txt","gamma.txt"] | PASS — lines=["alpha.txt","beta.txt","gamma.txt"] expected=["alpha.txt","beta.txt","gamma.txt"] | PASS — lines=["alpha.txt","beta.txt","gamma.txt"] expected=["alpha.txt","beta.txt","gamma.txt"] |

## Caveats

- Tokens are provider-reported `usage`, counted by the harness from the response it received, identically for all three arms.
- One repetition per cell. These numbers are **directional**, not significant.
- Reasoning tokens are included in `completion`, pinned to the same effort for every arm.
- Money and prompt caching are deliberately not measured. Do not read this as a cost claim.
- One model. A result here is a result about this model.
