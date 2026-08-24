# jmap-triage

## triage.ts

v5 of the jmap-triage system (prompt at v7). Polls `Inbox/Triage` (populated
by a separate, already-configured Sieve catch-all rule), classifies each
message one at a time with a Bedrock model (BEDROCK_MODEL_ID -- currently
gpt-oss-120b) into one of 5
categories (`inbox`, `orders`, `suspicious`, `newsletters`, `noise`), then
acts on the classification and notifies about it. Category decides where a
message is filed; a separate `notify` boolean from the same model call
decides whether it's worth a phone push, independent of category:

| Category | Moved to |
|---|---|
| `inbox` | `Inbox` |
| `orders` | `Inbox/Orders` |
| `suspicious` | `Inbox/Suspicious` |
| `newsletters` | `Inbox/News` |
| `noise` | `Archive/Noise` |

Any email — regardless of category — fires a Pushover push (priority `0`)
when the model sets `notify: true`. There's no category-level gate on this
in code; restraint (e.g. never pushing for `suspicious`) lives entirely in
the prompt. See `prompt.ts`'s v7 changelog for the reasoning.

Each successfully-moved email is also tagged with a keyword —
`$ai-<promptVersion>-<category>`, e.g. `$ai-v7-inbox` — recording what the
AI decided and which prompt version decided it. An email that was flagged
for a push additionally gets `$ai-<promptVersion>-notified`, so the notify
decision leaves a trace in the mailbox instead of only in a Pushover log.
Nothing reads either keyword back yet; it's groundwork for a later, separate
learning stage that compares this original classification against wherever
the email actually ends up after you file it manually.

**Defaults to a dry run** — prints the classification and the moves/
notifications/keywords that *would* happen, writes nothing. Pass `--apply`
to actually move mail, tag it, and send notifications; add `--no-notify` to
move and tag mail without sending anything to Pushover. See
`docs/DESIGN-v5.md` for the full design (and
`docs/DESIGN-v4.md` for the classification stage's own
history — unchanged in v5 except for one addition, `PROMPT_VERSION`).

Logic lives in `src/`, split by pipeline stage (`fetch-emails.ts`,
`classify.ts`, `actions.ts`, `notify.ts`, plus `config.ts`,
`jmap-session.ts`, `mailboxes.ts`, and `main.ts` orchestrating all of them).
`triage.ts` itself is just the CLI entrypoint. `prompt.ts`, holding the
classification prompt, stays separate from all of it so it can be edited and
re-validated against real mail independently.

### Prerequisites

1. A Fastmail API token — **read/write Mail scope**, since v5 moves mail
   between mailboxes when run with `--apply`. Go to
   https://app.fastmail.com/settings/security/tokens and create one.
2. AWS credentials with `bedrock:InvokeModel` permission for `eu-central-1`,
   available via the standard AWS SDK credential chain (environment
   variables, `~/.aws/credentials`, SSO, etc). Not read from `.env`.
3. The Bedrock model ID for `eu-central-1` (currently gpt-oss-120b --
   `openai.gpt-oss-120b-1:0`, see `BEDROCK_MODEL_ID`), looked up
   rather than hardcoded (Bedrock model IDs and availability change over
   time):
   ```sh
   aws bedrock list-foundation-models --region eu-central-1 \
     --query "modelSummaries[].modelId"
   ```
   If that ID isn't directly invokable in the region, also check for a
   cross-region inference profile (needed for every current Claude model in
   this account, not for gpt-oss):
   ```sh
   aws bedrock list-inference-profiles --region eu-central-1 \
     --query "inferenceProfileSummaries[].inferenceProfileId"
   ```
   Whichever model you pick, `src/model-pacing.ts` needs its RPM quota
   added to stay correctly paced -- see that file's comment for how to look
   the quota up and why it isn't just `60000 / RPM`.
4. A Pushover token + user key (only needed to run with `--apply` and
   without `--no-notify`) — create an application at
   https://pushover.net/apps/build for the token, and find your user key on
   your Pushover dashboard.
5. The six mailboxes classified mail moves between must already exist:
   `Inbox/Triage` (source), `Inbox`, `Inbox/Orders`, `Inbox/News`,
   `Archive/Noise`, `Inbox/Suspicious`. None of them are auto-created — see
   `docs/DESIGN-v5.md` §3.2/§6.

### Run

```sh
cp .env.example .env   # paste FASTMAIL_TOKEN, BEDROCK_MODEL_ID, PUSHOVER_TOKEN, PUSHOVER_USER
npx tsx triage.ts                        # dry run: classify + print planned moves, write nothing
npx tsx triage.ts --limit=50              # dry run against up to 50 messages
npx tsx triage.ts --apply                 # classify, move mail, and notify
npx tsx triage.ts --apply --no-notify     # classify and move mail, skip Pushover
```

