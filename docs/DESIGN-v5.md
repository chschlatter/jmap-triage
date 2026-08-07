# triage.ts — Design Document (v5)

Status: v5 (implemented). Last updated 2026-08-02.

> **2026-08-07 note**: the *mechanism* this doc describes (mailbox
> resolution, patch-style moves, keyword tagging, dry-run-by-default) is
> still current. Two things it hardcodes from v5's implementation moment are
> not: the category set (`attention`/`keep`/`suspicious`/`newsletters`/
> `noise`, prompt.ts v4) and the notify-by-category table (§2, §3.4). Both
> moved on through prompt.ts v5-v7 — `attention`+`keep` merged into `inbox`,
> `orders` was added with its own mailbox (six mailboxes now, not four/five),
> and `notify` became a per-message model decision no longer gated by
> category in code. See `prompt.ts`'s own version-history comment for the
> category rationale and `src/actions.ts`/`src/notify.ts` for current
> mechanism-level details. Tables below are left as-is as the historical
> record of the v5 decision, not corrected in place.

Builds on `triage.ts-DESIGN-v4-2026-08-02.md` (prior implementation: v4,
classification-only, zero writes). v5 adds the action layer v4 explicitly
deferred, adds Pushover notifications, tags each classified email with a
keyword for a future learning stage, and splits the current monolithic
`triage.ts` into functional modules. This doc doesn't repeat v4's rationale
for the classification stage (fetch shape, prompt, categories) — that stage
is unchanged in v5 except for one addition (`PROMPT_VERSION`, §3.6). It
covers only what's new: acting on a classification, notifying about it,
tagging it for later comparison, and the code reorganization needed to hold
all three without `triage.ts` becoming unreadable.

## 1. Purpose

v4 polls `/Inbox/Triage`, classifies each message, and prints a table. It
makes no changes to the mailbox — deliberately, so classification quality
could be validated against real mail before anything touched the account.
That validation has now happened (v4 §9). v5 closes the loop:

```
┌──────────────┐   ┌────────────┐   ┌────────────────┐   ┌──────────────────────────┐
│ Incoming mail│-->│ Sieve      │-->│ Inbox/Triage   │-->│ triage.ts                │
│              │   │ catch-all  │   │ mailbox        │   │  1. classify (v4, as-is) │
└──────────────┘   └────────────┘   └────────────────┘   │  2. act: move   (v5, new)│
                                                          │  3. notify       (v5, new)│
                                                          └────────────┬─────────────┘
                                                                       │
                                              ┌────────────────────────┼───────────────────┐
                                              ▼                        ▼                   ▼
                                     Inbox (attention/keep/     Inbox/News          Archive/Noise
                                      suspicious)               (newsletters)         (noise)
                                                                                          
                                           Pushover push for attention (prio 1),
                                           suspicious (prio 0), keep (prio -1).
                                           No notification for newsletters/noise.
```

- **Classification (unchanged)**: fetch from `Inbox/Triage`, classify with
  Claude Haiku on Bedrock, into `attention` | `keep` | `suspicious` |
  `newsletters` | `noise`. See v4 doc §3.1-§3.7 — not repeated here.
- **Action (new)**: move each classified email out of `Inbox/Triage` into
  exactly one destination mailbox, per the mapping in §2.
- **Notify (new)**: after a successful move, fire a Pushover push for
  `attention`/`keep`/`suspicious` (not for `newsletters`/`noise`), with a
  deep link back to the message in Fastmail's web UI.
- **Tag (new)**: stamp each successfully-moved email with an
  `$ai-<promptVersion>-<category>` keyword, so a later, separate learning
  stage (not built here) can compare this original classification against
  wherever the email actually ends up after the user files it manually. See
  §3.6.

## 2. Requirements

- Move (not copy) each classified email from `Inbox/Triage` into one
  destination mailbox, chosen by category:

  | Category | Destination |
  |---|---|
  | `attention` | `Inbox` |
  | `keep` | `Inbox` |
  | `suspicious` | `Inbox` |
  | `newsletters` | `Inbox/News` |
  | `noise` | `Archive/Noise` |

  This mapping was specified by the user, not derived — see §5 for the
  interpretation this doc assumes (`Inbox/Triage` is a source mailbox that
  every classified email leaves, not a fifth destination).
