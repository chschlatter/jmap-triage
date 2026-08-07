# triage.ts — Lambda Deployment Design (v1 proposal)

Status: code + infra implemented (`main.ts` refactor, `src/lambda.ts`,
`template.yaml`; `sam build` passes); not yet deployed. Last updated
2026-08-02.

Builds on `triage.ts-DESIGN-v5-2026-08-02.md` (current implementation: v5,
classify -> act -> notify, run manually via `npx tsx triage.ts --apply`).
Both v4 §8 and v5 §3.2 named an AWS Lambda cron deployment as the intended
end state; this doc is that plan. It covers only deployment — packaging,
infrastructure, secrets, scheduling, and the small code changes needed to
run outside a terminal. It does not change classify/act/notify logic.

## 1. Purpose

Today, triage only runs when someone is at a terminal to run it. The goal is
a Lambda function on an EventBridge schedule (e.g. every 5 minutes) that
runs `--apply` unattended, so `Inbox/Triage` drains continuously instead of
accumulating between manual runs.

## 2. What has to change in the code

Everything in `src/` is deployment-agnostic already (plain `fetch`, no
filesystem access except `loadEnvFile`, no CLI-only assumptions baked into
the pipeline itself). Two things stand in the way of calling it from a
Lambda handler as-is:

1. **`main()` mixes CLI concerns with pipeline logic.** It calls
   `loadEnvFile()` (reads `.env` off disk — harmless no-op in Lambda since
   no `.env` is packaged, but pointless), calls `parseArgs(process.argv)`
   (no argv in Lambda), and its `requireFastmailToken()` /
   `requirePushoverConfig()` error messages tell the reader to run
   `npx tsx triage.ts` — misleading from a Lambda stack trace in CloudWatch.
2. **Secrets need to come from somewhere other than env vars in plaintext.**
   `FASTMAIL_TOKEN`, `PUSHOVER_TOKEN`, `PUSHOVER_USER` are read directly from
   `process.env` in `config.ts`. That's fine for a local `.env` file; it's
   not fine for a Lambda's `Environment.Variables`, which are visible in
   plaintext to anyone with `lambda:GetFunctionConfiguration` on the
   function and show up in CloudFormation change sets / drift diffs.

Proposed change — split `main.ts`'s `main()` into a CLI-only shell and a
reusable pipeline function:

```ts
// main.ts
export interface PipelineConfig {
  token: string;
  modelId: string;
  pushover: PushoverConfig | null;
  mailboxOverrides: MailboxOverrides;
  options: CliOptions; // { limit, apply, notify }
}

export async function runPipeline(config: PipelineConfig) { /* today's main() body, unchanged */ }

export async function main() {
  await loadEnvFile();
  const options = parseArgs(process.argv.slice(2));
  await runPipeline({
    token: requireFastmailToken(),
    modelId: requireBedrockModelId(),
    pushover: options.notify ? requirePushoverConfig() : null,
    mailboxOverrides: readMailboxOverrides(),
    options,
  });
}
```

`triage.ts` (the CLI entrypoint) is untouched — it still calls `main()`.
A new `src/lambda.ts` becomes the second caller of `runPipeline()`, assembling
`PipelineConfig` from Lambda's own config sources (§3) instead of argv/`.env`.

This is the only source change this proposal requires. Nothing about
classify/act/notify/mailbox resolution changes.

## 3. Secrets and configuration

| Value | Where it lives | Why |
|---|---|---|
| `FASTMAIL_TOKEN` | SSM Parameter Store, `SecureString` | secret |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | SSM Parameter Store, `SecureString` | secret |
| `BEDROCK_MODEL_ID` | Lambda env var | not secret, changes rarely |
| `TRIAGE_MAILBOX_ID` / `INBOX_MAILBOX_ID` / `INBOX_NEWS_MAILBOX_ID` / `ARCHIVE_NOISE_MAILBOX_ID` | Lambda env var | not secret, stable ids — this is exactly what these overrides were already built for (README's "Mailbox id overrides" section, `config.ts`'s `readMailboxOverrides`); setting all four means the Lambda never calls `Mailbox/query` |
| AWS credentials for Bedrock | Lambda execution role (implicit) | never touches `.env` today either — standard SDK credential chain, in Lambda that's the role |