`--limit` defaults to 20. A dry run prints the classification table plus a
table of planned moves (destination, the `$ai-*` keyword that would be
written, and whether a notification would fire). A real (`--apply`) run
additionally prints tables of actual moves (with the keyword actually
written), move failures, skipped emails (classification failed or category
unrecognized — left in `Inbox/Triage`), and notification outcomes.

### Evaluating the classification prompt

```sh
npm run eval          # or: npx tsx eval/run-eval.ts
```

Runs a fixed set of synthetic sample emails (`eval/golden-set.ts`) through
`classifyBatch()` against live Bedrock, one at a time (matching production's
`CLASSIFY_BATCH_SIZE=1`), and reports any category or notify mismatch
against the current `prompt.ts`. It's isolated to the classify stage on
purpose -- no JMAP session, no mailboxes, no moves, no Pushover -- so it
needs only `BEDROCK_MODEL_ID` and AWS credentials, not a Fastmail token.
Not part of CI (it costs money and hits a live model each run); run it by
hand after editing `prompt.ts`, before trusting the change against real
mail. Exits non-zero on any category mismatch.

This is a fast regression check, not a substitute for
`reports/generate-report.ts`, which audits real mail the user actually
received -- the golden set can only catch a rule this file already knows
to test for. Add a case to `golden-set.ts` whenever a real classification
mismatch turns up in the audit report and gets fixed in `prompt.ts`.

### Mailbox id overrides (optional)

By default the script resolves all six mailboxes (`Inbox/Triage`, `Inbox`,
`Inbox/Orders`, `Inbox/News`, `Archive/Noise`, `Inbox/Suspicious`) via
`Mailbox/query` on every run. Each has an optional env var override that
skips its lookup and uses the given id directly — the ids are stable across
runs, so once you know them there's no need to re-resolve them every time.
This is also how the Lambda deployment below avoids JMAP round trips on
every invocation. See `.env.example` for the six variable names.

### Lambda deployment