- Send a Pushover notification per moved email, gated on category:

  | Category | Priority | Notify? |
  |---|---|---|
  | `attention` | `1` | yes |
  | `suspicious` | `0` | yes |
  | `keep` | `-1` | yes |
  | `newsletters` | — | no |
  | `noise` | — | no |

- The notification links back to the message in Fastmail (`url` /
  `url_title` params, per the Pushover example in the request).
- Stamp a `$ai-<promptVersion>-<category>` keyword on every successfully-moved
  email (§3.6) — one keyword, mutually exclusive with the other four, since
  categories are mutually exclusive.
- Default to **not writing anything** unless explicitly told to (`--apply`)
  — see §5. This preserves the validate-before-touching-the-account posture
  v4 established, now applied to the action stage instead of the
  classification stage.
- Split `triage.ts` into functional modules — see §4.

## 3. Architecture

### 3.1 Data flow (additions to v4's pipeline)

```
main()
  ├─ [v4, unchanged] load config, bootstrap JMAP session
  ├─ resolveMailboxes(session)                  -- NEW
  │     resolves { triage, inbox, inboxNews, archivedNoise } mailbox ids
  │     (env var overrides skip each lookup individually, same pattern as
  │      today's TRIAGE_MAILBOX_ID)
  ├─ [v4, unchanged] fetchTriageEmails(...)
  │     -- now also requests the JMAP `preview` property (needed for
  │        notification message bodies, §3.4) alongside the properties v4
  │        already fetches
  ├─ [v4, unchanged] classifyBatch(...) per email
  ├─ planActions(classified)                     -- NEW, pure function
  │     category -> destination mailbox id, per §2's table
  ├─ if --apply:
  │     applyMoves(session, mailboxes.triage, planned)   -- NEW
  │       one Email/set call per write-batch (§3.3), patch-style
  │       mailboxIds + $ai-<version>-<category> keyword update in the same
  │       patch object (§3.6); failures collected, not thrown
  │     for each successfully-moved, notification-eligible email:
  │       sendPushoverNotification(email, category, destinationMailboxId) -- NEW
  │         non-fatal on failure; logged, run continues
  │   else:
  │     print planned moves / notifications, perform neither ("dry run")
  └─ [v4, unchanged shape] print classification table + failures table
     + NEW: print moves table (moved / skipped / failed) + notifications
       table (sent / skipped / failed)
```

### 3.2 Mailbox resolution (`resolveMailboxes`)

Generalizes v4's `getTriageMailboxId` (which resolved one mailbox by a
top-level `Mailbox/query` name filter) to resolve a **path** of mailboxes,
since three of the four mailboxes in play are nested:

```
resolveMailboxPath(session, ["Inbox", "News"]) -> mailbox id
```

- The first path segment is resolved by JMAP `role` when the name matches a
  known role (`"Inbox"` → `role: "inbox"`), falling back to a top-level
  (`parentId: null`) name match otherwise. Resolving `Inbox` by role rather
  than by name string is deliberate — role is the part of RFC 8621 actually
  guaranteed unique and stable; a display-name match on "Inbox" is
  incidental and would break under a renamed or localized mailbox.
- Subsequent segments are resolved by name among the children of the
  previously-resolved id (`Mailbox/query { filter: { parentId, name } }`).
- Each of the four mailboxes gets its own optional env var override
  (`INBOX_MAILBOX_ID`, `INBOX_NEWS_MAILBOX_ID`, `ARCHIVE_NOISE_MAILBOX_ID`,
  and the existing `TRIAGE_MAILBOX_ID`), following the precedent already
  set for `Inbox/Triage` — all four are stable ids across runs, so a future
  Lambda deployment can skip every lookup by setting all four.
- `Inbox/Triage` is confirmed to be `TRIAGE_MAILBOX_ID`'s new path (§5.2) —
  today's single-segment `Mailbox/query { filter: { name: "Triage" } }`
  lookup is replaced by `resolveMailboxPath(["Inbox", "Triage"])`, but the
  env var itself keeps its existing name (`TRIAGE_MAILBOX_ID`) since it's
  still the same mailbox, just resolved via a path instead of a bare name
  filter.