Proposed parameter names: `/jmap-triage/fastmail-token`,
`/jmap-triage/pushover-token`, `/jmap-triage/pushover-user`. Created once,
out of band (`aws ssm put-parameter --type SecureString`), **not** by the
SAM template — a value never belongs in a CloudFormation parameter or the
deploy command line, since both land in plaintext in stack history / shell
history. The template only references parameter *names*.

`lambda.ts` fetches all three by name at invocation start via
`@aws-sdk/client-ssm`'s `GetParameters` (`WithDecryption: true`), cached in a
module-level variable so a warm container only fetches once. Costs one SSM
call per cold start, not per invocation.

Alternative considered: bake secrets into the Lambda's env vars via a
CloudFormation dynamic reference (`{{resolve:ssm-secure:...}}`). Simpler —
no runtime SSM call, no caching logic — but the resolved value sits in
`lambda:GetFunctionConfiguration` output in plaintext, visible to anyone
with read access to the function, and every rotation needs a redeploy.
Runtime fetch avoids both. Given this is a personal mailbox tool, either is
defensible; **runtime fetch is the recommendation** since it's a small
amount of extra code for a real reduction in blast radius if the AWS
account itself is ever compromised.

## 4. Packaging

Use SAM's native esbuild support rather than a hand-rolled build step —
`sam build` bundles straight from TypeScript source when the function's
`Metadata` says so, no separate `tsc`/`esbuild` invocation to maintain:

```yaml
TriageFunction:
  Type: AWS::Serverless::Function
  Metadata:
    BuildMethod: esbuild
    BuildProperties:
      Minify: true
      Target: es2022
      Format: esm
      EntryPoints: ["src/lambda.ts"]
```

`esbuild` becomes a devDependency. `@aws-sdk/client-bedrock-runtime` and
`@aws-sdk/client-ssm` must be bundled (not marked external) — Lambda's
Node 20.x runtime does not guarantee either package is preinstalled the way
some `aws-sdk` v2 globals are, and pinning our own version avoids a runtime
upgrade silently changing Bedrock request/response shapes underneath the
retry logic in `classify.ts`.

Runtime: `nodejs24.x`. Handler: `src/lambda.handler`.

## 5. Infrastructure (SAM template)

Implemented in `template.yaml` at the repo root — see that file rather than
a snapshot here, which would drift. Three deviations from the sketch this
section originally proposed, discovered while getting `sam build` to
actually pass:

