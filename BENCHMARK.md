# Token-Efficiency Benchmark — Design

Design only. No script yet; this is the specification it has to satisfy.

All of this lands on a dedicated branch, `benchmark`, because it needs changes to shipped code
(an Ollama provider, extra columns in the token log) that should not reach `main` until the
results justify them.

## Why this exists

`README.md` already publishes a token comparison: `mistral-large-latest`, four servers, two
prompts, Mode 1 vs Mode 2 vs Mode 3 vs OpenCode. Two prompts and one model is enough to show a
direction. It is not enough to defend a claim, because it answers one question — "which arm used
fewer tokens on these two prompts" — and a reader can reasonably ask whether that survives a
different model, a bigger tool catalog, a longer conversation, or a provider that prices output
tokens at five times input.

The goal here is a result that holds up to those questions. **Token efficiency is the primary
measurement.** Tool-calling correctness is second, because an arm that saves tokens by calling
the wrong tool has saved nothing. Output quality is third, because it is the hardest to measure
honestly and the easiest to argue about.

## Measurement order

Deliberate. Each tier is worth publishing on its own, and each is gated on the one before it, so
an exhausted quota costs the weakest claims rather than the strongest.

### Tier 1 — Token efficiency (primary)

Seven questions, plus one that depends on what the provider reports.

**Q1. What does a whole task cost, end to end?**
Sum every turn's `total_tokens` from first prompt to verified completion, per arm. This is the
headline economic number and the direct successor to the published charts.

**Q2. What does the tool surface cost per turn, before any work?**
A trivial task needing exactly one tool. Isolates the fixed per-turn cost of carrying the tool
surface from the cost of the task itself. Mode 3 pays for the whole catalog on every turn; Mode 1
pays for the matched subset; Mode 2 pays for `request_tools` plus whatever it has accumulated.

**Q3. How does cost scale as the catalog grows?** — the most valuable question here, and new.
Run one fixed task at roughly 10, 25, 50 and 100 tools by enabling progressively more MCP
servers, then fit a line per arm and report the **slope in tokens per additional tool**. Mode 3
should be steeply linear; Mode 1 and Mode 2 should be near flat. A slope is far more defensible
than a bar chart because it predicts catalog sizes nobody tested — and the whole premise of the
project is that people keep adding servers.

**Q4. How does cost scale as the conversation grows?**
Tokens per turn against turn index, on a task that runs 8+ turns. The arms diverge structurally:
Mode 1 re-injects a fresh matched set every turn; Mode 2 accumulates advertised schemas, bounded
at `ADVERTISED_LIMIT = 24` with oldest-first eviction. Whether that accumulation overtakes
repeated injection on long tasks is exactly the README's "long-running tasks" claim, expressed in
tokens instead of adjectives.

**Q5. How does the cost split between prompt and completion?**
Both are already logged separately. This matters because the two are not priced the same —
output typically costs three to five times input. Mode 2 spends **completion** tokens reasoning
about which tool to fetch; Mode 1 spends **prompt** tokens on injection. So an arm can win on raw
token count and lose on money. If that happens it is the most interesting result in the whole
exercise, and it is invisible to anyone who only reports totals.

**Q6. What does it cost in money?**
Apply published per-token prices to Q5's split, for the benchmark model and for Gemini and
Mistral as reference points. Report the price table used and the date, because prices move and a
cost claim without them is unfalsifiable.

**Q7. How many tokens were spent on tools that were never called?**
`tools_injected` is already logged per turn. Compare against the tools actually invoked, and
price the difference. This converts retrieval precision into the same unit as everything else,
and it is the cleanest single number for "is the semantic search any good".

**Q8 (conditional). Does prompt caching change the answer?**
Mode 3's giant prompt is nearly static across turns and may cache extremely well; Mode 1's
injection changes every turn and may cache badly. If that holds, Mode 3's effective cost is much
lower than its token count suggests. This is only measurable if the provider reports cached
tokens. Ollama's OpenAI-compatibility page documents `stream_options.include_usage` but does not
document the response schema, so **whether `usage` exists at all is a preflight check, and cached
tokens are a maybe.** If they are not reported, this question is recorded as an unmeasured
limitation rather than guessed at.

