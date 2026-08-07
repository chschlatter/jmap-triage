# triage.ts — Design Document (v4)

Status: v4 (implemented). Last updated 2026-08-02.

Consolidates `triage.ts-DESIGN-v1.1-2026-08-01.md` (original design),
`triage.ts-DESIGN-v1.2-2026-08-02.md` (full-body + attachment-name input),
and `triage.ts-DESIGN-v1.3-2026-08-02.md` (5-category prompt, dropped
SUBTYPE) into one current-state document. Those three docs are kept
alongside this one for history — this doc doesn't repeat their delta
rationale in full, only the parts still relevant to understanding the
system as it stands today.

## 1. Purpose

`triage.ts` is the classification component of the `jmap-triage` system: a
larger Fastmail signal-to-noise pipeline built around Sieve, JMAP, and an
LLM. It polls a `/Triage` mailbox, classifies each message with Claude Haiku
on AWS Bedrock, and prints the result. It is read-only by design — see
[§4 Non-goals](#4-non-goals).

### System context

```
┌──────────────┐     ┌────────────┐     ┌───────────────┐     ┌──────────┐
│ Incoming mail│ --> │ Sieve       │ --> │  /Triage       │ --> │ triage.ts│
│              │     │ catch-all   │     │  mailbox       │     │  (this)  │
└──────────────┘     └────────────┘     └───────────────┘     └────┬─────┘
                                                                     │ prints
                                                                     │ classification
                                                                     ▼
                                                          (v2, not built yet)
                                                          act on classification:
                                                          move mail, tag, notify
```

- **Sieve catch-all rule** (already configured, outside this component's
  scope) routes incoming mail into `/Triage`.
- **This component** reads `/Triage`, classifies each message, and prints a
  table. It makes no changes to the mailbox.
- **v2** (separate, not implemented) will act on the classification: move
  `attention`/`keep` mail out of `/Triage`, file `newsletters`/`noise` mail
  into folders, and fire a Pushover notification for `attention` /
  `suspicious`.

Splitting classification from action lets classification quality be
validated against real mail before anything touches the account's folder
structure or sends a notification.

## 2. Requirements

- Poll `/Triage` for a bounded, configurable number of messages.
- Classify each message into exactly one of 5 categories: `attention`,
  `keep`, `suspicious`, `newsletters`, `noise`. No secondary field — v1.1's
  free-text subtype was dropped in v4 (§3.6).
- Classify on full body text (plain, or HTML converted to plain) and
  attachment file names, not just the ~250-char `preview` snippet — added in
  v1.2, unchanged since (§3.4-§3.5).
- Use Claude Haiku on AWS Bedrock, region `eu-central-1`.
- Make **no writes of any kind** to the mailbox.
- Tolerate malformed model output without crashing the run.
- Be operable from a human's terminal today, and from an AWS Lambda cron
  invocation later, without a rewrite.

## 3. Architecture

### 3.1 Data flow

```
main()
  │
  ├─ load .env (FASTMAIL_TOKEN, BEDROCK_MODEL_ID, TRIAGE_MAILBOX_ID?)
  │
  ├─ bootstrapSession(token)              -- GET /jmap/session
  │     └─ apiUrl, accountId
  │
  ├─ getTriageMailboxId(session)          -- Mailbox/query {name: "Triage"}
  │     (skipped if TRIAGE_MAILBOX_ID is set)
  │
  ├─ fetchTriageEmails(session, mailboxId, limit)
  │     └─ Email/query {inMailbox, sort: receivedAt desc, limit}
  │        + Email/get {"#ids": <back-reference>,
  │            properties: [subject, from, to, receivedAt, textBody,
  │                         htmlBody, attachments],
  │            bodyProperties: [partId, type, name, disposition],
  │            fetchTextBodyValues: true, fetchHTMLBodyValues: true,
  │            maxBodyValueBytes: 4000}
  │        └─ extractBodyText(m)     -- prefers text/plain, falls back to
  │        │                            html-to-text on text/html
  │        └─ extractAttachmentNames(m) -- drops inline/CID, caps at 10
  │
  ├─ chunk(emails, BATCH_SIZE)            -- BATCH_SIZE = 1
  │
  └─ for each batch:
        classifyBatch(bedrock, modelId, batch)
          ├─ build one JSON array of
          │    {id, subject, from, to, receivedAt, body, attachments}
          ├─ invokeBedrock(...)           -- InvokeModel, retry w/ backoff on throttling
          ├─ extractJsonArray(responseText)   -- defensive: strips code fences / trailing prose
          ├─ JSON.parse + validate shape
          └─ map results back to emails by id
              (a whole-batch failure marks every email in it as a failure;
               an id missing from a successful response is an individual failure)
        │
        └─ accumulate into rows[] / failures[]

print rows (emailId / subject / from / category) as a table;
print failures as a second table if non-empty
```

### 3.2 Components (all in `triage.ts` unless noted)

| Component | Responsibility |
|---|---|
| `loadEnvFile` | Minimal `.env` parser (no dependency on `dotenv`); never overrides an already-set env var. |
| `bootstrapSession` | JMAP session discovery (`GET /jmap/session`) — resolves `apiUrl` and `accountId` rather than hardcoding endpoints, per JMAP's own design (servers may relocate the API URL). |
| `getTriageMailboxId` | Resolves `/Triage`'s mailbox id by name via `Mailbox/query`. Skippable via `TRIAGE_MAILBOX_ID`. |
| `fetchTriageEmails` | Fetches `subject`/`from`/`to`/`receivedAt` plus body text and attachment names for up to `limit` messages, newest first. No `Blob/get` — attachment *content* is never fetched. |
| `extractBodyText` | Prefers a genuine `text/plain` part; falls back to converting `text/html` to plain text via `html-to-text`. Appends `"...[truncated]"` when the server-side `maxBodyValueBytes` cap truncated the value, so the model doesn't mistake a hard cutoff for the email ending there. |
| `extractAttachmentNames` | Drops inline/CID assets (signature logos, tracking pixels) and caps the list at 10 names — defends the token budget against a pathological attachments list. |
| `chunk` | Pure helper: splits the email list into `BATCH_SIZE`-sized groups. |
| `invokeBedrock` | Wraps a single `InvokeModelCommand` call with retry-with-exponential-backoff on throttling. |
| `classifyBatch` | Builds the Bedrock request for one batch, parses the response defensively, and returns a per-email outcome (success or per-email error) — never throws. |
| `extractJsonArray` | Scans for the first balanced top-level `[...]`, tolerating the model wrapping its JSON in a ` ```json ` fence or appending trailing prose despite being told not to. |
| `main` | Orchestrates the above, prints the results. |
| `prompt.ts` (separate file) | Holds the `PROMPT` system-prompt template literal — see [§3.6](#36-prompt-as-a-separate-module). |

### 3.3 Why JMAP method calls are shaped this way

- **Session bootstrap resolves `apiUrl` and `accountId` at runtime** rather
  than hardcoding `/jmap/api/` — JMAP servers are free to relocate the API
  endpoint, and multi-account setups need `accountId` resolved per-session
  anyway.
- **`Mailbox/query` + `Email/query` are two separate JMAP requests**, not
  chained via a JMAP result reference, because JMAP result references
  (`"#argName"`) can only substitute a *whole top-level argument* of a
  method call (RFC 8620 §3.7) — they cannot populate a value nested inside
  `Email/query`'s `filter` object (`filter.inMailbox`). See
  `TRIAGE_MAILBOX_ID` (§7) for the actual mitigation.
- **`Email/query` + `Email/get` in the same request ARE chained** via a
  result reference (`"#ids"`), because `ids` is a genuine top-level argument
  of `Email/get`.
- **`textBody`/`htmlBody` + `fetchTextBodyValues`/`fetchHTMLBodyValues`**,
  capped by `maxBodyValueBytes: 4000` — the server-side cap matters over a
  client-side slice: JMAP guarantees truncation lands on a valid UTF-8
  boundary, and the untruncated bytes never cross the wire.
- **`attachments` returns metadata only** (`name`, `type`, `disposition`,
  `partId`) — no `Blob/get` call is added, so attachment *content* is never
  fetched. Still zero writes; still only `Email/get`.

### 3.4 Plain-text extraction

Two known failure shapes motivated moving off `preview`-only classification
(the v1.1 behavior): payment status often sits below a ~250-char snippet's
fold, and attachment names (`Mahnung_2026-07.pdf`, `Bordkarte.pdf`) are a
strong signal that preview-only classification never saw at all.

`extractBodyText` prefers `textBody`; many transactional/marketing mail
(billing systems, newsletters) is HTML-only, so falling back to converting
`htmlBody` to plain text is required, not optional. The `html-to-text`
package (v10) does that conversion — added as a dependency rather than
hand-rolled, since a hand-rolled tag-stripper has known failure modes
(`<script>`/`<style>` leaking through, entity decoding) that cost more in
wrong classifications than one `npm install` costs in dependency surface.
`html-to-text` ships no type declarations for v10 and `@types/html-to-text`
is pinned to the older v9 API, so a minimal ambient declaration
(`html-to-text.d.ts`) is used instead of a mismatched `@types` package.

No pre-classification condensing step (a deterministic boilerplate-strip, or
an LLM summarization pass) was added — considered and rejected. The
HTML→text conversion already removes the bulk of the token bloat for the
HTML-heavy mail that dominates the noisy end of the volume; a summarization
pass would need to read the full body to summarize it, so it wouldn't save
the input tokens it would need to save to justify its own added latency and
cost.

### 3.5 Attachment name handling

`extractAttachmentNames` filters before sending names to the model:

- **Drops inline/CID assets** (`disposition === "inline"`, or lacking a
  `name`) — almost always embedded signature logos or tracking-pixel-adjacent
  images, not attachments a human would recognize as such.
- **Caps the count at 10** — defends against a pathological case (a
  newsletter with dozens of inline images all marked as attachments) blowing
  up one email's share of the token budget.
- Sends `name` only, not `type`/`size` — the file name carries the
  classification signal; MIME type and byte size don't and just cost tokens.

As of v4, the prompt (§3.6) doesn't call out attachment names with their own
dedicated tie-breaker text the way v3's prompt did (`Mahnung*.pdf` →
`attention`, `Bordkarte*.pdf` → `keep`) — `attachments` is still sent as
ambient context the model can use, but nothing in the current prompt singles
it out. Worth watching in future real-mail validation, since attachment-name
signal is easy for a model to underweight without being told to look for it
specifically; if that turns out to matter, add it back as an explicit
tie-breaker rather than assuming the ambient signal is enough.

### 3.6 Prompt as a separate module

The classification prompt (`PROMPT` in `prompt.ts`) is kept out of
`triage.ts` entirely, on the premise that prompt iteration and code
iteration have different rhythms and different risk profiles — a prompt
edit should be independently re-validated against real mail without
touching (or re-reviewing) the polling/Bedrock-calling logic, and vice
versa.

`prompt.backup.ts` holds the prior prompt version whenever a substantive
rewrite happens — currently v3 (the last full-body+attachments prompt before
the v4 category simplification). Only the immediately-prior version is kept,
not a full history (this project has no git repository — just a manual
snapshot for reference/rollback). `prompt.ts`'s own header comment carries
the version history (currently back to v2) as a running log.

### 3.7 Classification schema

One dimension, produced in a single model call per email (`BATCH_SIZE = 1`,
§5):

- **`category`**: `attention` | `keep` | `suspicious` | `newsletters` |
  `noise`.

v1.1 through v3 additionally produced a `subtype` (`receipt` | `ad` |
`newsletter` | `social` | `other`) whenever `category === "archive"`, used
only to choose an archive folder for a future v2 action layer — "no decision
logic hangs off it," per the original design. v4 dropped both the `archive`
category and `subtype` entirely: the content types `subtype` distinguished
now map onto two first-class categories instead (`newsletters` absorbs
`subtype: newsletter`; `noise` absorbs `receipt`/`ad`/`social`/`other`, now
merged into one bucket since nothing separates them anymore). This is a
real behavior change, not just a rename: under the old scheme, "which
archive subfolder" was a second, lower-stakes decision layered on a
higher-stakes "is this actionable" decision ("being wrong here costs
nothing," the original SUBTYPE guidance said). Under v4, `newsletters` vs.
`noise` is the same kind of required, single-shot pick as `attention` vs.
`keep` vs. `suspicious`. The prompt compensates for this by giving both
categories their own first-class definitions and by placing both in an
explicit visibility-ordering tie-breaker (`attention > keep > newsletters >
noise` — prefer the more-visible category when genuinely uncertain), so an
ambiguous "recurring content" email has a defined fallback instead of an
easily-ignored subtype guess.

The model is instructed to reply with only a JSON array:
`[{"id": "...", "category": "..."}]`, one object per email, same order as
given.

No validation is performed on the returned `category` string against the
five known values — this has been true since v1.1 (the original 4-value
scheme wasn't validated either) and remains a known gap, not something v4
introduced.

## 4. Non-goals

- No writes to the mailbox of any kind — no `Email/set`, no keyword
  tagging, no folder moves, no `EmailSubmission`, no notifications. All of
  that is v2.
- No Sieve script changes.
- No Lambda deployment (planned, not yet built — see
  [§8 Future work](#8-future-work)).
- No attachment *content* fetch — no `Blob/get`, no PDF/DOCX parsing, no
  OCR. Only attachment file names are used (§3.5). Downloading and parsing
  arbitrary attachment binaries is a materially bigger, riskier change
  (untrusted file parsing, scanned-PDF/OCR cost, a much larger prompt) for a
  second-order signal beyond what the name alone already gives — a separate
  future proposal if name-only signal proves insufficient, not a rider on
  this system.

## 5. Key design decisions

| Decision | Rationale |
|---|---|
| **Full body text + attachment names as model input**, not `preview` only (v1.2) | `preview` (~250 chars) hid payment status below the fold on the attention/noise bill tie-breaker, and never surfaced attachment names (`Mahnung.pdf`, `Bordkarte.pdf`) as a signal at all. Confirmed again at v4 time that this stays — the category-scheme simplification and input richness are orthogonal; nothing about flattening categories requires reverting to `preview`. |
| **`BATCH_SIZE = 1`**, not 10 (v1.1) or larger | v1.1's batch-size experiment (50 real messages, batches of 5/10/25/50 vs. one-call-per-email) found batch=10 as the sweet spot against `preview`-sized input (~60 tokens/email). Once input moved to full body text (~800-1000 tokens/email, v1.2), that experiment's conclusion no longer applied, and re-running it at ~15x the per-email payload wasn't judged worth it when per-email calls were already the experiment's own accuracy baseline. This reopens the throttling risk batching was originally introduced to reduce — `invokeBedrock`'s retry-with-backoff is what actually absorbs that now. |
| **`html-to-text` as a new runtime dependency** (v1.2) | The project's prior zero-extra-dependency stance tracked "don't reinvent AWS SDK / JSON parsing," not "avoid all dependencies on principle." A hand-rolled HTML stripper's known failure modes (script/style leakage, entity decoding) cost more in wrong classifications than the dependency costs in surface area. |
| **5 flat categories, no subtype** (v4) | Simplifies the output schema and removes an unexplained-to-the-model two-tier structure (category + conditional subtype). `newsletters` and `noise` becoming first-class categories, instead of both hiding under one `archive` bucket, gives the model a real definition to classify recurring-content mail against instead of an implicit subtype guess with "being wrong costs nothing." |
| **Visibility-ordering tie-breaker** (`attention > keep > newsletters > noise`, v4) | Replaces two separate pairwise "in doubt, prefer X" tie-breakers (v1.1-v3: attention-vs-archive, archive-vs-suspicious) with one general rule covering all adjacent pairs, including the new newsletters/noise boundary that didn't exist before. |
| **Defensive JSON extraction (`extractJsonArray`)** | Empirically, Haiku sometimes wraps its JSON reply in a ` ```json ` fence and/or appends trailing prose (e.g. "**Reasoning:** ...") despite the prompt saying "Reply with ONLY a JSON array." Rather than fight this in the prompt indefinitely, the parser scans for the first balanced top-level `[...]` and ignores everything else. |
| **Whole-batch failure marks every email in the batch as a failure; a missing id is an individual failure** | A network error or unparseable response can't be attributed to one email, so it's charged to the whole batch; a dropped id within an otherwise-valid response is charged only to that email. Still relevant at `BATCH_SIZE = 1`, where a "batch" is one email. |
| **Retry-with-backoff on Bedrock throttling** | Observed empirically: sequential `InvokeModel` calls with no pacing hit `ThrottlingException`. This is the primary defense against throttling now that `BATCH_SIZE = 1` maximizes call volume relative to v1.1's batching. |
| **`TRIAGE_MAILBOX_ID` env var (optional)** | The `/Triage` mailbox id is stable across runs, so resolving it via `Mailbox/query` on every invocation is a round trip that can be cached. Since a JMAP result reference can't compute it inline within `Email/query`'s filter (§3.3), the alternative is an explicit override — intended for the future Lambda deployment, which will set it as a fixed environment variable and never call `Mailbox/query` at all. |
| **`BEDROCK_MODEL_ID` is a required env var, never hardcoded** | Bedrock model IDs (and whether a model needs a cross-region inference profile ID vs. a bare model id) change over time and per-region. The script fails fast with the exact `aws bedrock list-foundation-models` / `list-inference-profiles` commands to look it up. |
| **`prompt.ts` split from `triage.ts`** | See [§3.6](#36-prompt-as-a-separate-module). |
| **No batching of the *v2* action, no folder-move logic, no notifications** | Explicitly deferred — this component's only job is classification quality, validated against real mail, before anything touches the account. |

## 6. Token / cost impact

- `preview` (v1.1) was ~250 characters (~60 tokens/email). A body capped at
  4000 bytes (v1.2-onward) is roughly 800-1000 tokens/email — **10-15x more
  input tokens per email** — before attachment names are added.
- Cost scales roughly linearly with that input-token growth, independent of
  batch size (batching affects call count/latency, not total tokens sent).
  The `4000`-byte cap is the parameter that actually trades cost against
  classification quality; worth sanity-checking Haiku's per-token input
  price against expected message volume if volume grows substantially. Not
  currently tuned per-message-size (e.g. only fetching full body for
  messages under some size, falling back to preview for huge ones) — that
  remains a possible future optimization, not a current requirement.
- `maxTokens` in `classifyBatch` (`150 * emails.length + 200`) was sized
  against the larger `id`/`category`/`subtype` output schema. v4 dropped
  `subtype`, shrinking the schema, so this is now more headroom than
  needed rather than less — left as-is rather than tuned down for a
  handful of tokens.

## 7. Configuration

| Env var | Required | Purpose |
|---|---|---|
| `FASTMAIL_TOKEN` | Yes | Fastmail API token. Read-only Mail scope is sufficient — this script performs no writes. |
| `BEDROCK_MODEL_ID` | Yes | Bedrock model id (or cross-region inference profile id) for Claude Haiku in `eu-central-1`. No default — see rationale above. |
| `TRIAGE_MAILBOX_ID` | No | Skips the `Mailbox/query` lookup for `/Triage` and uses this id directly. |
| `--limit=<n>` (CLI flag, not env) | No | Caps how many `/Triage` messages are fetched. Default 20. |

Constants tunable in `triage.ts` (not currently exposed as env vars):
`BEDROCK_REGION` (`eu-central-1`), `BATCH_SIZE` (1), `MAX_RETRIES` (5),
`RETRY_BASE_DELAY_MS` (1000, doubles per attempt), `DELAY_BETWEEN_BATCHES_MS`
(300), `MAX_BODY_VALUE_BYTES` (4000), `MAX_ATTACHMENTS` (10).

## 8. Future work

- **v2**: act on the classification — move `attention`/`keep` mail out of
  `/Triage` into `Inbox`, file `newsletters`/`noise` mail into folders
  (folder mapping not yet designed — simpler now than under the old
  subtype scheme, since there's no per-subtype folder fan-out), fire a
  Pushover notification for anything landing in `Inbox`.
- **Lambda deployment**: run this on a schedule (e.g. every 5 minutes)
  instead of manually from a terminal. `TRIAGE_MAILBOX_ID` exists
  specifically to support this.
- **Re-validate `newsletters` vs. `noise` at volume**: spot-checked at
  5 real messages (§9) but not yet run through a dedicated before/after
  comparison against the v3 archive+subtype output the way the original
  prompt and the v1.2 body/attachment change were. Specifically watch
  whether the visibility-ordering tie-breaker drags borderline `noise`
  mail up to `newsletters` more than intended.
- **Attachment-name tie-breakers**: v4's prompt doesn't call out attachment
  names with their own rule (§3.5). If validation surfaces a regression on
  the specific cases v3's tie-breakers were written for
  (`Mahnung*.pdf`/`Bordkarte*.pdf`), add an equivalent rule back rather than
  assuming ambient context is enough.
- **`category` validation**: the model's returned category string is never
  checked against the five known values (§3.7). Not currently a problem in
  practice, but a low-cost hardening candidate if typo'd/hallucinated
  categories are ever observed.
- **Re-run the batch-size comparison** if message volume or category mix
  changes meaningfully — `BATCH_SIZE = 1` was chosen by sidestepping the
  question (§5), not by re-measuring it at full-body-input token sizes.

## 9. Testing performed

No automated test suite exists (this is a small CLI tool, not a library).
Validation to date has been empirical, against live Fastmail + Bedrock:

- **v1.1**: live runs at 6 and 15 messages (exercising the batch=10/batch=5
  chunk boundary); a dedicated batch-size experiment (`experiment-batch.ts`,
  since deleted) against 50 real inbox messages at sizes 5/10/25/50 vs.
  one-call-per-email, driving the (now-superseded) `BATCH_SIZE = 10`
  decision.
- **v1.2**: live-tested against the real `/Triage` mailbox (15 messages, 15
  Bedrock calls at `BATCH_SIZE = 1`) — no throttling, sensible output, zero
  writes. Not a full before/after diff against the old preview-only prompt.
- **v4**: live-tested against the real `/Triage` mailbox (`--limit=5`) —
  ran end-to-end with no crashes, no throttling, `subtype` correctly absent
  from output, and all three of `noise`/`suspicious`/`attention` observed
  across the 5-message sample. Not yet a dedicated before/after diff against
  v3's archive+subtype output on a larger sample (§8) — that's the main
  outstanding validation step before treating v4 as fully proven on real
  mail volume.