An AWS SAM template (`template.yaml`) deploys `triage.ts --apply` as a
Lambda function on an EventBridge schedule, so `Inbox/Triage` drains
continuously instead of only when someone runs the CLI. Full design:
`docs/DEPLOY-v1.md`. Prerequisites: the [SAM
CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
the same Bedrock model id and six mailbox ids from the CLI prerequisites
above, and Fastmail/Pushover credentials.

1. **Create the three secrets in SSM Parameter Store** (one-time, out of
   band — never put secret values in the SAM template or the deploy
   command line):
   ```sh
   aws ssm put-parameter --name /jmap-triage/fastmail-token --type SecureString --value "fmu1-..."
   aws ssm put-parameter --name /jmap-triage/pushover-token --type SecureString --value "..."
   aws ssm put-parameter --name /jmap-triage/pushover-user  --type SecureString --value "..."
   ```
2. **Build and deploy**, `ScheduleEnabled` left at its default `false` so
   nothing runs unattended yet:
   ```sh
   sam build
   sam deploy --guided --region eu-central-1
   ```
   `--guided` prompts for the stack name and the template's parameters
   (`BedrockModelId`, the six mailbox ids, etc.) and saves the answers to
   `samconfig.toml` for future plain `sam deploy` runs.
3. **Dry-run the deployed function** before trusting it with real mail —
   `dryRun: true` maps to the same no-writes behavior as the CLI's default
   (no `--apply`):
   ```sh
   aws lambda invoke --function-name <TriageFunctionArn from stack outputs> \
     --payload '{"dryRun": true}' --cli-binary-format raw-in-base64-out response.json
   cat response.json
   ```
   Check CloudWatch Logs for the same classification/planned-moves tables
   the CLI prints. Iterate here, not against the live schedule.
4. **Go live** once the dry run looks right — `sam deploy --guided` again,
   accepting the saved default for every prompt except `ScheduleEnabled`,
   which you set to `true`. (A one-off `--parameter-overrides` on a plain
   `sam deploy` isn't used here since it replaces the whole saved parameter
   set rather than patching one key — `--guided` re-prompting is the safer
   way to change a single parameter.)

### Monitoring the deployed function

```sh
aws logs tail /aws/lambda/$(aws cloudformation describe-stacks --region eu-central-1 --stack-name jmap-triage \
  --query "Stacks[0].Outputs[?OutputKey=='TriageFunctionArn'].OutputValue" --output text | awk -F: '{print $NF}') \
  --follow --region eu-central-1
```

Resolves the function's log group off the stack output rather than
hardcoding its name, which has a random suffix that changes if the stack
is ever recreated. Drop `--follow` for a one-shot look (add `--since 1h`
etc.); add `--filter-pattern "ERROR"` to only see failures.

### jmap-triage-mcp deployment

`McpServerFunction` in `template.yaml` deploys the 5-tool review server
(`src/mcp-server.ts` — `get_current_prompt`, `get_version_history`,
`get_triage_report`, `evaluate_candidate`, `approve_prompt_diff`) as a
second Lambda function behind a Function URL, so a Claude session can
review real triage disagreements and, once a fix is approved, change what
production classifies with — without a redeploy. Full design:
`docs/jmap-triage-mcp-proposal-v4.md`. **Status: deployed and smoke-tested**
against the live stack 2026-08-20, including `get_triage_report` against
the real mailbox. Redeploying (e.g. after editing `src/mcp-server.ts`) is
just `sam build && sam deploy`, same as the pipeline.

**Auth: currently disabled by deliberate choice, not an oversight.**
Claude.ai's custom-connector UI only reliably offers full OAuth 2.0 or no
auth for an individual account — the static-bearer-token option
(`static_headers`) is beta, gated to an admin on a Team/Enterprise
workspace, and a token embedded in the connector URL is explicitly
discouraged by Claude's own docs (logged in proxies/browser history). Given
that, this runs with no app-level auth check for now, relying only on the
Function URL's unguessable subdomain — acceptable for a single-user
personal tool, but worth knowing: **anyone with the URL can call all 5
tools, including `approve_prompt_diff`.** To re-enable the bearer-token
check (e.g. after building real OAuth), just set `MCP_BEARER_TOKEN_PARAM`
back in `McpServerFunction`'s `Environment.Variables` and redeploy — no
code change needed, see `mcp-server.ts`'s `bearerConfigured()`. The
`/jmap-triage/mcp-bearer-token` SSM secret and the function's read
permission on it are left in place for exactly that.

1. **Look up the current AWS Lambda Web Adapter layer ARN** for your region
   and architecture (the deploy prompt below asks for it as
   `LambdaWebAdapterLayerArn` — no default is baked into the template, since
   a hardcoded layer version would go stale; `eu-central-1`/x86_64 was
   `arn:aws:lambda:eu-central-1:753240598075:layer:LambdaAdapterLayerX86:28`
   as of this deploy). See
   [awslabs/aws-lambda-web-adapter](https://github.com/awslabs/aws-lambda-web-adapter#layer).
2. **Deploy** (same stack as the pipeline — `sam deploy --guided` will now
   also prompt for `McpBearerTokenParam` and `LambdaWebAdapterLayerArn`;
   `McpServerFunction`'s build needs `make`, since it uses
   `Metadata.BuildMethod: makefile` — see the root `Makefile` and
   `src/mcp-server-run.sh` for why SAM's built-in Node esbuild builder
   isn't enough here):
   ```sh
   sam build
   sam deploy --guided --region eu-central-1
   ```
3. **Bootstrap `current.json`** — nothing seeds the S3-backed prompt
   automatically, and `get_current_prompt` errors until it exists (the
   *pipeline's* cold-start fetch tolerates this fine, falling back to the
   bundled `prompt.ts`, but the review tools need a real live pointer to
   read and diff against). Seed it from the bundled prompt once:
   ```sh
   npx tsx -e "import(process.cwd()+'/prompt.js').then(m => \
     process.stdout.write(JSON.stringify({version: m.PROMPT_VERSION, prompt: m.PROMPT})))" \
     | aws s3 cp - "s3://$(aws cloudformation describe-stacks --region eu-central-1 --stack-name jmap-triage \
         --query "Stacks[0].Outputs[?OutputKey=='PromptStoreBucketName'].OutputValue" --output text)/current.json" \
       --content-type application/json
   ```
4. **Register the custom connector** in Claude's hosted chat interface,
   pointing it at the stack's `McpServerFunctionUrl` output plus `/mcp`
   (e.g. `https://<id>.lambda-url.eu-central-1.on.aws/mcp`). No auth header
   needed right now — see above.

`evaluate_candidate` has no stored regression corpus to seed or maintain —
what it replays against (open corrections + a counterweight sample) is
derived live on every call from `get_triage_report`'s JMAP keyword scan
plus prior approvals' recorded fixes in `history/`. See
`docs/jmap-triage-mcp-proposal-v5.md` for why v4's persisted
`regression-corpus.json` was removed rather than kept.