### Tier 2 — Tool-calling correctness

Token savings mean nothing if the arm picks the wrong tool, so Tier 1's numbers are only
interpretable next to these:

- `firstToolCorrect` — was the first tool call the right one
- `wrongToolCalls` — calls to tools irrelevant to the task
- `gateBlocks` — hallucinated tool names stopped by the hallucination gate
- `discoveryMisses` — Mode 2 only: `request_tools` returning "No matching tools found"
- `turns` — round trips to completion

### Tier 3 — Output quality

Last, and scoped tightly to what can be checked without argument:

- `passed` — a programmatic verifier over the workspace, not a model's opinion
- `recovered` — on the task with a deliberate mid-way failure, did it finish anyway
- `refusedCorrectly` — on the task whose capability genuinely does not exist, did it say so
  instead of inventing a tool

No LLM-as-judge in any headline number: it burns the same quota under measurement and adds a
second model's variance to the thing being measured. It can be added later as a secondary rubric.

## How it is measured

### The instrument

`src/llm-proxy.ts` already appends one row per turn to `token_log.csv`:

    timestamp, prompt_tokens, completion_tokens, total_tokens, tools_injected

That is provider-reported usage, and it is what produced the published charts. Reusing it keeps
the new numbers comparable to the old ones instead of starting a second, incompatible history.

Two changes are needed, both on the `benchmark` branch:

1. **Extra columns** — `run_id, mode, task_id, turn_index, catalog_size` — so rows from different
   arms and tiers can be separated without guessing from timestamps.
2. **Mode 2 has to log too.** It never touches the HTTP proxy, so today nothing records it. The
   harness owns that loop and must write the same rows in the same format. If Mode 2's numbers
   come from a different code path with a different definition of a turn, the comparison is void.

### Source of truth, and a cross-check

Provider-reported `usage` is authoritative. But a benchmark that trusts a single unverified
field deserves what it gets, so the harness also counts tokens independently with a local
tokenizer and **reports the delta**. A systematic gap means either the tokenizer is wrong or the
provider's accounting is, and either way the reader should see it rather than inherit it.

If `usage` turns out to be absent, everything falls back to the tokenizer and every number in the
report is labelled `ESTIMATED`. That is a much weaker result and the report must say so loudly
rather than quietly presenting estimates as measurements.

### Provider

Verified against Ollama's own documentation, not aggregator sites:

- OpenAI-compatible base for cloud is `https://ollama.com/v1`, so chat completions live at
  `https://ollama.com/v1/chat/completions`
- Auth is `Authorization: Bearer $OLLAMA_API_KEY`
- **`tools` is supported; `tool_choice` is not.** We never send `tool_choice` anywhere in `src/`,
  so this costs nothing today, and the preflight asserts it stays true
- Free tier: **one concurrent request**, starter credits, usage resets **monthly from the signup
  date**, metered by **GPU time rather than tokens**, and rate limits are **not published**

Consequences: everything runs strictly serial; the budget cannot be computed up front, only
measured and extrapolated; and exhausting the quota costs weeks, so resuming without losing
finished work is structural, not a nicety.

`config.json` already carries an `ollamaApiKey`, but it is **inert** — `PROVIDER_BASES` in
`src/config.ts` holds only `gemini` and `mistral`, and `getProviderBase` falls back to Gemini for
anything else. Adding Ollama as a provider (base URL, key resolution, the `PROVIDER_*` tables in
`src/tui/session.ts`, and `verifyApiKey` against `/v1/models`) is the first commit on the branch,
with its own tests.

### Model

**Primary: `nemotron-3-super`** — 120B, 262K context, free tier, tool calling. Not `ultra`: a
model strong enough to succeed everywhere produces a ceiling effect where all three arms score
identically and the experiment says nothing, and `ultra` at 550B parameters burns far more GPU
time against an unpublished quota.

**Harness validation: `gpt-oss:20b`.** For exercising retries, resume and verifiers, where the
answers are irrelevant. The report must refuse to include these runs in any result.

**Optional: `nemotron-3-ultra`** on whichever tasks discriminated most, if budget survives.