- **No mailbox is auto-created.** If `Inbox/News` or `Archive/Noise`
  doesn't exist, resolution fails fast with an actionable message ("create
  mailbox <name> under <parent> in Fastmail Settings → Mailboxes, or set
  <ENV_VAR> if it already exists under a different name/parent") —
  mirroring the existing `BEDROCK_MODEL_ID`/`getTriageMailboxId` fail-fast
  style. Auto-creating mailbox structure is a bigger, separate decision than
  moving mail between mailboxes that already exist; see §6 non-goals. This
  applies to the whole run, not just the affected category — a run that
  can't resolve any of the four mailboxes fails before fetching or
  classifying anything, rather than classifying and then silently skipping
  moves for one category (§5.5).

### 3.3 Moving mail (`applyMoves`)

- A move is a JMAP `Email/set` **patch update** on `mailboxIds`, not a
  full-object replace: `{"mailboxIds/<triageId>": null, "mailboxIds/<destId>": true}`.
  Patch form is used (not `mailboxIds: {destId: true}` wholesale) because
  JMAP mailboxIds is a set an email can belong to more than one member of
  simultaneously — patching only the two entries in play leaves any other
  mailbox membership (e.g. a shared "starred"-equivalent mailbox, if one
  exists) untouched, which a wholesale replace would silently clobber.
- **Batched, unlike classification.** v4's `BATCH_SIZE = 1` is a Bedrock
  constraint (one model call per email, for accuracy reasons unrelated to
  writes — see v4 §5). There's no equivalent constraint on `Email/set`;
  multiple emails' updates are batched into a single `Email/set` call up to
  a `WRITE_BATCH_SIZE` (default 50, chosen conservatively below typical
  JMAP server `maxObjectsInSet` limits — confirm against
  `session.capabilities["urn:ietf:params:jmap:core"].maxObjectsInSet` at
  implementation time rather than assuming 50 is safe for every server).
- **Per-email failure isolation.** `Email/set`'s response separates
  `updated` from `notUpdated` per id within one call, so a single email
  rejected by the server (e.g. concurrently deleted by the user) doesn't
  fail its whole batch — unlike v4's classification batching, where a
  malformed model response fails everything in the batch because there's no
  per-item structure to fall back on.
- **Crash/re-run safety by construction, no processed-marker needed.** A
  move is the only state change that removes an email from `Inbox/Triage`.
  If the script crashes after moving some emails but before finishing
  notifications, or before finishing the whole batch, a re-run simply
  re-fetches whatever is still in `Inbox/Triage` — already-moved emails
  aren't there anymore, so they aren't reprocessed. This is why moves happen
  before notifications in the per-email sequence (§3.1): the moved-ness of
  an email, not a separate log file, is the durable state.

### 3.4 Notifications (`sendPushoverNotification`)

Request shape follows the example in the request verbatim
(`application/x-www-form-urlencoded` POST to
`https://api.pushover.net/1/messages.json`):

| Param | Value |
|---|---|
| `token` | `PUSHOVER_TOKEN` (env) |
| `user` | `PUSHOVER_USER` (env) |
| `title` | `subject` |
| `message` | `"<from>\n<preview>"` — `preview` is JMAP's own ~250-char preview field (§3.1), not the full `body` text v4 fetches for classification |
| `priority` | `1` / `0` / `-1` per §2's table |
| `url` | Fastmail deep link, see below |
| `url_title` | `"Open in Fastmail"` |

**Deep link URL: `EMAIL_ID`-keyed, not the thread-composite from the
example.** The example URL
(`https://app.fastmail.com/mail/Inbox/AxL4aAHkUMeR.StnXASWtFBJR`) decomposes
as `/mail/<mailbox-name>/<threadId>.<emailId>`. Per direction, v5 instead
uses `/mail/<mailbox-path>/<emailId>` — just the email id v4 already has
(`TriageEmail.id`), no `threadId` lookup needed. This drops the extra
`Email/get` property mentioned in an earlier draft of this doc (§3.1).

