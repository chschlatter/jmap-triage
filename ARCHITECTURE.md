# jmap-triage — Architecture

How the system is built. Operating it: [README.md](README.md). Why these
numbers, providers and rejected alternatives: [DECISIONS.md](DECISIONS.md).

## Purpose

A personal Fastmail signal-to-noise pipeline. A Sieve catch-all rule routes
incoming mail into `Inbox/Triage`; this system classifies each message with an
LLM, moves it into the right destination mailbox, tags it, and pushes a phone
notification when warranted.

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

`Inbox/Triage` is the source every classified email leaves, not a sixth
destination.

## Pipeline stages

1. **Fetch** (`fetch-emails.ts`) — up to `limit` messages from `Inbox/Triage`,
   newest first, via `Email/query` + `Email/get`. Full body text (plain, or
   HTML converted via `html-to-text`) and attachment file names (metadata only
   — content is never fetched), not just a preview snippet.
2. **Round 1 — phishing filter** (`phish.ts`) — one model call per email,
   returning `{verdict}`, over a computed evidence block (`evidence.ts`:
   merged Fastmail authentication results, Hide My Email relay decoding,
   links, hidden text). A `phishing` verdict goes straight to
   `Inbox/Suspicious` and leaves the pipeline; only `clean` mail reaches
   round 2. Two properties are structural rather than prompt-enforced:
   suspicious mail can never reach the notify decision, and a round-1 failure
   leaves the email in `Inbox/Triage` unclassified, for the next run.
3. **Round 2 — classify** (`classify.ts`) — one model call per clean email,
   returning `{category, notify}`. See "Classification" below.
4. **Act** (`actions.ts`) — `planActions` maps each classification to a
   destination + `$ai-<promptVersion>-<category>` keyword (pure, no I/O),
   once per round so each stamps its own version; mail round 2 files also
   carries round 1's `$ai-<phVersion>-clean`, which is what makes a round-1
   false negative detectable later;
   `applyMoves` performs the `Email/set` writes, batched, with per-email
   failure isolation. A move is a **patch** on `mailboxIds`
   (`{"mailboxIds/<triageId>": null, "mailboxIds/<destId>": true}`), not a
   replace, since an email can belong to several mailboxes. The keyword rides
   in the same patch, so a move and its tag succeed or fail together.
5. **Notify** (`notify.ts`) — after a confirmed move, a Pushover push
   (priority `0`) for any email the model marked `notify: true`, regardless of
   category. There is no category gate in code, and none is needed for
   suspicious mail any more: a phishing verdict never reaches round 2, so it
   never produces a notify decision at all.

Crash/re-run safety is by construction: a move is the only state change that
removes an email from `Inbox/Triage`, so a re-run just re-fetches whatever is
still there.

**Dry run vs. `--apply`**: the default fetches, classifies and prints what
*would* happen. `--apply` performs moves, tags and notifications;
`--no-notify` keeps moves and tags but skips Pushover.

## Classification

`classify.ts` exports a `ClassifierConfig` (`{apiKey, modelId}`) and
`classifyEmail(config, email, promptText)`, calling GreenPT
(`api.greenpt.ai`) — a plain OpenAI chat-completions API, reached with
`fetch`, no SDK. The wire format is an array in and an array out (the prompt
describes a JSON array of emails), so a one-email call sends an array of one
and matches the reply on `id`.

Retries use exponential backoff on 429, but a billing failure (402, or a
gateway signalling an empty balance as 429 `insufficient_quota`) is terminal.
The model is asked for a bare JSON array but sometimes wraps it in a code
fence or appends prose, so `extractJsonArray` scans for the first balanced
top-level `[...]`. `notify` is fail-closed: missing or non-boolean coerces to
`false` rather than erroring the email out.

**Pacing** (`model-pacing.ts`) is a per-model inter-call delay plus a fixed
concurrency, measured against the provider rather than taken from vendor docs.
A burst cooldown (`MAX_BURST_CALLS` / `BURST_COOLDOWN_MS`) caps how long a run
can sustain full concurrency, since probing only ever validated short bursts.