### Tool space

Q3 needs the catalog to grow in controlled steps, so servers are grouped into bands enabled
cumulatively: ~10 tools (filesystem, time), ~25 (+ terminal, memory), ~50 (+ sqlite, git,
sequential-thinking), ~100 (+ websearch, fetch, and further servers as needed to reach the
count). The exact tool count at each band is recorded per run, not assumed.

Two constraints:

- **No task's required tool may be pinned.** A pinned tool is present in every arm by definition,
  so a task solvable with pinned tools measures nothing.
- **Deliberate near-duplicates.** Reading a file via `filesystem`, via `fetch`, or via `cat` in
  `terminal` are three routes to one outcome. Distractors are where retrieval precision becomes
  visible, and Q7 is meaningless without them.

### Tasks

Eight, each with a programmatic verifier, a fresh workspace fixture, and a `maxTurns` cap:

| # | Shape | Serves |
|---|---|---|
| 1 | Single tool, obvious | Q1, Q2 |
| 2 | Single tool, three plausible distractors | Q7, Tier 2 |
| 3 | Two tools, ordered: read then write | Q1 |
| 4 | Four steps across three servers | Q1, Q4 |
| 5 | Required tool matches no obvious keyword | Q7, Tier 2 |
| 6 | Eight-plus steps, one deliberate failure midway | **Q4**, Tier 3 `recovered` |
| 7 | Capability genuinely absent | Tier 3 `refusedCorrectly`, Mode 2 `discoveryMisses` |
| 8 | Ambiguous, needs one clarifying question | Tier 3 |

Task 6 carries Q4 and the README's long-running claim. Task 7 is where the arms differ most by
construction: Mode 1 sees the absence up front, Mode 2 must discover it through misses.

Q3 uses **task 3 only**, repeated across all four catalog bands, so the slope is not confounded
by task difficulty.

## Fairness controls

- **Interleave by task, not by arm.** Task 1 across all three arms, then task 2. Running all of
  Mode 1 first and Mode 2 an hour later lets service drift and quota throttling land unevenly on
  the arms and silently become the finding.
- **Identical decoding** across arms: same temperature (0 where honoured), same seed where
  supported, same `maxTurns`, same system prompt except the mode-specific injection. Every
  parameter recorded.
- **One agentic loop, three tool sources.** The loop must be shared code; only where the `tools`
  array comes from may differ. Three loops would measure the loops.
- **Fresh workspace per run**, built from the fixture, deleted after.
- **Fresh gateway per run, on its own port**, so the tool catalog, session injections and the
  advertised set never carry over. The harness must confirm `/health` reports **its own instance
  token** before sending a task — a stale gateway holding the port used to serve another
  session's requests entirely, which would run every arm against the wrong config while looking
  perfectly healthy.
- **Record the model's reported version** with every run and abort if it changes mid-run. A
  silent provider-side upgrade invalidates every comparison drawn across it.

## What the script must do

The fallback and integrity requirements, in full.

**Preflight, before spending anything.** Key resolves; `/v1/models` lists the chosen model; a
one-token probe confirms whether `usage` is present and whether cached tokens are reported; every
MCP server starts; the catalog reaches the expected count in each band; and **every verifier
passes against a hand-built correct workspace and fails against a deliberately wrong one.** A
verifier that cannot recognise success scores every arm zero and wastes the entire budget; one
that cannot recognise failure scores every arm perfect, which is worse.

**Serial only.** One concurrent request on the free tier. No parallelism anywhere.

**Per-request retry.** Timeouts, 429 and 5xx retry with exponential backoff — 2s, 4s, 8s, 16s —
capped at four attempts, honouring `Retry-After` when sent. `src/fetch-retry.ts` already
implements exactly this for the proxy; reuse it rather than writing a second version that drifts.

**A rate limit is not a timeout.** On a GPU-time-metered free tier, 429 can mean the month is
gone, and retrying cannot fix that. After **two consecutive 429s with no successful call between
them**, stop the entire run, flush results, and report which `(arm, task)` pairs never executed.