- **`Format: cjs`, not `esm`.** esbuild's ESM output wraps CJS-only
  dependency code (some of `@aws-sdk/client-bedrock-runtime`'s internals)
  in a `require()` shim that throws `Dynamic require of "node:https" is not
  supported` at runtime — a known esbuild/Node-ESM interop gap. CJS output
  sidesteps it entirely; the shipped bundle has no `package.json`, so
  Lambda's Node runtime treats a plain `.js` file as CommonJS regardless of
  this *source* repo's own `"type": "module"`.
- **Direct SSM ARNs, not the `SSMParameterReadPolicy` policy template.**
  That policy template builds
  `arn:...:parameter/${ParameterName}` — passing a parameter name that
  already starts with `/` (as ours do, e.g. `/jmap-triage/fastmail-token`)
  produces a double slash and a non-matching ARN. `template.yaml` instead
  builds each ARN directly via `!Sub arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${FastmailTokenParam}`
  (parameter name's leading `/` supplies the separator).
- **`ScheduleEnabled` parameter, default `"false"`.** §9's sequencing
  (validate with a dry-run invoke *before* the schedule goes live) doesn't
  hold if the schedule is hardcoded `Enabled: true` — the first `sam
  deploy` would start firing real `--apply` runs every 5 minutes before
  anyone confirmed the deployment works. Redeploy with
  `ScheduleEnabled=true` once the dry run (§8) passes.

No S3 bucket, no DynamoDB table, no VPC. The pipeline is stateless between
runs by construction — every processed email leaves `Inbox/Triage`, so
there's nothing to persist and nothing a Lambda-specific cold start needs to
rehydrate. Lambda's default (non-VPC) networking already has internet
egress for both the Fastmail JMAP API and the Pushover API.

**Region**: the Bedrock call is hardcoded to `eu-central-1` in `main.ts`
regardless of where the Lambda itself runs. Recommend deploying the stack
in `eu-central-1` too, to avoid a cross-region hop on every invocation and
keep this consistent with the model-availability prerequisite already
documented in the README. Worth confirming this matches where you'd want
other personal AWS resources to live, if this becomes more than a
single-function stack.

## 6. Concurrency and retry safety

Two invocations racing on `Inbox/Triage` — one fetches an email the other
hasn't moved yet — would only be possible if two invocations overlap.
`ReservedConcurrentExecutions: 1` was meant to rule that out outright (a
second scheduled invocation while the first is still running gets
throttled and queued by Lambda, not run concurrently), but the deploying
AWS account's Lambda concurrency limit in `eu-central-1` is only 10 (`aws
lambda get-account-settings`), and AWS rejects any
`ReservedConcurrentExecutions` that would drop the account's *unreserved*
concurrency below its own floor of 10 — so reserving even 1 fails at
`CREATE_FAILED`. `template.yaml` ships without it for now. Practical impact
is small: overlap requires a run to still be in flight when the *next*
5-minute-scheduled invocation fires, i.e. a run slow enough to blow past
~5 minutes (Bedrock throttling backoff, mostly) — at worst a duplicate
Pushover notification for whichever email both runs raced on, not
corrupted mailbox state (§ below). Revisit if the account's concurrency
quota is ever raised, or with a lighter-weight lock if not.

Failure recovery is naturally idempotent, which simplifies retry policy:
a moved+tagged email is gone from `Inbox/Triage`, so it's never re-fetched
by definition, and Bedrock/Pushover call failures already surface as
per-email skips/failures that leave the message in place for the *next*
run rather than corrupting state (this is existing v4/v5 behavior, not
Lambda-specific — see `actions.ts`'s `planActions`/`applyMoves` and
`main.ts`'s failure tables). That means Lambda's default async-invoke retry
(2 automatic retries on error) is safe to leave at its default — a retried
run just reprocesses whatever didn't get moved, nothing double-processes.

`Timeout: 240` (4 minutes, under the 5-minute schedule period) is deliberate:
if a run hangs, it self-terminates before the *next* scheduled invocation
would otherwise queue up behind it.

## 7. Observability

CloudWatch Logs captures `console.log`/`console.table` output as-is —
sufficient for v1, no structured-logging change needed. Recommend one
`AWS::CloudWatch::Alarm` on the function's `Errors` metric (>0 over a few
periods) as the only added resource beyond the function itself; routing it
to Pushover or email is a follow-up, not blocking this deploy.

## 8. Manual dry-run against the deployed function

`lambda.ts` should read an optional `DRY_RUN` env var (or event field) and
map it to `options.apply = false`, so `aws lambda invoke` with
`--payload '{"dryRun": true}'` can validate a deployment without moving
mail, the same safety net `--apply`'s absence gives the CLI today. Default
(scheduled) invocations have no payload, so they default to
`apply: true, notify: true` — this *is* the production path, unlike the
CLI's default dry run.

## 9. Sequencing

1. `main.ts` refactor (§2) — no behavior change, verify via existing manual
   `npx tsx triage.ts` runs.
2. `src/lambda.ts` + SSM parameter creation (§3).
3. `template.yaml` + `sam build` / `sam deploy --guided` for the first
   deploy (captures the `eu-central-1` sam-cli config for later
   `sam deploy` without `--guided`).
4. One `aws lambda invoke` dry run (§8) against real `Inbox/Triage` state
   before enabling the schedule.
5. Enable the EventBridge schedule.

## 10. Decisions

- **Bedrock model ARN**: staying with the `foundation-model/*` wildcard in
  §5 for this deploy. Narrowing to the specific model/inference-profile ARN
  is deferred, not blocking — revisit once that's a priority.
- **Schedule cadence**: `rate(5 minutes)` confirmed, matches v4 §8's original
  suggestion.
- **Alarm routing** (§7): deferred — no alarm resource in this deploy,
  revisit logging/alarming later.