- `<mailbox-path>` is the *destination* mailbox's **full path**
  (post-move), confirmed live against a nested mailbox:
  `https://app.fastmail.com/mail/Inbox/Triage/StnVqnj87Erc` — a mailbox
  nested two levels deep uses its full `Inbox/Triage` path, not a leaf
  name. So the notification URL is `Inbox` for attention/keep/suspicious,
  `Inbox/News` for newsletters, `Archive/Noise` for noise — the same path
  strings used to resolve each destination's mailbox id in §3.2, reused
  as-is for the URL rather than re-derived from the resolved mailbox's bare
  name.
- **Notify only after a confirmed move.** If `Email/set` reports an email
  as `notUpdated`, no notification is sent for it — the deep link would
  point at a mailbox the email was never actually filed into.

### 3.5 Dry run vs. `--apply`

v4 was unconditionally read-only. v5 introduces the account's first writes,
so it keeps the same validate-before-touching posture v4 used for
classification, applied one level up:

- **Default (no flag): dry run.** Fetch, classify, and print exactly what
  *would* move where and what notification *would* fire — no `Email/set`,
  no Pushover call.
- **`--apply`: perform the moves and send notifications.**
- **`--no-notify`** (only meaningful with `--apply`): perform moves, skip
  Pushover — useful for validating the move logic against a live mailbox
  without generating phone notifications while doing so.

This is a deliberate escalation of v4's own reasoning (v4 §1: "Splitting
classification from action lets classification quality be validated against
real mail before anything touches the account's folder structure or sends a
notification") rather than a new principle.

### 3.6 Learning-stage keyword tagging (`$ai-<promptVersion>-<category>`)

Each successfully-moved email is stamped with one JMAP keyword recording
what the AI decided and which prompt decided it — e.g. `$ai-v4-attention`,
`$ai-v4-noise`. This doesn't build a learning stage; it only writes the one
piece of durable state a later, separate pass would need to build one.

- **Format**: `$ai-<promptVersion>-<category>`. `<promptVersion>` comes from
  a new `PROMPT_VERSION` export in `prompt.ts` (currently `"v4"` — the
  prompt text itself is unchanged in v5, see the top-of-file note). Stamping
  the prompt version, not just the category, means a future comparison can
  ask "did disagreement go up after this specific prompt edit?" instead of
  only "was this one classification wrong?".
- **Naming convention**: `$`-prefixed custom keywords already have
  precedent in this project — the archived `escalate.ts` PoC used
  `$ai-escalated-dup` for an unrelated purpose. v5 follows the same
  convention rather than inventing a new one.
- **Written where**: the same `Email/set` patch object `applyMoves` (§3.3)
  already builds for the mailbox move — one more `keywords/$ai-...: true`
  key alongside the two `mailboxIds/...` keys, zero extra JMAP round trips.
  A move and its keyword are therefore atomic with each other: if the
  `Email/set` patch for one email is rejected (`notUpdated`), neither the
  move nor the keyword happened, and the email stays in `Inbox/Triage`
  untagged for the next run.
- **Written only under `--apply`**, same as the move itself — a dry run
  still writes nothing. The dry-run table (§3.5) gets a `keyword` column
  showing what *would* be written, alongside the existing `wouldNotify`
  column.
- **Maintenance burden, not automated**: `PROMPT_VERSION` must be bumped by
  hand whenever `prompt.ts` changes substantively. Nothing enforces this —
  it's an extension of the version-history comment convention `prompt.ts`
  already keeps on every rewrite, not a new mechanism. If it's forgotten,
  the practical failure mode is silent: classifications from two different
  prompt versions get tagged identically, which just means a future
  comparison pass can't distinguish them — not a crash, not a wrong move.
- **Why this is enough for a learning stage without building one now**: the
  keyword travels with the email regardless of where the user later files
  it. The comparison itself — scan wherever mail currently lives, read its
  `$ai-*` keyword, compare the category it encodes against the mailbox the
  email is actually sitting in now — is out of scope for v5 (§6, §8); this
  section only adds the tag that comparison would read.

## 4. Module structure

Current state: one file, `triage.ts` (~440 lines), plus `prompt.ts`. v5
adds enough new responsibility (mailbox resolution, moves, Pushover) that
one file stops being the right shape. Proposed layout:

```
triage.ts                 -- thin CLI entrypoint (unchanged invocation:
                              `npx tsx triage.ts [--limit=n] [--apply] [--no-notify]`)
prompt.ts                 -- PROMPT text unchanged from v4; adds one export,
                              PROMPT_VERSION (§3.6)
src/
  config.ts                -- loadEnvFile, env var reads/validation, CLI flag
                               parsing (--limit, --apply, --no-notify)
  jmap-session.ts           -- Session type, bootstrapSession, jmapRequest
  mailboxes.ts              -- resolveMailboxPath / resolveMailboxes (§3.2)
  fetch-emails.ts           -- fetchTriageEmails, extractBodyText,
                               extractAttachmentNames, formatAddresses,
                               TriageEmail type (v4 logic, relocated + adds
                               the `preview` property for notifications)
  classify.ts               -- classifyBatch, invokeBedrock,
                               extractJsonArray, chunk, ClassificationOutcome
                               type (v4 logic, relocated verbatim)
  actions.ts                -- CATEGORY_TO_MAILBOX map (§2), planActions,
                               applyMoves (§3.3), aiKeywordFor (§3.6)
  notify.ts                 -- CATEGORY_TO_PRIORITY map (§2),
                               buildFastmailUrl, sendPushoverNotification
                               (§3.4)
  main.ts                   -- orchestration (the body of today's `main()`),
                               imported and invoked by top-level triage.ts
```

- **Split by pipeline stage, not by technical layer** (i.e. not
  `types.ts`/`http.ts`/`utils.ts`) — each file is something a future prompt-
  or policy-only change would touch alone: editing the label mapping
  touches only `actions.ts`, editing notification priorities touches only
  `notify.ts`, re-validating the classification prompt still only touches
  `prompt.ts`. This continues v4 §3.6's rationale for keeping `prompt.ts`
  separate (different edit/review rhythm per concern) instead of
  introducing a new principle.
- **Top-level `triage.ts` kept as the entrypoint** rather than renamed to
  `src/main.ts` at the top level — the run command in `README.md`
  (`npx tsx triage.ts`) and muscle memory around it don't need to change for
  a refactor that's purely internal.
- Shared types (`TriageEmail`, `ClassificationOutcome`, a new
  `MailboxSet`/`PlannedAction` type) live in the module that owns their
  producing function and are imported where consumed, rather than a
  separate `types.ts` — with five-ish small modules there's no shared-type
  file large enough yet to justify existing on its own.

## 5. Open questions / assumptions this doc makes

All nine were explicitly resolved in conversation — no residual open items.

1. **Resolved**: the category→mailbox mapping is
   `attention`/`keep`/`suspicious` → `Inbox`, `newsletters` → `Inbox/News`,
   `noise` → `Archive/Noise`. `Inbox/Triage` is the *source* mailbox that
   every classified email leaves — not a fifth destination any category
   maps to.
2. **Resolved**: `Inbox/Triage` is `TRIAGE_MAILBOX_ID`'s new path — the same
   physical mailbox `getTriageMailboxId` resolves today (v4's diagram drew
   it as top-level, `/Triage`), now nested under `Inbox` and resolved via
   `resolveMailboxPath(["Inbox", "Triage"])` (§3.2) instead of a bare-name
   filter. The env var keeps its existing name.
3. **Resolved**: the deep-link URL uses `<emailId>` alone
   (`/mail/<mailbox-name>/<emailId>`), not the thread-composite
   (`<threadId>.<emailId>`) the request's raw example showed (§3.4). No
   `threadId` fetch needed.
4. **Resolved**: the Pushover `message` body uses JMAP's own `preview`
   field (§3.1, §3.4) rather than inventing new content or reusing v4's
   full `body` extraction.
5. **Resolved**: a missing `Inbox/News` or `Archive/Noise` mailbox fails
   the whole run, not just moves for the affected category (§3.2).
6. **Resolved, verified live**: the deep-link URL's mailbox segment is the
   destination's **full path** (`Inbox`, `Inbox/News`, `Archive/Noise`),
   not a leaf name — confirmed against
   `https://app.fastmail.com/mail/Inbox/Triage/StnVqnj87Erc` (§3.4).