**Context loss: bin the transcript and restart the task.** Detected when the provider returns an
empty reply, when the transcript exceeds context and pruning begins, or when the model
contradicts an earlier tool result or repeats an identical tool call more than twice. On
detection the partial transcript is **discarded entirely** and that `(arm, task)` restarts from a
clean workspace with empty history — resuming a poisoned transcript produces a number that
measures the poison. Capped at **two restarts**; beyond that the pair is marked `abandoned` with
its reason and the run moves on instead of burning quota on something that will not converge.

**Resume across sessions.** Every completed `(arm, task, rep)` is appended to JSONL **immediately
on completion**, never buffered to the end. On startup the harness reads that file and skips
pairs already present unless `--force`. Losing a monthly quota halfway through must cost the
remaining work, not the finished work.

**Budget guard.** Configurable caps on cumulative tokens and wall-clock. On breach, stop at the
**next task boundary** — never mid-task, which would leave a partial run in the dataset — and
mark the report partial.

**Clean teardown always.** Gateway and workspace are torn down in a `finally`, so a failure
cannot leave a gateway holding a port for the next run. On SIGINT, finish the current write, tear
down, then exit.

**Integrity counters are results, not logs.** `attempts`, `restarts` and `abandoned` appear in
the summary next to the scores, every time the scores appear. A benchmark that hides how often it
retried is not a benchmark, and an arm that needed three restarts to produce its number produced
a different number than one that needed none.

**Tier gating.** After Tier A, print measured cost and the extrapolated cost of the next tier, and
**wait for approval** rather than spending it.

## Execution plan

Gated, because the quota cannot be predicted.

**Tier A — calibration.** Task 3 × 3 arms at the ~25-tool band. Reports measured tokens, wall
time and turns per arm, then extrapolates B and C and stops for approval.

**Tier B — core.** 8 tasks × 3 arms × 1 rep = **24 runs**, at the ~50-tool band. Answers Q1, Q2,
Q5, Q6, Q7 and all of Tier 2 and Tier 3. One repetition means no variance, so Tier B's output is
**directional** and must be labelled so.

**Tier C — scaling.** Task 3 × 3 arms × 4 catalog bands = **12 runs**. Answers Q3. Cheap relative
to its value, and worth prioritising over Tier D.

**Tier D — variance.** Two further reps of Tier B, **+48 runs**, for three per cell. Only with
headroom Tier A measured. Without D there is no claim about significance, only about direction,
and the report must state which it has.

Order of magnitude, to be replaced by Tier A's real numbers: Mode 1 and Mode 2 runs are plausibly
20–40k cumulative tokens each; Mode 3, carrying the whole catalog every turn, is plausibly 4–8×
that. Tier B lands near 1M tokens, dominated by Mode 3. That is a lot for a free tier, which is
precisely why Tier A exists and why Mode 3 may need a reduced repetition count of its own.

## Report

Written to `benchmark/results/<timestamp>/`:

- `raw.jsonl` — one line per run, appended live
- `turns.csv` — the extended token log, one row per turn, the substrate for Q2, Q4 and Q7
- `summary.md` — what ran, what did not, retries and restarts, **then** the comparison
- `config.json` — model and reported version, catalog snapshot per band, task-set hash, git SHA,
  price table with its date

## Threats to validity

Recorded here so the write-up cannot quietly omit them.

- **One model.** A result on `nemotron-3-super` is a result about that model. The published
  numbers used `mistral-large-latest`; where the two disagree, that is a finding, not an error.
- **Eight tasks is small.** Enough for direction, not for significance.
- **We wrote the tasks and we hold the hypothesis.** Task 5's unmatched keyword and task 2's
  distractors are choices that could favour retrieval-based arms. The task set and its hash ship
  with the results so a reader can disagree with the choices.
- **Free-tier variability** is unpublished and unmeasured. Interleaving limits it; nothing
  eliminates it.
- **Mode 2's harness is not a real MCP client.** Claude Desktop and Cursor bring their own system
  prompts and loops. This measures the mode, not those products.
- **Caching may be unmeasurable here**, and if so Mode 3's real-world cost could be materially
  lower than its token count implies. That has to be stated wherever Mode 3's numbers appear.
