# jmap-triage — Architecture

## Purpose

A personal Fastmail signal-to-noise pipeline. A Sieve catch-all rule routes
incoming mail into `Inbox/Triage`; this system classifies each message with
an LLM, moves it into the right destination mailbox, tags it, and pushes a
phone notification when warranted.

```
Incoming mail --> Sieve catch-all --> Inbox/Triage --> classify --> act --> tag --> notify
                                                            |
                                          +-----------------+-----------------+----------------+
                                          v                 v                 v                v
                                        Inbox         Inbox/Orders    Inbox/Suspicious    Inbox/News
                                                                                                 |
                                                                                          Archive/Noise
```

| Category | Destination |
|---|---|
| `inbox` | `Inbox` |
| `orders` | `Inbox/Orders` |
| `suspicious` | `Inbox/Suspicious` |
| `newsletters` | `Inbox/News` |
| `noise` | `Archive/Noise` |

`Inbox/Triage` is the source mailbox every classified email leaves, not a
sixth destination.

## Pipeline stages

1. **Fetch** (`fetch-emails.ts`) — pulls up to `limit` messages from
   `Inbox/Triage`, newest first, via JMAP `Email/query` + `Email/get`. Full
   body text (plain, or HTML converted to plain via `html-to-text`) and
   attachment file names (metadata only — content is never fetched), not
   just a preview snippet.
2. **Classify** (`classify.ts`) — one model call per email, returning
   `{category, notify}`. See "Classification" below.
3. **Act** (`actions.ts`) — `planActions` maps each classification to a
   destination mailbox + `$ai-<promptVersion>-<category>` keyword (pure
   function, no I/O); `applyMoves` performs the JMAP `Email/set` writes,
   batched, with per-email failure isolation. A move is a **patch** update
   on `mailboxIds` (`{"mailboxIds/<triageId>": null, "mailboxIds/<destId>": true}`),
   not a full replace, since `mailboxIds` is a set an email can belong to
   more than one member of. The keyword rides in the same patch object, so
   a move and its tag always succeed or fail together.
4. **Notify** (`notify.ts`) — after a confirmed move, fires a Pushover push
   (priority `0`) for any email the model marked `notify: true`, regardless
   of category. There is no category-level gate in code — restraint (e.g.
   never pushing for `suspicious`) lives entirely in the prompt.

Crash/re-run safety is by construction: a move is the only state change
that removes an email from `Inbox/Triage`, so a re-run simply re-fetches
whatever's still there. Already-moved emails aren't reprocessed.

**Dry run vs. `--apply`**: default is dry run — fetch, classify, and print
what *would* happen, write nothing. `--apply` performs the moves, tags, and
notifications. `--no-notify` (with `--apply`) performs moves and tagging
but skips Pushover.

## Classification

`classify.ts` exports a `ClassifierConfig` (`{apiKey, modelId}`) and one
`classifyEmail(config, email, promptText)` entrypoint, calling GreenPT
(`api.greenpt.ai`) — a plain OpenAI chat-completions API, reached with
`fetch`, no SDK. `config.ts`'s `requireModelConfig()` builds the config from
`GREENPT_API_KEY`/`GREENPT_MODEL_ID`.

The wire format is an array in and an array out — the prompt describes a JSON
array of emails — so a one-email call sends an array of one and matches the
reply on `id`. See `DECISIONS.md` for why GreenPT, why one email per call, and
what the rollback path is.

Retries use exponential backoff on 429, but a billing failure (402, or a
gateway signalling an empty balance as 429 `insufficient_quota`) is terminal
and surfaced immediately rather than burning the backoff ladder. The model is
asked to reply with only a JSON array, but in practice sometimes wraps it in a
code fence or appends trailing prose, so `extractJsonArray` scans for the first
balanced top-level `[...]` instead of assuming the whole response is bare JSON.
`notify` is fail-closed — missing or non-boolean coerces to `false` rather than
erroring the whole email out.

**Pacing** (`model-pacing.ts`) is a per-model table of inter-call delay plus a
fixed concurrency, measured empirically against the provider (GreenPT
publishes no rate limits and returns no `x-ratelimit-*` headers) rather than
taken from vendor docs. A burst cooldown (`MAX_BURST_CALLS`/
`BURST_COOLDOWN_MS`) caps how long a run can sustain full concurrency before
pausing, since probing only ever validated a few seconds at a time. The
measurements are in `DECISIONS.md`.

