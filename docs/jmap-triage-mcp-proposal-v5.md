# jmap-triage-mcp — closed-loop prompt learning (v5, no persisted corpus)

Status: implemented. Supersedes `jmap-triage-mcp-proposal-v4.md`, whose
persisted `s3://<bucket>/regression-corpus.json` this version removes
entirely (no such object was ever created — see `regression-corpus.ts`'s
deletion in this same change). Last updated 2026-08-20.

Supersedes v4. One correction, which removes infrastructure rather than
adding it: **there is no regression corpus store.** `evaluate_candidate`
derives its corrections and counterweight sets live, on every call, from
two things that already exist — JMAP keyword state and `get_version_history`
— rather than from a corpus someone has to remember to populate.

## How this replaced the "6th tool" idea

The previous plan was a `update_regression_corpus` tool, called at the end
of a session, that would write a `{corrections, counterweight}` object to
S3. Tracing through *when* it should run exposed why it isn't needed:

- **Corrections don't need to be persisted.** They're `get_triage_report`'s
  mismatches — already derived live from JMAP on every call.
- **A generic "correctly classified" counterweight sample doesn't need to
  be persisted either.** Same JMAP scan, checking matches instead of
  mismatches. Also derivable live.
- **The one thing that genuinely can't be derived from a live JMAP scan:
  which corrections have already been fixed.** A message's `$ai-*` keyword
  reflects whatever the prompt predicted *when that email arrived* —
  approving a new prompt version doesn't retroactively re-stamp old mail.
  So `get_triage_report` will keep listing a message as a mismatch forever,
  even after a later version starts classifying its kind correctly. That's
  expected and correct as a historical audit trail (§7's original spec was
  "compare the stamped category... against where the email is actually
  sitting now" — a permanent record, not a live status). But it means
  `evaluate_candidate` needs a way to know "this one's resolved" that live
  JMAP scanning alone can't give it.

That information already exists: `approve_prompt_diff` writes the
`evaluate_candidate` result that justified each approval into
`history/<version>.json`'s `evaluation.fixes` field — added specifically so
a record can't claim an outcome that didn't happen. `evaluate_candidate`
just needs to *read* that field before building its sets, not have a new
one written to it.

## What `evaluate_candidate` actually does now

1. Call `keyword-scan.ts`'s live JMAP scan for **both** mismatches (the
   open corrections) and matches (candidates for the counterweight sample).
2. Call `history.ts` for every past version record's `replay.fixes`
   arrays. Build a map of `messageId → expected category`, most recent
   record wins if a message appears more than once.
3. **Open corrections** = live mismatches, minus any `messageId` already
   present in that fixes map (already resolved by a prior approval, even
   though its keyword still shows the old mismatch).
4. **Counterweight** = a deterministic sample of live matches (sorted,
   first ~20 per category — *not* randomized, so re-evaluating the same
   candidate mid-round doesn't compare against a different sample each
   time), plus every `{messageId, expected}` pulled from history's fixes
   map folded in directly. Those are the highest-value regression guards —
   each one is the specific case a past fix was needed for.
5. Fetch bodies for open corrections + counterweight at eval time (bodies
   were never stored — same just-in-time pattern as everywhere else in
   this project).
6. Classify each with `candidate.prompt` via a parameterized
   `classifyBatch`. An open correction whose new category matches its
   actual folder → `fixes`. A counterweight message whose new category no
   longer matches its expected label → `regressions`.

No corpus object exists anywhere in S3. Nothing needs populating before the
loop can run; nothing goes stale.

**Implementation note on "actual folder":** `KeywordMismatch` carries
`actualFolder` as a path string (or a comma-joined list, or the sentinel
`"(none — deleted?)"`), not a category name. `evaluate.ts`'s
`actualCategoryFromMismatch()` maps it back to a category by checking which
`MAILBOX_SPECS` path it matches — deliberately kept local to `evaluate.ts`
rather than added as a field on `KeywordMismatch` itself, since
`keyword-scan.ts`'s job is the match/mismatch determination, not category
bookkeeping for a caller that doesn't need it for anything else. A folder
that doesn't resolve to any of the five category folders (deleted mail, or
trashed via a path other than the `suspicious`→Trash exception
`keyword-scan.ts` already treats as a match) returns `null`, and a `null`
ground truth can never register as "fixed" — the conservative default when
there's nothing to verify a fix against.

## The 5 tools (unchanged from v4)

| Tool | Does |
|---|---|
| `get_current_prompt` | Returns `current.json` → `{version, prompt}`. |
| `get_version_history` | Returns past version records, most recent first — now also the source `evaluate_candidate` reads to find already-resolved corrections. |
| `get_triage_report` | Live JMAP keyword scan: mismatch ratios + refs. `notify` shown per-row, never folded into ratios. |
| `evaluate_candidate` | Static gate, then — only if it passes — replay against a corpus derived live from `get_triage_report` + `get_version_history`, per the algorithm above. Returns `{gate, fixes, regressions}`. |
| `approve_prompt_diff` | Takes the `evaluate_candidate` result as input (not re-derived), plus `rationale`/`evidence`/`paragraphsEdited`. Writes `current.json` and a new immutable `history/<version>.json` record — this is what future `evaluate_candidate` calls read back. |

## Code architecture

```
src/
  keyword-scan.ts     -- shared JMAP keyword-state scan. Returns both
                          matches and mismatches per category. report.ts
                          and evaluate.ts both call this -- neither
                          duplicates the JMAP query logic.
  current-prompt.ts    -- get_current_prompt
  history.ts             -- get_version_history
  report.ts               -- get_triage_report: calls keyword-scan.ts,
                          returns ratios + mismatch refs, plus its own
                          separate notify-keyword scan
  evaluate.ts               -- evaluate_candidate: calls keyword-scan.ts
                          (both matches and mismatches) + history.ts,
                          builds corrections/counterweight live, replays
  approve.ts                 -- approve_prompt_diff (the one write path)
  mcp-server.ts                 -- adapter exposing the five as MCP tools
```

