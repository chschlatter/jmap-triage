# jmap-triage

Polls `Inbox/Triage` (filled by a separate, already-configured Sieve
catch-all rule), classifies each message with an LLM into one of five
categories, moves it to the matching mailbox, tags it `$ai-<version>-<category>`,
and fires a Pushover push when the model sets `notify: true`. Category and
notify are independent decisions from the same call — see
[ARCHITECTURE.md](ARCHITECTURE.md) for the category→mailbox map and the full
design, [DECISIONS.md](DECISIONS.md) for why this model, this provider and
these pacing numbers.

**Defaults to a dry run**: prints the classification and the moves, keywords
and notifications that *would* happen, writes nothing. `--apply` performs
them; `--apply --no-notify` moves and tags without pushing.

The classification prompt is not in this repo. It describes a specific real
person, so it lives only in S3 (`current.json` / `history/*`), is fetched live
by every path (CLI, eval, Lambda, MCP server), and changes only through the
review pipeline (`evaluate_candidate` → `approve_prompt_diff`).

## Prerequisites

1. **Fastmail API token** — read/write Mail scope, since `--apply` moves mail.
   Create at https://app.fastmail.com/settings/security/tokens.
2. **GreenPT API key** (`GREENPT_API_KEY`) from https://greenpt.com plus a
   model id (`GREENPT_MODEL_ID`). Confirm the id against the provider — a plan
   restriction can hide a model your key cannot invoke:
   ```sh
   curl https://api.greenpt.ai/v1/models -H "Authorization: Bearer $GREENPT_API_KEY"
   ```
   A new model also needs an entry in `src/model-pacing.ts`, measured rather
   than guessed (DECISIONS.md).
3. **`PROMPT_BUCKET`** — the S3 bucket holding the live prompt. Created by the
   SAM template; see "MCP server deployment" for bootstrapping `current.json`.
4. **Pushover token + user key** — only for `--apply` without `--no-notify`.
   Token from https://pushover.net/apps/build, user key from your dashboard.
5. **The six mailboxes must already exist**: `Inbox/Triage` (source), `Inbox`,
   `Inbox/Orders`, `Inbox/News`, `Archive/Noise`, `Inbox/Suspicious`. None are
   auto-created; resolution fails fast before any classify call is spent.

## Run

```sh
cp .env.example .env   # fill in the values from Prerequisites
npx tsx triage.ts                       # dry run (default)
npx tsx triage.ts --limit=50            # dry run against up to 50 messages
npx tsx triage.ts --apply               # classify, move, tag, notify
npx tsx triage.ts --apply --no-notify   # classify, move, tag; skip Pushover
```

`--limit` defaults to 20. A dry run prints the classification table plus
planned moves; `--apply` additionally prints actual moves, move failures,
skipped emails (left in `Inbox/Triage`), and notification outcomes.

### Mailbox id overrides (optional)

Each of the six mailboxes is resolved via `Mailbox/query` on every run, and
each has an env var override (see `.env.example`) that skips its lookup. Ids
are stable across runs, so setting all six — as the Lambda deployment does —
removes every lookup round trip.

## Evaluating the classification prompt

```sh
npm run eval          # or: npx tsx eval/run-eval.ts
```

Runs the synthetic fixtures in `eval/golden-set.ts` through `classifyEmail()`,
one per call exactly as production does, against the live S3 prompt (needs
`PROMPT_BUCKET` and S3 read access). Isolated to the classify stage: no JMAP,
no moves, no Pushover. Exits non-zero on any category mismatch.

Not in CI — it costs money and hits a live model. Run it by hand after
drafting a candidate, before `approve_prompt_diff`. It is a fast regression
check, not a substitute for auditing real mail via `get_triage_report`: the
golden set only catches rules someone already wrote down. Add a case whenever
a real mismatch gets fixed.

## Lambda deployment