## Prompt: no bundled file, S3 is the source of truth

There is no `prompt.ts` in this repo. The classification prompt describes a
specific real person, so a git-committable copy would have to be either
generic-and-wrong or PII-bearing-and-uncommittable (`DECISIONS.md`). Instead:

- `current.json` (S3) holds `{version, prompt}` — the live pointer every
  classify call fetches (`current-prompt.ts`).
- `history/<version>.json` holds one immutable record per approved
  version: the full prompt text, `rationale`, `evidence`, `paragraphsEdited`,
  and the actual `evaluate_candidate` replay result that justified the
  approval (embedded, not just claimed).
- A failed S3 fetch is fatal everywhere (CLI, Lambda, eval) — there is no
  fail-open fallback to a stale local copy.

### jmap-triage-mcp: the review/governance server

A second Lambda (`McpServerFunction`, Streamable HTTP, fronted by the AWS
Lambda Web Adapter) exposes five tools for an interactive prompt-review
session:

| Tool | Does |
|---|---|
| `get_current_prompt` | Returns `current.json`. The live baseline every draft is built against — re-fetch every round, never assume an earlier round's version is still current. |
| `get_version_history` | Past approved-version records, most recent first. Check whether a similar change was already tried before drafting a new diff. |
| `get_triage_report` | Live JMAP scan for `$ai-*` keywords: per-category mismatch ratios + refs, comparing the stamped classification against wherever the email actually ended up. `notify` shown per-row, never folded into the ratios. |
| `evaluate_candidate` | A static gate (version bump, JSON-reply instruction intact, category vocabulary set-equal to the folder map — checked against the full vocabulary even when scoped to one category), then, only if it passes, a live replay against open corrections and a counterweight sample. No persisted regression corpus — both sets are derived fresh from JMAP keyword state and `get_version_history` on every call. Returns `{gate, fixes, corrections, regressions}`. |
| `approve_prompt_diff` | The one write path. Takes the candidate and the `evaluate_candidate` result that justified it (not re-derived), plus `rationale`/`evidence`/`paragraphsEdited`. Writes `current.json` and a new `history/<version>.json` record. Only called after a human has explicitly approved the candidate. |

**Why derived live, not a persisted corpus**: a message's `$ai-*` keyword
reflects whatever the prompt predicted *when that email arrived* — approving
a new version doesn't retroactively re-stamp old mail, so `get_triage_report`
lists a message as a mismatch forever, even after a later version starts
classifying its kind correctly. `evaluate_candidate` reconciles this by
reading every past version's `evaluation.fixes` (written by
`approve_prompt_diff`) and excluding already-resolved messages from "open
corrections." The counterweight sample folds in every past fix as a
regression guard, on top of a deterministic (sorted, not randomized) slice
of currently-correct mail per category — those guards are the highest-value
regression coverage, since each one is the specific case a past fix was
needed for.

**Review loop** (interactive — a human in the loop the whole time):
`get_version_history` → `get_triage_report` → fetch mismatched bodies →
cluster by hand → per cluster: `get_current_prompt` (re-fetch) → draft a
diff → `evaluate_candidate` → human review → `approve_prompt_diff`. One
cluster per round by default, since the gate's version-bump check means
parallel drafts against the same stale baseline can't both be valid.

**Concurrency in the replay**: tried and reverted. A bounded worker pool
measured no faster than sequential-with-fixed-delay against this account's
actual rate limit — bursting just meant more calls landing in the
retry-backoff path, with some exhausting their retries and failing
outright. The replay stays sequential, paced, same as production
classification.

## Deployment

AWS SAM (`template.yaml`), two Lambda functions in one stack:

- **`TriageFunction`** — the production pipeline, `nodejs24.x`, esbuild
  bundle, `src/lambda.handler`. Triggered by an EventBridge schedule
  (`ScheduleExpression`, default `rate(10 minutes)`), gated by
  `ScheduleEnabled` via a CloudFormation `Condition` (not the schedule
  event's own `Enabled` property — SAM's transform hardcodes that to
  `ENABLED` regardless of a `Ref`'d parameter). `event.dryRun: true`
  overrides the default `apply: true, notify: true` production path for
  safe validation (`aws lambda invoke --payload '{"dryRun": true}'`).
- **`McpServerFunction`** — the review server above. Runs as a plain Node
  HTTP server; the Lambda Web Adapter layer execs it and proxies the
  Function URL's streamed HTTP straight through, so `mcp-server.ts` has no
  Lambda-specific code. Built via `Metadata.BuildMethod: makefile` (root
  `Makefile` + `src/mcp-server-run.sh`), not SAM's built-in esbuild
  builder, since the Lambda Web Adapter's zip-package convention needs a
  `run.sh` startup script alongside the bundle.

**Secrets** (Fastmail token, Pushover token/user, GreenPT API key) live in SSM Parameter Store `SecureString`s,
created out of band (`aws ssm put-parameter`), never in a CloudFormation
parameter or the deploy command line. `TriageFunction` fetches them once
per cold start and caches across warm invocations, threaded through
explicitly rather than mutated into `process.env`. `McpServerFunction`
uses a different pattern for the same secrets — fetch-into-`process.env`,
cached the same way — since it's a long-lived server handling many
requests per container, and the modules it wraps (`config.ts`'s
`requireFastmailToken()`/`requireModelConfig()`) already read plain
`process.env` uniformly for every other caller (CLI, eval).

**Non-secret config** (`GREENPT_MODEL_ID`, the six mailbox id overrides,
`LIMIT`) is a plain
Lambda env var. Every mailbox the pipeline touches is described once in
`MAILBOX_SPECS` (`mailboxes.ts`) — `config.ts`'s override reading and
`actions.ts`'s category→destination mapping both derive from this table
rather than keeping their own hand-synced copy. No mailbox is
auto-created; resolution fails fast with an actionable message if one's
missing, before a single classify call is spent.

**No VPC, no reserved concurrency.** The pipeline is stateless between
runs — nothing to persist, nothing a cold start needs to rehydrate — so no
VPC is needed for either function, and Lambda's default networking already
has outbound internet for Fastmail's and GreenPT's APIs alike.
`ReservedConcurrentExecutions` isn't set: this account's Lambda concurrency
floor (10 unreserved, account-wide) rejects reserving even 1. In practice,
overlap between two scheduled invocations would require a run slow enough
to blow past the schedule period, and failure recovery is naturally
idempotent (a moved+tagged email is gone from `Inbox/Triage`, never
re-fetched) — worst case is a duplicate Pushover push, not corrupted state.

## Module structure

```
triage.ts                 -- CLI entrypoint: npx tsx triage.ts [--limit=n] [--apply] [--no-notify]
src/
  config.ts                -- .env loading, CLI flag parsing, env var validation,
                               requireModelConfig(), readMailboxOverrides
  jmap-session.ts           -- Session type, bootstrapSession, jmapRequest
  mailboxes.ts              -- MAILBOX_SPECS (single source of truth), resolveMailboxes
  fetch-emails.ts           -- fetchTriageEmails, extractBodyText, extractAttachmentNames
  classify.ts               -- ClassifierConfig, classifyEmail (GreenPT)
  model-pacing.ts           -- per-model concurrency + delay, runPaced()
  actions.ts                -- destinationsFor, planActions, applyMoves, keyword helpers
  notify.ts                 -- buildFastmailUrl, sendPushoverNotification
  main.ts                   -- runPipeline (reusable pipeline body) + main (CLI shell)
  lambda.ts                 -- TriageFunction handler: SSM secrets, event.dryRun
  current-prompt.ts         -- get_current_prompt: read current.json (S3)
  history.ts                -- get_version_history: read history/*.json (S3)
  report.ts                 -- get_triage_report: keyword-scan.ts + ratios
  evaluate.ts               -- evaluate_candidate: gate + live replay
  approve.ts                -- approve_prompt_diff: the one S3 write path
  keyword-scan.ts           -- shared JMAP $ai-* keyword scan (report.ts + evaluate.ts)
  s3-json.ts                -- shared S3 get/put-JSON helper
  mcp-server.ts             -- adapter exposing the 5 tools above over Streamable HTTP
  mcp-server-run.sh          -- Lambda Web Adapter startup script (McpServerFunction)
```

Split by pipeline stage, not by technical layer — each file is something a
prompt- or policy-only change would touch alone.

## Non-goals

- No mailbox auto-creation.
- No undo/rollback beyond another manual `Email/set`.
- No attachment content fetch (no `Blob/get`, no OCR) — file names only.
- No batching optimization for Pushover — one HTTP call per notification,
  sequential.
- No `category` value validation against the five known strings — a
  typo'd/hallucinated category is a known, accepted gap.