7. **Resolved**: each classified email is tagged with a keyword
   (`$ai-<promptVersion>-<category>`) for a future learning stage to read;
   building that learning stage itself is out of scope for v5 (§3.6, §6,
   §8).
8. **Resolved**: the keyword includes the prompt version, not just the
   category, via a new `PROMPT_VERSION` export in `prompt.ts` (§3.6).
9. **Resolved**: the dry-run table (§3.5) shows the keyword that would be
   written, in a new `keyword` column alongside `wouldNotify`; a failed move
   fails its keyword too, with no separate handling needed, since both ride
   in the same `Email/set` patch object (§3.6).

## 6. Non-goals

- **No mailbox auto-creation.** `Inbox/News` and `Archive/Noise` must
  already exist; the script only resolves and writes to them (§3.2).
- **No undo / rollback mechanism.** A move is a single `Email/set` patch;
  reversing one means another `Email/set` call, done manually today — no
  "undo last run" feature.
- **No batching optimization for Pushover.** One HTTP call per
  notification-eligible email, sent sequentially, no combining multiple
  emails into one push. Simpler, and notification volume (attention +
  suspicious + keep, only) is expected to be low enough that this doesn't
  matter — revisit only if it doesn't hold in practice.
- **No change to the classification stage itself** — categories, prompt
  text, `BATCH_SIZE = 1`, Bedrock retry logic are all v4, unchanged. v5 is
  additive downstream of classification, not a classification revision
  (the one exception, `PROMPT_VERSION`, is a new export alongside the
  unchanged prompt text, not a change to it — §3.6).
- **No learning-stage comparison logic.** v5 only writes the
  `$ai-<promptVersion>-<category>` keyword (§3.6); reading it back,
  scanning wherever mail currently lives, and comparing against the
  original classification is a separate, later piece of work.
- **No Lambda deployment** — still future work, per v4 §8. v5's per-mailbox
  env var overrides (§3.2) are designed with that eventual deployment in
  mind (skip every `Mailbox/query` lookup, exactly as `TRIAGE_MAILBOX_ID`
  already does), but the deployment itself remains out of scope here.

## 7. Configuration additions

| Env var | Required | Purpose |
|---|---|---|
| `PUSHOVER_TOKEN` | Yes, unless `--no-notify` always passed | Pushover application token. |
| `PUSHOVER_USER` | Yes, unless `--no-notify` always passed | Pushover user/group key. |
| `INBOX_MAILBOX_ID` | No | Skips role-based lookup of `Inbox`. |
| `INBOX_NEWS_MAILBOX_ID` | No | Skips path lookup of `Inbox/News`. |
| `ARCHIVE_NOISE_MAILBOX_ID` | No | Skips path lookup of `Archive/Noise`. |
| `--apply` (CLI flag) | No | Enables real writes + notifications. Default: dry run (§3.5). |
| `--no-notify` (CLI flag) | No | With `--apply`, performs moves but suppresses Pushover. |

`TRIAGE_MAILBOX_ID`, `FASTMAIL_TOKEN`, `BEDROCK_MODEL_ID`, `--limit` are
unchanged from v4 (see v4 §7).

## 8. Future work

- Consider `Mailbox/set`-based auto-creation of `Inbox/News` /
  `Archive/Noise` if manual setup proves to be a recurring friction point
  (currently rejected, §6, as a bigger decision than this doc's scope).
- Re-run this against real `/Inbox/Triage` volume in `--apply` mode once
  built, the same way v4 §9 validated classification empirically before
  trusting it — moves and notifications need their own live validation
  pass, separate from classification's.
- **Build the learning stage the `$ai-*` keyword (§3.6) exists to feed.** A
  separate pass that scans wherever mail currently lives, reads each
  email's `$ai-<promptVersion>-<category>` keyword, and compares it against
  the email's current mailbox to surface disagreements (the user re-filed
  something the AI classified differently). Not designed here — v5 only
  writes the keyword; this is what would read it.
- Remember to bump `PROMPT_VERSION` in `prompt.ts` on the next substantive
  prompt rewrite (§3.6) — nothing enforces this automatically.