## Prompt: no bundled file, S3 is the source of truth

There is no `prompt.ts`. The prompt describes a specific real person, so a
git-committable copy would be either generic-and-wrong or
PII-bearing-and-uncommittable. Instead:

- `current.json` (S3) holds `{version, prompt}` — the live pointer every
  classify call fetches (`current-prompt.ts`).
- `history/<version>.json` holds one immutable record per approved version:
  full prompt text, `rationale`, `evidence`, `paragraphsEdited`, and the
  actual `evaluate_candidate` result that justified the approval (embedded,
  not just claimed). `history/index.json` lists versions in append order.
- A failed S3 fetch is fatal everywhere (CLI, Lambda, eval) — no fail-open
  fallback to a stale local copy.

### jmap-triage-mcp: the review/governance server

A second Lambda (`McpServerFunction`, Streamable HTTP, fronted by the AWS
Lambda Web Adapter) exposes five tools for an interactive prompt-review
session:

| Tool | Does |
|---|---|
| `get_current_prompt` | Returns `current.json` — the live baseline every draft is built against. Re-fetch every round. |
| `get_version_history` | Past approved-version records, most recent first. Check whether a change was already tried before drafting a new one. |
| `get_triage_report` | Live JMAP scan for `$ai-*` keywords: per-category mismatch ratios + refs, comparing the stamped classification against where the email actually ended up. `notify` shown per row, never folded into the ratios. |
| `evaluate_candidate` | A static gate (version bump, JSON-reply instruction intact, category vocabulary set-equal to the folder map — always checked against the full vocabulary), then, only if it passes, a live replay against open corrections and a counterweight sample. Optional `category` scopes the replay to one category for latency. Returns `{gate, fixes, corrections, regressions}`. |
| `approve_prompt_diff` | The one write path. Takes the candidate and the `evaluate_candidate` result that justified it (not re-derived), plus `rationale`/`evidence`/`paragraphsEdited`. Writes `current.json`, then `history/<version>.json`, then the index. Called only after explicit human approval. |

**Why the replay corpus is derived live, not persisted**: a message's `$ai-*`
keyword reflects what the prompt predicted *when that email arrived* —
approving a new version doesn't re-stamp old mail, so `get_triage_report`
lists a message as a mismatch forever, even after a later version classifies
its kind correctly. `evaluate_candidate` reconciles this by reading every past
version's `replay.fixes` and excluding already-resolved messages from "open
corrections". The counterweight folds in every past fix as a regression guard
— each one is the specific case a past fix was needed for — on top of a
deterministic (sorted, not randomized) slice of currently-correct mail per
category.

**Review loop** (a human in the loop throughout): `get_version_history` →
`get_triage_report` → fetch mismatched bodies → cluster by hand → per cluster:
`get_current_prompt` (re-fetch) → draft a diff → `evaluate_candidate` → human
review → `approve_prompt_diff`. One cluster per round, since the gate's
version-bump check means parallel drafts against the same baseline can't both
be valid.

**Concurrency in the replay**: tried and reverted. A bounded worker pool
measured no faster than sequential-with-fixed-delay against this account's
rate limit — bursting just put more calls in the retry-backoff path. The
replay stays sequential and paced, same as production.

## Deployment

AWS SAM (`template.yaml`), two Lambda functions in one stack. Deploy steps are
in [README.md](README.md).

- **`TriageFunction`** — the pipeline, `nodejs24.x`, esbuild bundle,
  `src/lambda.handler`. Triggered by an EventBridge schedule
  (`ScheduleExpression`, default `rate(10 minutes)`), gated by
  `ScheduleEnabled` via a CloudFormation `Condition` — not the schedule
  event's own `Enabled` property, which SAM's transform hardcodes to `ENABLED`
  regardless of a `Ref`'d parameter. `event.dryRun: true` overrides the
  default `apply: true, notify: true`.
