# triage.ts — Design Document

Status: implemented. Last updated 2026-08-20 (classification prompt at
`PROMPT_VERSION = "v7"`; see `prompt.ts`'s own version-history comment for
how the prompt got here — that history isn't repeated in this doc).

> **2026-08-20 note**: `src/lambda.ts`'s cold start now fetches the live
> prompt from S3 (`current.json`), caching it across warm invocations and
> falling back to the bundled `prompt.ts`/`PROMPT_VERSION` (§3.6 below) if
> that fetch fails — `classifyBatch` (§3.1) and `planActions` (§3.6) were
> parameterized accordingly. The CLI path is unchanged: it still classifies
> with the bundled prompt directly. This is what makes `jmap-triage-mcp`'s
> `approve_prompt_diff` actually change production behavior instead of only
> writing a record nothing reads. See `docs/jmap-triage-mcp-proposal-v4.md`.

## 1. Purpose

`triage.ts` polls `Inbox/Triage` (populated by a separate, already-configured
Sieve catch-all rule), classifies each message with Claude Haiku on AWS
Bedrock, and closes the loop by acting on that classification:

```
┌──────────────┐   ┌────────────┐   ┌────────────────┐   ┌───────────────────────────┐
│ Incoming mail│-->│ Sieve      │-->│ Inbox/Triage   │-->│ triage.ts                 │
│              │   │ catch-all  │   │ mailbox        │   │  1. classify (category,   │
└──────────────┘   └────────────┘   └────────────────┘   │     notify)               │
                                                          │  2. act: move             │
                                                          │  3. tag: $ai-* keyword(s) │
                                                          │  4. notify: Pushover      │
                                                          └────────────┬──────────────┘
                                                                       │
                              ┌─────────────┬────────────┬────────────┼───────────────┐
                              ▼             ▼            ▼            ▼               ▼
                           Inbox    Inbox/Orders  Inbox/Suspicious  Inbox/News   Archive/Noise

                           Pushover push (priority 0) whenever the model's own
                           `notify` field is true, for any category — see §3.4.
```

- **Classify**: fetch from `Inbox/Triage`, classify each email individually
  (one Bedrock call per email) with Claude Haiku, into one of five categories
  plus an independent `notify` boolean. See §3.1, §3.6.
- **Act**: move each classified email out of `Inbox/Triage` into exactly one
  destination mailbox, per the mapping in §2.
- **Tag**: stamp each successfully-moved email with an
  `$ai-<promptVersion>-<category>` keyword (and, when notified,
  `$ai-<promptVersion>-notified`), so a later, separate learning stage (not
  built yet) can compare this original classification against wherever the
  email actually ends up after the user files it manually. See §3.6.
- **Notify**: after a successful move, fire a Pushover push for any email the
  model marked `notify: true`, regardless of category, with a deep link back
  to the message in Fastmail's web UI. See §3.4.

## 2. Requirements

- Move (not copy) each classified email from `Inbox/Triage` into one
  destination mailbox, chosen by category:

  | Category | Destination |
  |---|---|
  | `inbox` | `Inbox` |
  | `orders` | `Inbox/Orders` |
  | `suspicious` | `Inbox/Suspicious` |
  | `newsletters` | `Inbox/News` |
  | `noise` | `Archive/Noise` |

  `Inbox/Triage` is the *source* mailbox every classified email leaves, not a
  sixth destination any category maps to.
- Send a Pushover notification (priority `0`) for every successfully-moved
  email where the model's `notify` field is `true` — independent of category.
  There is no category-level gate in code; restraint (e.g. never pushing for
  `suspicious`) lives entirely in the classification prompt (§3.4, prompt.ts
  v7 changelog).
- The notification links back to the message in Fastmail (`url` /
  `url_title` params).
- Stamp a `$ai-<promptVersion>-<category>` keyword on every successfully-moved
  email, and an additional `$ai-<promptVersion>-notified` keyword when
  `notify` was true (§3.6).
- Default to **not writing anything** unless explicitly told to (`--apply`).
- Runnable both from a terminal (CLI) and unattended (AWS Lambda on an
  EventBridge schedule) from the same pipeline logic — see §3.7.

## 3. Architecture

### 3.1 Data flow

```
main() [triage.ts / CLI shell in main.ts]
  ├─ load config: .env, CLI flags (--limit, --apply, --no-notify)
  ├─ bootstrapSession(token)                     -- jmap-session.ts
  ├─ resolveMailboxes(session, overrides)         -- mailboxes.ts
  │     resolves all six mailbox ids in MAILBOX_SPECS (§3.2)
  ├─ fetchTriageEmails(session, triageId, limit)  -- fetch-emails.ts
  ├─ classifyBatch(...) per email                 -- classify.ts, one Bedrock
  │     call per email (CLASSIFY_BATCH_SIZE = 1)
  ├─ planActions(emails, outcomes, destinations)  -- actions.ts, pure function
  │     category -> destination mailbox + $ai-* keyword(s), per §2's table
  ├─ if --apply:
  │     applyMoves(session, triageId, planned)    -- actions.ts
  │       one Email/set call per write-batch (§3.3), patch-style mailboxIds +
  │       keyword update in the same patch object; failures collected, not
  │       thrown
  │     for each successfully-moved email with notify: true:
  │       sendPushoverNotification(...)           -- notify.ts
  │         non-fatal on failure; logged, run continues
  │   else:
  │     print planned moves / notifications, perform neither ("dry run")
  └─ print classification table + failures, moves table (moved / skipped /
     failed), notifications table (sent / skipped / failed)
```

### 3.2 Mailbox resolution (`mailboxes.ts`)

Every mailbox the pipeline touches is described once, in a single table,
`MAILBOX_SPECS`:

```ts
{ key, path, envVar, category? }
```

`config.ts`'s override reading and `actions.ts`'s category→destination
mapping both derive from this table rather than keeping their own hand-synced
copy — adding a mailbox means adding one row here, not editing three files in
lockstep.

- `resolveMailboxPath(session, path)` resolves a path of mailbox names, since
  five of the six mailboxes in play are nested under `Inbox` or `Archive`.
  The first path segment is resolved by JMAP `role` when the name matches a
  known role (`Inbox` → `role: "inbox"`, `Archive` → `role: "archive"`),
  falling back to a top-level (`parentId: null`) name match otherwise — role
  is the part of RFC 8621 actually guaranteed unique and stable; a
  display-name match is incidental and would break under a renamed or
  localized mailbox. Subsequent segments are resolved by name among the
  children of the previously-resolved id. A shared root (e.g. `Inbox`) is
  resolved once and cached across every spec that starts with it.
- Each of the six mailboxes has its own optional env var override
  (`TRIAGE_MAILBOX_ID`, `INBOX_MAILBOX_ID`, `INBOX_ORDERS_MAILBOX_ID`,
  `INBOX_SUSPICIOUS_MAILBOX_ID`, `INBOX_NEWS_MAILBOX_ID`,
  `ARCHIVE_NOISE_MAILBOX_ID`) that skips its lookup and uses the given id
  directly — all six are stable ids across runs, which is what lets the
  Lambda deployment (§3.7) skip every `Mailbox/query` call.
- **No mailbox is auto-created.** If a destination mailbox doesn't exist,
  resolution fails fast with an actionable message ("create mailbox <name>
  under <parent> in Fastmail Settings → Mailboxes, or set <ENV_VAR> if it
  already exists under a different name/parent"). This applies to the whole
  run: resolution happens before fetching or classifying anything, so a
  missing mailbox is caught before a single Bedrock call is spent, rather
  than classifying and then silently skipping moves for one category.

### 3.3 Moving mail (`actions.ts` — `applyMoves`)

- A move is a JMAP `Email/set` **patch update** on `mailboxIds`, not a full
  replace: `{"mailboxIds/<triageId>": null, "mailboxIds/<destId>": true}`.
  Patch form is used because JMAP `mailboxIds` is a set an email can belong
  to more than one member of simultaneously — patching only the two entries
  in play leaves any other mailbox membership untouched, which a wholesale
  replace would silently clobber.
- **Batched, unlike classification.** Classification is one Bedrock call per
  email (a model-accuracy choice, unrelated to writes). There's no equivalent
  constraint on `Email/set`: multiple emails' updates are batched into a
  single call, up to `WRITE_BATCH_SIZE` (50, chosen conservatively below
  typical JMAP server `maxObjectsInSet` limits).
- **Per-email failure isolation.** `Email/set`'s response separates
  `updated` from `notUpdated` per id within one call, so a single email
  rejected by the server (e.g. concurrently deleted by the user) doesn't
  fail the rest of its batch.
- **Crash/re-run safety by construction, no processed-marker needed.** A
  move is the only state change that removes an email from `Inbox/Triage`.
  If the script crashes mid-run, a re-run simply re-fetches whatever is
  still in `Inbox/Triage` — already-moved emails aren't there anymore, so
  they aren't reprocessed.
- The `$ai-*` keyword(s) (§3.6) ride in the same `Email/set` patch object as
  the mailbox change — one write per email, not two — so a move and its
  keyword(s) always succeed or fail together.

### 3.4 Notifications (`notify.ts` — `sendPushoverNotification`)

`application/x-www-form-urlencoded` POST to
`https://api.pushover.net/1/messages.json`:

| Param | Value |
|---|---|
| `token` | `PUSHOVER_TOKEN` (env / SSM) |
| `user` | `PUSHOVER_USER` (env / SSM) |
| `title` | `subject` |
| `message` | `"<from>\n<preview>"` — JMAP's own ~250-char `preview` field, not the full body text used for classification |
| `priority` | `0` (normal) |
| `url` | Fastmail deep link, see below |
| `url_title` | `"Open in Fastmail"` |

- **Single notify tier, driven entirely by the model's own `notify` field**
  (classify.ts / prompt.ts), not by category. There is deliberately no
  category gate in code — what keeps e.g. `suspicious` mail from pushing is
  the prompt's NOTIFY section, not this code. See prompt.ts's v7 changelog
  for the reasoning (a push on a phishing email increases the odds of
  careless engagement, so `suspicious` never sets `notify: true` by prompt
  convention, not by a code-level filter).
- **Deep link URL**: `https://app.fastmail.com/mail/<destination-path>/<emailId>`
  — the *destination* mailbox's full path (post-move) plus the bare email
  id, verified live against a nested mailbox
  (`https://app.fastmail.com/mail/Inbox/Triage/StnVqnj87Erc` uses the full
  `Inbox/Triage` path, not a leaf name). No `threadId` lookup is needed.
- **Notify only after a confirmed move.** If `Email/set` reports an email as
  `notUpdated`, no notification is sent for it — the deep link would point
  at a mailbox the email was never actually filed into.
- Non-fatal on failure: a Pushover error is logged and the run continues —
  notification delivery isn't critical enough to abort a run that already
  committed real mailbox moves.

### 3.5 Dry run vs. `--apply`

- **Default (no flag): dry run.** Fetch, classify, and print exactly what
  *would* move where, what keyword(s) *would* be written, and what
  notification *would* fire — no `Email/set`, no Pushover call.
- **`--apply`: perform the moves, write the keyword(s), and send
  notifications.**
- **`--no-notify`** (only meaningful with `--apply`): perform moves and
  tagging, skip Pushover — useful for validating move logic against a live
  mailbox without generating phone notifications while doing so.

### 3.6 Keyword tagging (`$ai-<promptVersion>-<category>` / `-notified`)

Each successfully-moved email is stamped with keywords recording what the AI
decided and which prompt version decided it — e.g. `$ai-v7-inbox`, plus
`$ai-v7-notified` if `notify` was true. This doesn't build a learning stage;
it only writes the durable state a later, separate pass would need to build
one.

- **Format**: `$ai-<promptVersion>-<category>`, where `<promptVersion>` is
  `prompt.ts`'s `PROMPT_VERSION` export (currently `"v7"`). Stamping the
  prompt version, not just the category, lets a future comparison ask "did
  disagreement go up after this specific prompt edit?" instead of only "was
  this one classification wrong?". `$ai-<promptVersion>-notified` is a
  separate keyword, present only when `notify` was true, so the notify
  decision leaves a trace in the mailbox instead of existing only in a
  Pushover log.
- **Written where**: the same `Email/set` patch object `applyMoves` (§3.3)
  builds for the mailbox move — `keywords/$ai-...` keys alongside the
  `mailboxIds/...` keys, zero extra JMAP round trips. A move and its
  keyword(s) are therefore atomic with each other: if the `Email/set` patch
  for one email is rejected (`notUpdated`), nothing happened, and the email
  stays in `Inbox/Triage` untagged for the next run.
- **Written only under `--apply`**, same as the move itself. The dry-run
  table shows the keyword(s) that would be written, alongside a
  `wouldNotify` column.
- **Maintenance burden, not automated**: `PROMPT_VERSION` must be bumped by
  hand whenever `prompt.ts` changes substantively. Nothing enforces this. If
  forgotten, the failure mode is silent: classifications from two different
  prompt versions get tagged identically, which just means a future
  comparison pass can't distinguish them — not a crash, not a wrong move.
- **Read back by `jmap-triage-mcp`'s `get_triage_report`** (`src/report.ts`)
  — scans wherever mail currently lives for these keywords, compares the
  category (and whether it was notified) against where the email is
  actually sitting now. See `docs/jmap-triage-mcp-proposal-v4.md`. §6/§7
  below describe the original, still-accurate motivation; the "not built
  here" framing there predates that tool.

### 3.7 Deployment: CLI and Lambda

`main.ts` splits into `runPipeline(config)` (the pipeline body: classify →
act → tag → notify) and `main()` (a thin CLI-only shell around it: `.env`
loading, `process.argv` parsing, CLI-flavored required-env-var error
messages). `triage.ts` at the repo root is just the CLI entrypoint that calls
`main()`.

`src/lambda.ts` is a second caller of `runPipeline()`, for unattended
operation on an EventBridge schedule:

- Secrets (`FASTMAIL_TOKEN`, `PUSHOVER_TOKEN`, `PUSHOVER_USER`) are fetched
  from SSM Parameter Store `SecureString`s once per container and cached
  across warm invocations, instead of living in plaintext Lambda env vars.
- Everything else (`BEDROCK_MODEL_ID`, the six mailbox id overrides,
  `LIMIT`) is a plain Lambda env var, reusing `readMailboxOverrides()` from
  `config.ts` unchanged.
- `event.dryRun` overrides the default `apply: true, notify: true`
  production path, mirroring the CLI's dry-run default — e.g.
  `aws lambda invoke --payload '{"dryRun": true}'` to validate a deployment
  against real `Inbox/Triage` state without moving mail.
- Errors are rethrown (not swallowed) so the invocation reports as failed —
  Lambda's `Errors` metric and default async-invoke retry both depend on
  that.

Full deployment mechanics (SAM template, packaging, secrets setup, going
live) are in `docs/DEPLOY-v1.md` — this section covers only the code-level
seam that makes the same pipeline runnable from both entrypoints.

## 4. Module structure

```
triage.ts                 -- CLI entrypoint: `npx tsx triage.ts [--limit=n] [--apply] [--no-notify]`
prompt.ts                 -- classification prompt text + PROMPT_VERSION export (§3.6)
src/
  config.ts                -- loadEnvFile, CLI flag parsing, env var validation,
                               readMailboxOverrides (generic over MAILBOX_SPECS)
  jmap-session.ts           -- Session type, bootstrapSession, jmapRequest
  mailboxes.ts              -- MAILBOX_SPECS (single source of truth, §3.2),
                               resolveMailboxes
  fetch-emails.ts           -- fetchTriageEmails, extractBodyText,
                               extractAttachmentNames, formatAddresses,
                               TriageEmail type
  classify.ts               -- classifyBatch, invokeBedrock,
                               extractJsonArray, ClassificationOutcome type
  actions.ts                -- destinationsFor (derived from MAILBOX_SPECS),
                               planActions, applyMoves, keyword helpers (§3.3, §3.6)
  notify.ts                 -- buildFastmailUrl, sendPushoverNotification (§3.4)
  main.ts                   -- runPipeline (reusable pipeline body) + main
                               (CLI-only shell) (§3.7)
  lambda.ts                 -- Lambda handler: SSM secrets, event.dryRun, calls
                               runPipeline (§3.7)
```

- **Split by pipeline stage, not by technical layer** (i.e. not
  `types.ts`/`http.ts`/`utils.ts`) — each file is something a prompt- or
  policy-only change would touch alone: editing the category→mailbox mapping
  touches only `mailboxes.ts`/`actions.ts`, editing notification behavior
  touches only `notify.ts`, revising the classification prompt touches only
  `prompt.ts`.
- Shared types (`TriageEmail`, `ClassificationOutcome`, `PlannedAction`,
  `MailboxRefs`) live in the module that owns their producing function and
  are imported where consumed, rather than a separate `types.ts`.

## 5. Non-goals

- **No mailbox auto-creation.** All six mailboxes must already exist; the
  script only resolves and writes to them (§3.2).
- **No undo / rollback mechanism.** A move is a single `Email/set` patch;
  reversing one means another `Email/set` call, done manually today.
- **No batching optimization for Pushover.** One HTTP call per
  notification-eligible email, sent sequentially.
- **No learning-stage comparison logic.** The pipeline only writes the
  `$ai-<promptVersion>-<category>` / `-notified` keywords (§3.6); reading
  them back and comparing against where mail actually ends up is separate,
  later work (§6).

## 6. Configuration

| Env var | Required | Purpose |
|---|---|---|
| `FASTMAIL_TOKEN` | Yes | Fastmail API token, read/write Mail scope. |
| `BEDROCK_MODEL_ID` | Yes | Bedrock Claude Haiku model id (looked up, not hardcoded — see README). |
| `PUSHOVER_TOKEN` | Yes, unless `--no-notify` always passed | Pushover application token. |
| `PUSHOVER_USER` | Yes, unless `--no-notify` always passed | Pushover user/group key. |
| `TRIAGE_MAILBOX_ID` | No | Skips lookup of `Inbox/Triage` (source). |
| `INBOX_MAILBOX_ID` | No | Skips role-based lookup of `Inbox`. |
| `INBOX_ORDERS_MAILBOX_ID` | No | Skips path lookup of `Inbox/Orders`. |
| `INBOX_SUSPICIOUS_MAILBOX_ID` | No | Skips path lookup of `Inbox/Suspicious`. |
| `INBOX_NEWS_MAILBOX_ID` | No | Skips path lookup of `Inbox/News`. |
| `ARCHIVE_NOISE_MAILBOX_ID` | No | Skips path lookup of `Archive/Noise`. |
| `--limit` (CLI flag) | No | Max emails fetched from `Inbox/Triage`. Default 20. |
| `--apply` (CLI flag) | No | Enables real writes + notifications. Default: dry run (§3.5). |
| `--no-notify` (CLI flag) | No | With `--apply`, performs moves + tagging but suppresses Pushover. |

Lambda-only configuration (`FASTMAIL_TOKEN_PARAM`, `PUSHOVER_TOKEN_PARAM`,
`PUSHOVER_USER_PARAM` SSM parameter names, `LIMIT`, `event.dryRun`) is
covered in `docs/DEPLOY-v1.md`, not repeated here.

## 7. Future work

- ~~Build the learning stage the `$ai-*` keywords (§3.6) exist to feed.~~
  Done — `jmap-triage-mcp`'s `get_triage_report` (`src/report.ts`) is that
  pass. See `docs/jmap-triage-mcp-proposal-v4.md`.
- Remember to bump `PROMPT_VERSION` in `prompt.ts` on the next substantive
  prompt rewrite (§3.6) — nothing enforces this automatically.
- Consider `Mailbox/set`-based auto-creation of the destination mailboxes if
  manual setup proves to be a recurring friction point (currently rejected,
  §5, as a bigger decision than this doc's scope).