`template.yaml` (AWS SAM) deploys two functions in one stack: `TriageFunction`
(the pipeline, on an EventBridge schedule) and `McpServerFunction` (the review
server, below). Needs the [SAM
CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
the model id and six mailbox ids from above, and Fastmail/Pushover credentials.

1. **Create the secrets in SSM Parameter Store** (one-time, out of band —
   never in the template or on the deploy command line):
   ```sh
   aws ssm put-parameter --name /jmap-triage/fastmail-token --type SecureString --value "fmu1-..."
   aws ssm put-parameter --name /jmap-triage/pushover-token --type SecureString --value "..."
   aws ssm put-parameter --name /jmap-triage/pushover-user  --type SecureString --value "..."
   aws ssm put-parameter --name /jmap-triage/greenpt-api-key --type SecureString --value "..."
   ```
2. **Build and deploy** with `ScheduleEnabled` left at its default `false`, so
   nothing runs unattended yet:
   ```sh
   sam build
   sam deploy --guided --region eu-central-1
   ```
   `--guided` prompts for the stack name and every parameter (`GreenptModelId`,
   the six mailbox ids, `LambdaWebAdapterLayerArn` — see below) and saves the
   answers to `samconfig.toml` for later plain `sam deploy` runs.
3. **Dry-run the deployed function** before trusting it with real mail:
   ```sh
   aws lambda invoke --function-name <TriageFunctionArn from stack outputs> \
     --payload '{"dryRun": true}' --cli-binary-format raw-in-base64-out response.json
   cat response.json
   ```
   CloudWatch Logs show the same tables the CLI prints. Iterate here, not
   against the live schedule.
4. **Go live**: `sam deploy --guided` again, accepting every saved default
   except `ScheduleEnabled`, which you set to `true`. (A one-off
   `--parameter-overrides` would replace the whole saved parameter set rather
   than patching one key.)

### Monitoring

```sh
aws logs tail /aws/lambda/$(aws cloudformation describe-stacks --region eu-central-1 --stack-name jmap-triage \
  --query "Stacks[0].Outputs[?OutputKey=='TriageFunctionArn'].OutputValue" --output text | awk -F: '{print $NF}') \
  --follow --region eu-central-1
```

Resolves the log group off the stack output rather than hardcoding its random
suffix. Drop `--follow` for a one-shot look (add `--since 1h`); add
`--filter-pattern "ERROR"` for failures only.

## MCP server deployment

`McpServerFunction` deploys `src/mcp-server.ts` — the five-tool review server
(`get_current_prompt`, `get_version_history`, `get_triage_report`,
`evaluate_candidate`, `approve_prompt_diff`) — behind a Function URL, so a
Claude session can review real triage disagreements and change what production
classifies with, without a redeploy. Design: [ARCHITECTURE.md](ARCHITECTURE.md).

> **Auth is off by deliberate choice, not oversight.** Claude.ai's
> custom-connector UI reliably offers only full OAuth 2.0 or no auth for an
> individual account; `static_headers` is beta and gated to Team/Enterprise
> admins, and a token in the connector URL is discouraged by Claude's own docs
> (URLs get logged). So this relies on the Function URL's unguessable subdomain
> alone: **anyone with the URL can call all five tools, including
> `approve_prompt_diff`.** Acceptable for a single-user personal tool. To
> re-enable the bearer check, set `MCP_BEARER_TOKEN_PARAM` back in
> `McpServerFunction`'s environment and redeploy — no code change
> (`mcp-server.ts`'s `bearerConfigured()`). The SSM secret and its read
> permission are left in place for that.

1. **Look up the AWS Lambda Web Adapter layer ARN** for your region and
   architecture — the deploy prompts for it as `LambdaWebAdapterLayerArn`, with
   no default in the template since a pinned version goes stale.
   `eu-central-1`/x86_64 was
   `arn:aws:lambda:eu-central-1:753240598075:layer:LambdaAdapterLayerX86:28` as
   of this deploy. See
   [awslabs/aws-lambda-web-adapter](https://github.com/awslabs/aws-lambda-web-adapter#layer).
2. **Deploy** — same stack as the pipeline. `McpServerFunction`'s build needs
   `make` (`Metadata.BuildMethod: makefile`; see the root `Makefile`):
   ```sh
   sam build
   sam deploy --guided --region eu-central-1
   ```
3. **Bootstrap `current.json`** — nothing seeds it, and `get_current_prompt`
   errors until it exists. Write your initial prompt text directly:
   ```sh
   npx tsx -e "process.stdout.write(JSON.stringify({version: 'v1', prompt: 'your prompt text here'}))" \
     | aws s3 cp - "s3://$(aws cloudformation describe-stacks --region eu-central-1 --stack-name jmap-triage \
         --query "Stacks[0].Outputs[?OutputKey=='PromptStoreBucketName'].OutputValue" --output text)/current.json" \
       --content-type application/json
   ```
4. **Register the custom connector** in Claude's hosted chat interface, pointing
   at the stack's `McpServerFunctionUrl` output plus `/mcp` (e.g.
   `https://<id>.lambda-url.eu-central-1.on.aws/mcp`). No auth header needed.

Redeploying after a code change is just `sam build && sam deploy`.