- **`McpServerFunction`** — the review server above, a plain Node HTTP server.
  The Lambda Web Adapter layer execs it and proxies the Function URL's
  streamed HTTP through, so `mcp-server.ts` has no Lambda-specific code. Built
  via `Metadata.BuildMethod: makefile` (root `Makefile` + `mcp-server-run.sh`)
  rather than SAM's esbuild builder, since the adapter's zip-package
  convention needs a `run.sh` alongside the bundle.

**Secrets** (Fastmail token, Pushover token/user, GreenPT API key) live in SSM
`SecureString`s, created out of band, never in a CloudFormation parameter or
on the deploy command line. `TriageFunction` fetches them once per cold start
and threads them through explicitly. `McpServerFunction` fetches the same way
but into `process.env`, since it is a long-lived server and the modules it
wraps (`config.ts`'s `require*`) already read `process.env` uniformly for
every other caller.

**Non-secret config** (`GREENPT_MODEL_ID`, the six mailbox id overrides,
`LIMIT`) is a plain Lambda env var. Every mailbox is described once in
`MAILBOX_SPECS` (`mailboxes.ts`) — `config.ts`'s override reading and
`actions.ts`'s category→destination map both derive from it. No mailbox is
auto-created; resolution fails fast with an actionable message before a single
classify call is spent.

**No VPC, no reserved concurrency.** The pipeline is stateless between runs,
and Lambda's default networking already reaches Fastmail and GreenPT.
`ReservedConcurrentExecutions` isn't set: this account's concurrency floor (10
unreserved, account-wide) rejects reserving even 1. Overlap would need a run
slower than the schedule period, and recovery is naturally idempotent — worst
case a duplicate Pushover push, not corrupted state.

## Module structure

```
triage.ts                -- CLI entrypoint: npx tsx triage.ts [--limit=n] [--apply] [--no-notify]
src/
  config.ts              -- .env loading, CLI flags, env validation, mailbox overrides
  jmap-session.ts        -- Session type, bootstrapSession, jmapRequest
  mailboxes.ts           -- MAILBOX_SPECS (single source of truth), resolveMailboxes
  fetch-emails.ts        -- fetchTriageEmails, fetchEmailsByIds, body/attachment extraction
  stages.ts              -- STAGE_SPECS: the two rounds, their S3 prefixes and version lines
  evidence.ts            -- buildEvidence: auth/relay/link facts from headers, pure
  phish.ts               -- judgePhishing (round 1)
  classify.ts            -- ClassifierConfig, classifyEmail (GreenPT)
  model-pacing.ts        -- per-model concurrency + delay, runPaced()
  actions.ts             -- destinationsFor, planActions, applyMoves
  notify.ts              -- sendPushoverNotification
  main.ts                -- runPipeline (reusable body) + main (CLI shell)
  lambda.ts              -- TriageFunction handler: SSM secrets, event.dryRun
  current-prompt.ts      -- get_current_prompt: read current.json (S3)
  history.ts             -- get_version_history: read history/*.json (S3)
  report.ts              -- get_triage_report: keyword-scan.ts + ratios
  evaluate.ts            -- evaluate_candidate: gate + live replay
  approve.ts             -- approve_prompt_diff: the one S3 write path
  keyword-scan.ts        -- shared JMAP $ai-* keyword scan (report.ts + evaluate.ts)
  s3-json.ts             -- shared S3 get/put-JSON helper
  mcp-server.ts          -- adapter exposing the 5 tools over Streamable HTTP
  mcp-server-run.sh      -- Lambda Web Adapter startup script
eval/                    -- synthetic golden-set regression check (not deployed, not CI)
reports/                 -- one-off audit script, largely superseded by get_triage_report
```

Split by pipeline stage, not technical layer — each file is something a
prompt- or policy-only change would touch alone.

## Non-goals

- No mailbox auto-creation.
- No undo/rollback beyond another manual `Email/set` (S3 bucket versioning is
  the undo path for a bad `approve_prompt_diff`).
- No attachment content fetch (no `Blob/get`, no OCR) — file names only.
- No Pushover batching — one HTTP call per notification, sequential.
- No validation of `category` against the five known strings — a
  typo'd/hallucinated category is a known, accepted gap (it is skipped and
  left in `Inbox/Triage`).
