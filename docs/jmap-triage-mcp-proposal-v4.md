# jmap-triage-mcp — closed-loop prompt learning (v4, S3-backed source of truth)

> **2026-08-20 note**: superseded by `jmap-triage-mcp-proposal-v5.md`, which
> removes this doc's `s3://<bucket>/regression-corpus.json` entirely —
> `evaluate_candidate` now derives its corrections and counterweight sets
> live from JMAP keyword state and `get_version_history` instead of reading
> a stored corpus. Everything else below (S3-as-source-of-truth, the 5
> tools other than the corpus-dependent detail of `evaluate_candidate`, the
> loop, the deploy fixes) is still accurate — kept as the historical record
> of the S3-source-of-truth correction and the real deploy fixes it
> triggered, not corrected in place.

Status: implemented and deployed (`src/current-prompt.ts`, `history.ts`,
`report.ts`, `evaluate.ts`, `approve.ts`, `mcp-server.ts`; the pipeline
migration this doc calls out as a prerequisite is also implemented and
live — `lambda.ts`'s cold-start fetch, see `DESIGN-v5.md`). Deployed to the
live `jmap-triage` stack 2026-08-20 and smoke-tested end-to-end against
real AWS: health check, MCP `initialize` handshake, `tools/list`,
`get_current_prompt` (real S3 read), `get_version_history` (real
empty-state read), `evaluate_candidate`'s gate both failing and passing
(replaying against an empty regression corpus), and `get_triage_report`
against the real mailbox (real ratios back: inbox 3/14, orders 0/19,
suspicious 1/11, newsletters 1/4, noise 3/92 mismatches). `approve_prompt_diff`
was deliberately *not* exercised against production — it's the one real
write path, and a test call would plant a fake entry in the real prompt
history and change what production classifies with.

**Auth: running open, not bearer-gated, by deliberate choice.** Claude.ai's
custom-connector UI turned out to only reliably support full OAuth 2.0 or
no auth for an individual account — the `static_headers` bearer-token
option is beta and gated to Team/Enterprise workspace admins, discovered
only after deploying and trying to actually register the connector. Rather
than build a full OAuth 2.1 + DCR + PKCE flow before this was usable at
all, the call was to ship open for now (the Function URL's unguessable
subdomain is the only protection) and revisit — see the README's
"jmap-triage-mcp deployment" section and `mcp-server.ts`'s
`bearerConfigured()` for how to re-enable the bearer check later without a
code change. Last updated 2026-08-20.

Supersedes v3. One correction and one addition:

1. **S3 is the source of truth, not a fallback.** v3 wrongly assumed the
   review session could treat the project's uploaded `prompt.ts` as live
   repo access. It can't — an upload is a snapshot, and more importantly a
   remote MCP server has no path to push a commit back to the repo at all.
   For `approve_prompt_diff` to actually change what the pipeline runs, the
   pipeline has to read from the same store this server writes to.
2. **Version history becomes a durable, structured log, not a comment a
   human has to remember to write.** This is the article's structured
   note-taking principle applied literally: notes persisted outside the
   context window, written by the tool that made the decision, readable
   back by a later session without depending on anyone's memory.

## Consequence: a required pipeline change (implemented alongside this server)

`classify.ts`/`lambda.ts` used to import `PROMPT`/`PROMPT_VERSION` directly
from the bundled `prompt.ts` (`DESIGN-v5.md` §3.6). Making this loop
meaningful required changing that: `lambda.ts` now fetches `current.json`
from S3 once per cold start, caches it across warm invocations (same pattern
`lambda.ts` already used for SSM secrets), and **falls back to the bundled
`prompt.ts`** if that fetch fails. `classify.ts`'s `classifyBatch` and
`actions.ts`'s `planActions` were parameterized to accept an explicit
prompt/version instead of importing the bundled constants directly, so both
the CLI (still bundled `prompt.ts`, unchanged) and the Lambda (S3-fetched,
fail-open) share the same classification/tagging code.

## S3 layout

```
s3://<bucket>/current.json
  { "version": "v8", "prompt": "..." }
  -- the live pointer. classify.ts's cold-start fetch and
     current-prompt.ts both read this. Only approve.ts writes it.

s3://<bucket>/history/<version>.json      -- one immutable record per approved version
  {
    "version": "v8",
    "previousVersion": "v7",
    "prompt": "...",                       -- full text at this version
    "approvedAt": "2026-09-01T10:00:00Z",
    "rationale": "...",                    -- prose, same voice as prompt.ts's v4-v7 comments
    "evidence": ["StnAbc123", "StnDef456"], -- message IDs or cluster names cited
    "paragraphsEdited": ["Suspicious — require a concrete deception signal"],
    "replay": { "fixes": [...], "regressions": [...] }  -- the actual evaluate_candidate
                                                          -- result that justified approval,
                                                          -- embedded, not just claimed
  }

s3://<bucket>/history/index.json          -- ordered list of version strings,
                                              maintained by approve.ts, for cheap
                                              listing without an S3 LIST call

s3://<bucket>/regression-corpus.json      -- NOT part of the original spec, added
                                              during implementation: an array of
                                              {id, expectedCategory, expectedNotify?}
                                              id pointers evaluate_candidate replays
                                              against. No tool builds this (see the
                                              instructions doc's non-goals) — it's
                                              maintained by hand, starts empty, and
                                              a missing object is treated as an empty
                                              corpus, not an error. See regression-corpus.ts.
```

`prompt.ts`'s in-repo comment block doesn't disappear — it's still useful
for anyone reading the code — but it's now a periodic, human-maintained
sync *from* the S3 history, not the thing the loop depends on.

## The 5 tools

| Tool | Does |
|---|---|
| `get_current_prompt` | Returns `current.json` → `{version, prompt}`. The live baseline every draft is built against. |
| `get_version_history` | Returns `{limit?, sinceVersion?}` → an array of past version records from `history/`, most recent first. **This is the structured note-taking read path** — before drafting a new diff, check whether a similar change was already tried and what happened when it was evaluated. |
| `get_triage_report` | Query every mailbox for `$ai-*` keywords, compare stamped category to current mailbox. Returns per-category ratios (mismatches/total) and the mismatch refs. `notify` shown per-row, never folded into ratios. |
| `evaluate_candidate` | Static gate (version bump, JSON-reply shape intact, category vocabulary set-equal to the folder map), then — only if it passes — replay against the regression corpus. Returns `{gate, fixes, regressions}`. |
| `approve_prompt_diff` | Takes the candidate **and the `evaluate_candidate` result that justified it** (not re-derived — embedded, so a record can't claim a replay outcome that didn't actually happen), plus `rationale`/`evidence`/`paragraphsEdited`. Writes `current.json` and a new immutable `history/<version>.json` record. The only write path; always requires explicit human confirmation before being called. |

## Loop (interactive: one-time survey, then a repeating per-cluster round)

```
get_version_history                      (check: has this been tried before?)
      ▼
get_triage_report
      │  mismatch refs (ungrouped — nothing to cluster on yet)
      ▼
Claude fetches the mismatched messages' bodies (Fastmail MCP)
      ▼
Claude clusters the corrections — ordinary reasoning, named groups
      │
      │  ── survey done; everything below repeats per cluster ──
      ▼
──▶ get_current_prompt                    (re-fetch every round — never assume
│         ▼                                the last round's version is current)
│   Claude drafts a diff for ONE cluster, against the fetched prompt
│   — in-session, person watching/steering. No new mail fetch needed;
│         ▼                                 this cluster's bodies were
│                                            already read during survey.
│   evaluate_candidate  ──▶  human review  ──▶  approve_prompt_diff
│         │                                     (writes current.json +
│         │                                      history/<version>.json)
│         ▼
── next cluster, if any remain
```

Clustering has to happen after the body fetch, not before — body content is
what clustering groups on, so there's nothing to cluster before it's read.
Fetching happens once, during survey, for every flagged mismatch; per-round
work only re-fetches the prompt (since an earlier round's approval changes
it), never the mail.

Sequential rounds, one cluster per round by default — same reasoning as
before: `evaluate_candidate`'s gate checks a version bump, so parallel
drafts against the same stale baseline can't all be valid, and bundling
breaks `replay`'s fix/regression attribution. Bundling stays available as a
deliberate human call (precedent: `prompt.ts`'s v5 changelog bundled three
related fixes into one bump), never the default.

## Code architecture

```
src/
  current-prompt.ts   -- get_current_prompt: read current.json. Pure.
  history.ts           -- get_version_history: read history/index.json +
                           history/<version>.json records. Pure.
  report.ts             -- get_triage_report: scan keywords, compute
                           ratios + refs. Pure.
  evaluate.ts            -- evaluate_candidate: static gate + replay,
                           merged. Pure.
  approve.ts              -- approve_prompt_diff: write current.json,
                           write history/<version>.json, update
                           history/index.json. The one write path.
  mcp-server.ts             -- adapter exposing the five as MCP tools.
  s3-json.ts                  -- shared get/put-JSON helper the five above
                                 all build on, so none of them own an
                                 S3Client directly (implementation detail,
                                 not part of the original 5-tool spec).
  regression-corpus.ts          -- internal plumbing for evaluate.ts's
                                 replay step (implementation detail, not
                                 one of the 5 tools — see S3 layout above).
  mcp-server-run.sh                -- Lambda Web Adapter zip-package
                                 startup script (Handler: run.sh); see
                                 the root Makefile's build-McpServerFunction
                                 target, which is what actually copies it
                                 into the deployed package.
```

Same seam as `runPipeline` (`DESIGN-v5.md` §3.7): the five modules are
plain, deterministic TypeScript with no knowledge of MCP or any other
caller; `mcp-server.ts` is a thin shell around them.

## Why these 5, not more

- **MCP servers can't call each other.** A `cluster_corrections` tool here
  could never reach the Fastmail MCP connector's `read_email` — the calling
  session already has that connector, so it does the fetching, not this
  server.
- **The reviewer is already present.** Clustering and diff-drafting stay
  ordinary reasoning in the session, not a separate isolated model call,
  because a human reviews the output either way.
- **`get_version_history` earns its place structurally, not just as a nice
  read.** Without it, the S3 history is write-only — durable but unusable,
  which defeats the point of structured note-taking. The working rule that
  used to point at `prompt.ts`'s comment block ("treat prior decisions as
  ground truth before re-proposing something already tried") now needs an
  actual read path to be true in practice, since the comment block can lag
  behind what's really been approved.
- **One evaluation call, not three**, same as v3: the static gate always
  had to run before replay, so merging them removes a sequencing rule from
  the agent's head into the tool's own contract.

## On the horizon: automated review (not building yet)

Unchanged from v3's reasoning: the Anthropic-hosted MCP connector isn't
supported on Amazon Bedrock, so a future scheduled path is a second adapter
(`review-agent.ts`) exposing `current-prompt.ts`/`history.ts`/`report.ts`/
`evaluate.ts` (never `approve.ts`) as Bedrock tool_use functions, with its
own `jmap_search`/`jmap_read` wrappers around `jmap-session.ts`. Now that
`current.json` is the pipeline's actual live source too, this adapter reads
the same S3 objects the production Lambda does — one less thing to keep in
sync between the interactive and automated paths.

## Still open

- Whether `get_triage_report`'s JMAP scan needs a `since` bound — shipped
  without one first, as planned.
- Whether the automated path's clustering needs a stronger Bedrock model
  than Haiku — likely yes; pilot before trusting it.
- How many rounds is too many for one sitting.
- ~~Exact scope and sequencing of the `classify.ts`/`lambda.ts` cold-start
  migration to S3~~ — done, landed alongside this server (see above).
- **New, discovered during implementation:** the regression corpus
  `evaluate_candidate` replays against wasn't specified in v3/v4's S3
  layout at all. Added as `regression-corpus.json`, hand-maintained, empty
  by default — see the S3 layout section above and `regression-corpus.ts`'s
  header comment. Worth a real decision later on whether it should grow a
  build tool of its own, or stay hand-curated indefinitely.
- **New, found and fixed during the real deploy:** SAM's built-in Node
  esbuild builder only packages the bundle itself, but the Lambda Web
  Adapter's zip-package convention needs a `run.sh` startup script sitting
  alongside it (`Handler: run.sh`, confirmed against
  awslabs/aws-lambda-web-adapter's own `fastmcp-zip` example) — switched
  `McpServerFunction` to `Metadata.BuildMethod: makefile` (root `Makefile`,
  `src/mcp-server-run.sh`) so both files land in the package. Also:
  `AWS_LWA_INVOKE_MODE` takes lowercase `response_stream`, not the Function
  URL's own `RESPONSE_STREAM` casing — easy to get wrong since they sit
  right next to each other in the same `Environment.Variables` block.
- **New, found and fixed during the real deploy:** without `s3:ListBucket`,
  S3 answers a `GetObject` on a nonexistent key with 403 `AccessDenied`
  instead of 404 `NoSuchKey` (it won't confirm non-existence to a caller
  that can't list the bucket) — silently broke `history.ts`'s,
  `regression-corpus.ts`'s, and `approve.ts`'s "missing object means empty
  state, not an error" handling, all of which checked for `NoSuchKey`
  specifically. `McpServerFunctionRole` now also grants `s3:ListBucket` on
  the bucket itself. Confirmed live via `get_version_history` before and
  after the fix.
- **New, found and fixed during the real deploy:** `mcp-server.ts` set
  `FASTMAIL_TOKEN_PARAM` (the SSM parameter *name*) in the Lambda's
  environment but never actually fetched the secret *value* from SSM into
  `FASTMAIL_TOKEN` the way `lambda.ts` does for the pipeline — so
  `get_triage_report`/`evaluate_candidate`'s replay would have failed with
  "FASTMAIL_TOKEN environment variable is not set" the first time either
  was actually invoked. Added `ensureFastmailToken()` (same
  fetch-once-cache-across-invocations pattern as the bearer-token loader)
  and confirmed live via `get_triage_report` returning real ratios.
- **New, discovered only after deploying:** Claude.ai's custom-connector UI
  doesn't expose a static-bearer-token field for an individual account —
  see the "Auth" note in the status block above. Ended up shipping without
  app-level auth for now rather than building full OAuth up front.
