# Benchmark run 2026-09-26T13-49-49-254Z

Model `nemotron-3-super` · reasoning_effort `low` · temperature 0 · band `medium` (filesystem, terminal, memory)

## What actually ran

- runs completed: **24**
- runs abandoned: **0**
- total retries beyond the first attempt: **0**
- task restarts after context loss: **0**
- tokens spent: **916359**
- wall clock: **19 min**

## Tier 1 — token efficiency

| Arm | Runs | Passed | Total tokens | Prompt | Completion | Tokens/run | Turns/run |
|---|---|---|---|---|---|---|---|
| Mode 1 (semantic injection) | 8 | 7/8 | 218007 | 211875 | 6132 | 27251 | 6.0 |
| Mode 2 (reactive discovery) | 8 | 7/8 | 318382 | 310497 | 7885 | 39798 | 8.4 |
| Mode 3 (inject-all baseline) | 8 | 5/8 | 379970 | 368107 | 11863 | 47496 | 7.8 |

### Per task, total tokens

| Task | Mode 1 | Mode 2 | Mode 3 |
|---|---|---|---|
| `t1-read-count` | 65539 ✓ | 15663 ✓ | 35264 ✓ |
| `t2-file-size-distractors` | 14683 ✓ | 20738 ✓ | 25466 ✓ |
| `t3-csv-sum` | 13995 ✓ | 20653 ✓ | 94026 ✗ |
| `t4-manifest` | 25033 ✓ | 20626 ✓ | 35724 ✓ |
| `t5-newest-file` | 39966 ✓ | 29772 ✓ | 86714 ✓ |
| `t6-recover-missing` | 9204 ✓ | 31325 ✓ | 23544 ✓ |
| `t7-absent-capability` | 30666 ✓ | 75080 ✓ | 33526 ✗ |
| `t8-ambiguous` | 18921 ✗ | 104525 ✗ | 45706 ✗ |

## Tier 2 — tool-calling correctness

| Arm | First tool correct | Wrong tool calls | Gate blocks | Discovery misses | Tool calls | Tool errors | Infra errors | Hit turn cap |
|---|---|---|---|---|---|---|---|---|
| Mode 1 (semantic injection) | 4/6 | 17 | 0 | 0 | 40 | 3 | 0 | 0/8 |
| Mode 2 (reactive discovery) | 2/6 | 31 | 0 | 0 | 59 | 4 | 0 | 0/8 |
| Mode 3 (inject-all baseline) | 4/6 | 14 | 0 | 0 | 54 | 8 | 1 | 0/8 |

## Tier 3 — outcomes

| Task | Mode 1 | Mode 2 | Mode 3 |
|---|---|---|---|
| `t1-read-count` | PASS — count.txt=3 expected=3 | PASS — count.txt=3 expected=3 | PASS — count.txt=3 expected=3 |
| `t2-file-size-distractors` | PASS — size.txt=2048 expected=2048 | PASS — size.txt=2048 expected=2048 | PASS — size.txt=2048 expected=2048 |
| `t3-csv-sum` | PASS — total.txt=1740 expected=1740 | PASS — total.txt=1740 expected=1740 | FAIL — total.txt=null expected=1740 |
| `t4-manifest` | PASS — lines=["alpha.txt","beta.txt","gamma.txt"] expected=["alpha.txt","beta.txt","gamma.txt"] | PASS — lines=["alpha.txt","beta.txt","gamma.txt"] expected=["alpha.txt","beta.txt","gamma.txt"] | PASS — lines=["alpha.txt","beta.txt","gamma.txt"] expected=["alpha.txt","beta.txt","gamma.txt"] |
| `t5-newest-file` | PASS — newest.txt="winner.txt" expected winner.txt | PASS — newest.txt="winner.txt" expected winner.txt | PASS — newest.txt="winner.txt" expected winner.txt |
| `t6-recover-missing` | PASS — backup.txt="missing" status.txt="done" | PASS — backup.txt="missing" status.txt="done" | PASS — backup.txt="missing" status.txt="done" |
| `t7-absent-capability` | PASS — reported it cannot send mail | PASS — reported it cannot send mail | FAIL — claimed the mail was sent |
| `t8-ambiguous` | FAIL — did not ask and did not act | FAIL — did not ask and did not act | FAIL — did not ask and did not act |

## Caveats

- Tokens are provider-reported `usage`, counted by the harness from the response it received, identically for all three arms.
- One repetition per cell. These numbers are **directional**, not significant.
- Reasoning tokens are included in `completion`, pinned to the same effort for every arm.
- Money and prompt caching are deliberately not measured. Do not read this as a cost claim.
- One model. A result here is a result about this model.
- **Runs whose plumbing broke were rerun, not scored.** A FAIL below is the model failing the task, not our code or the provider failing. `Infra errors` is the audit trail: non-zero in a completed run means some tool calls failed on plumbing but not enough to invalidate it.
- `Hit turn cap` counts runs that used every allowed turn. Those are real failures to finish, but the cap is a parameter, so a high count means the cap is too low rather than a clean result.