`keyword-scan.ts` is the one addition — factoring out logic `report.ts`
already needed and `evaluate.ts` now needs too, rather than each
reimplementing the same JMAP query. `regression-corpus.ts` (v4) is deleted,
not deprecated — nothing reads or writes a corpus object anymore.

## `evaluate_candidate`'s optional `category` param

Added after deploying, once the counterweight-cap shrink (above) revealed
the real tension: a full 5-category sweep needs a small per-category cap to
stay under Claude Desktop's 240s tool-call timeout, but a diff usually only
touches one category's wording — the "one cluster per round" default this
loop already assumes. Paying the sweep's shrunk cap on every round, even
rounds that only ever touch one category, was leaving real coverage on the
table for no reason.

`evaluateCandidate(candidate, category?)` — omit `category` for the
original full-sweep behavior (`COUNTERWEIGHT_PER_CATEGORY = 6`); pass one
of the five category names to scope the replay to just that category, at
`COUNTERWEIGHT_SINGLE_CATEGORY = 20` (back near the original, pre-shrink
number) since a single category was never what pushed calls over budget —
the sweep's `20 × 5` was. Two things stay unscoped even when `category` is
passed:

- **The gate's category-vocabulary check** — a candidate always has to
  support the full folder map regardless of which category this
  particular call is replay-testing.
- **"Already resolved" filtering against the fixes map** — a mismatch's
  resolution status doesn't depend on which category the current call
  happens to be scoped to.

What *is* scoped: which past fixes get folded into the counterweight as
guards. An unscoped call still folds in every past fix (full coverage); a
`category`-scoped call only folds in that category's own past fixes, so a
`"suspicious"`-scoped call doesn't drag a `"noise"` guard message along —
which would silently re-inflate the call volume the scoping exists to cut.

Coverage for a diff that genuinely spans categories (the doc's own
tie-breaker example — "prefer the one that keeps the email more visible,
inbox > orders > newsletters > noise" — touches several at once) is the
calling session's responsibility: call once per affected category, or omit
`category` for a full sweep. There's no attempt to infer "which categories
does this diff actually touch" from the prompt text — that's exactly the
kind of judgment call this project leaves to the human reviewer already in
the loop, not something a heuristic should guess at.

## Concurrency: tried, measured, removed

The replay loop briefly used a bounded (4-way) concurrent worker pool for
the Bedrock classification calls, on the theory that it would speed things
up without the throttling risk of full parallelism. Measured live against
this account's actual Bedrock rate limit, it didn't hold: a matched pair of
runs against the same category (`noise`, the largest, at the full
`COUNTERWEIGHT_SINGLE_CATEGORY = 20` sample both times) came back at 83.2s
with 2 failed rows (concurrency=4) versus 83.9s with 0 failed rows
(sequential, paced at `DELAY_BETWEEN_CALLS_MS = 300`) — statistically the
same wall-clock time. Per-call timestamps confirmed the worker pool really
was firing calls in genuine parallel; the account's rate limit just doesn't
care how the same total request volume is scheduled, and bursting 4 at once
only means more of them land in `invokeBedrock`'s exponential backoff, with
two calls in the concurrent run exhausting all 5 retries and failing
outright — lost signal, not just lost time. Reverted to the same
sequential-with-fixed-delay pattern `main.ts` already uses for production
classification (`DELAY_BETWEEN_BATCHES_MS`), which has been running against
the real mailbox every 10 minutes without failing. See `evaluate.ts`'s own
comments for the full numbers.

## Still open

- Whether `get_triage_report`'s JMAP scan needs a `since` bound — shipped
  without one; `keyword-scan.ts` has no date-bound support at all right
  now, and `TriageReportParams.since` is currently a no-op kept only for
  the tool schema's forward compatibility.
- Whether the automated path's clustering needs a stronger Bedrock model
  than Haiku — likely yes; pilot before trusting it.
- How many rounds is too many for one sitting.
- ~~Counterweight sample size (~20/category)~~ — resolved by real data, not
  left open: 20/category (~70-100 total messages, sequential Bedrock calls)
  took 371s in a live run against this account's mailbox. That's not just
  slow — Claude Desktop enforces a hard, non-configurable 4-minute (240s)
  timeout on remote MCP tool calls, so it would have looked like a hung
  tool call regardless of what the server eventually returned. Fixed with
  two levers, in `evaluate.ts`: bounded concurrency
  (`REPLAY_CONCURRENCY = 4`) and a lower cap
  (`COUNTERWEIGHT_PER_CATEGORY = 6`, down from 20 by way of 10). Landed at
  122s with real margin under 240s, occasionally still hitting a Bedrock
  throttling error on a straggler call or two (surfaced as a flagged,
  unverifiable regression row — see `replay()`'s error handling — never
  silently dropped). Higher concurrency was tried and made things *worse*,
  not better, consistent with `classify.ts`'s own comment about Bedrock
  throttling under load: 4-way concurrency at the 10/category cap still
  produced throttling failures at 187s, so the fix was shrinking total call
  volume, not adding more parallelism. This means the deterministic sample
  is now fairly thin per category (6) — the fixes-map entries folded in on
  top of it (uncapped, see step 4) are carrying more of the real regression
  coverage than the sample is, which is fine early on but worth watching as
  approvals accumulate.
