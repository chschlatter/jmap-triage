// Orchestrates the full pipeline: classify -> act (move) -> notify.
// runPipeline() is the reusable pipeline body; main() is the CLI-only shell
// around it (argv, .env, CLI-flavored error messages) -- the Lambda handler
// (src/lambda.ts) calls runPipeline() directly, with its own config
// assembled from SSM/env instead.

import {
  loadEnvFile,
  parseArgs,
  readMailboxOverrides,
  requireFastmailToken,
  requireModelConfig,
  requirePushoverConfig,
  type CliOptions,
  type MailboxOverrides,
  type PushoverConfig,
} from "./config.js";
import { bootstrapSession } from "./jmap-session.js";
import { resolveMailboxes } from "./mailboxes.js";
import { fetchTriageEmails } from "./fetch-emails.js";
import { CLASSIFY_BATCH_SIZE, classifyBatch, type ClassificationOutcome, type ClassifierConfig } from "./classify.js";
import { applyMoves, destinationsFor, planActions } from "./actions.js";
import { sendPushoverNotification } from "./notify.js";
import { getConcurrency, runPaced } from "./model-pacing.js";
import { getCurrentPrompt } from "./current-prompt.js";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface PipelineConfig {
  token: string;
  model: ClassifierConfig;
  pushover: PushoverConfig | null;
  mailboxOverrides: MailboxOverrides;
  options: CliOptions;
  // Live prompt to classify with -- always the S3-fetched current.json
  // (see current-prompt.ts), no bundled local fallback. Required, not
  // optional: there is no offline default (see classify.ts's
  // classifyBatch for why), so every caller -- CLI main() below and
  // lambda.ts alike -- fetches it before building this config.
  prompt: { version: string; text: string };
}

export async function runPipeline(config: PipelineConfig) {
  const { token, model, pushover, mailboxOverrides, options, prompt } = config;

  const session = await bootstrapSession(token);
  const mailboxes = await resolveMailboxes(session, mailboxOverrides);
  const destinations = destinationsFor(mailboxes);

  const emails = await fetchTriageEmails(session, mailboxes.triageId, options.limit);
  if (emails.length === 0) {
    console.log("No messages found in Inbox/Triage.");
    return;
  }

  // --- Classify (provider chosen by `model` -- Bedrock or Mistral, see
  // classify.ts's ClassifierConfig) ---

  // Concurrency and pacing both come from model-pacing.ts's runPaced() --
  // same policy evaluate_candidate's live-mail replay uses, so a model
  // change stays safe in both places automatically.
  const batches = chunk(emails, CLASSIFY_BATCH_SIZE);
  console.log(
    `Classifying ${emails.length} email(s) in ${batches.length} batch(es) via ${model.provider} ` +
      `(concurrency: ${getConcurrency(model.provider, model.modelId)})...`
  );
  const batchResults = await runPaced(
    batches,
    model.provider,
    model.modelId,
    (batch) => classifyBatch(model, batch, prompt.text),
    (_result, batch, i) => console.log(`[batch ${i + 1}/${batches.length}] classified ${batch.length} email(s)`)
  );

  const classificationRows: Array<{ emailId: string; subject: string; from: string; category: string; notify: boolean }> = [];
  const classificationFailures: Array<{ emailId: string; subject: string; error: string }> = [];
  const outcomes: ClassificationOutcome[] = batchResults.flat();

  for (const [batchIndex, batch] of batches.entries()) {
    const emailById = new Map(batch.map((e) => [e.id, e]));
    for (const outcome of batchResults[batchIndex]) {
      const email = emailById.get(outcome.id)!;
      if ("error" in outcome) {
        classificationFailures.push({ emailId: email.id, subject: email.subject, error: outcome.error });
      } else {
        classificationRows.push({
          emailId: outcome.id,
          subject: email.subject,
          from: email.from,
          category: outcome.category,
          notify: outcome.notify,
        });
      }
    }
  }

  console.log("\n--- Triage classification ---");
  console.table(classificationRows);
  if (classificationFailures.length > 0) {
    console.log("\n--- Classification failures (left in Inbox/Triage) ---");
    console.table(classificationFailures);
  }

  // --- Act: plan moves, apply only with --apply ---

  const { planned, skipped } = planActions(emails, outcomes, destinations, prompt.version);

  if (!options.apply) {
    console.log("\n--- Dry run: no writes performed (pass --apply to move mail and notify) ---");
    console.table(
      planned.map((a) => ({
        emailId: a.email.id,
        subject: a.email.subject,
        category: a.category,
        destination: a.destination.path,
        keyword: a.keyword,
        wouldNotify: a.notify,
      }))
    );
    return;
  }

  const moveResults = await applyMoves(session, mailboxes.triageId, planned);

  const movedRows: Array<{ emailId: string; subject: string; category: string; destination: string; keyword: string }> = [];
  const moveFailures: Array<{ emailId: string; subject: string; error: string }> = [];
  for (const result of moveResults) {
    if (result.ok) {
      movedRows.push({
        emailId: result.action.email.id,
        subject: result.action.email.subject,
        category: result.action.category,
        destination: result.action.destination.path,
        keyword: result.action.keyword,
      });
    } else {
      moveFailures.push({
        emailId: result.action.email.id,
        subject: result.action.email.subject,
        error: result.error ?? "unknown error",
      });
    }
  }

  console.log("\n--- Moves ---");
  console.table(movedRows);
  if (moveFailures.length > 0) {
    console.log("\n--- Move failures (left in Inbox/Triage) ---");
    console.table(moveFailures);
  }
  if (skipped.length > 0) {
    console.log("\n--- Skipped, not moved (classification failed or unknown category, left in Inbox/Triage) ---");
    console.table(skipped.map((s) => ({ emailId: s.email.id, subject: s.email.subject, reason: s.reason })));
  }

  // --- Notify: only for successfully-moved, notification-eligible emails ---

  const notificationRows: Array<{ emailId: string; subject: string; category: string; sent: boolean; error?: string }> = [];
  for (const result of moveResults) {
    if (!result.ok) continue;
    const { action } = result;
    if (!action.notify) continue;

    if (!pushover) {
      notificationRows.push({
        emailId: action.email.id,
        subject: action.email.subject,
        category: action.category,
        sent: false,
        error: "notifications disabled",
      });
      continue;
    }

    try {
      await sendPushoverNotification(pushover, action.email, action.destination);
      notificationRows.push({
        emailId: action.email.id,
        subject: action.email.subject,
        category: action.category,
        sent: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notificationRows.push({
        emailId: action.email.id,
        subject: action.email.subject,
        category: action.category,
        sent: false,
        error: message,
      });
    }
  }

  if (notificationRows.length > 0) {
    console.log("\n--- Notifications ---");
    console.table(notificationRows);
  }
}

// CLI-only shell: argv parsing, .env loading, CLI-flavored required-env-var
// error messages. Kept separate from runPipeline() (above) so the Lambda
// handler (src/lambda.ts) can call runPipeline() directly with its own
// config, without inheriting argv/.env assumptions that don't apply there.
export async function main() {
  await loadEnvFile();

  const options = parseArgs(process.argv.slice(2));
  const token = requireFastmailToken();
  const model = requireModelConfig();
  const pushover: PushoverConfig | null = options.notify ? requirePushoverConfig() : null;
  // No bundled local prompt to fall back to -- see classify.ts's
  // classifyBatch comment. CLI runs now need PROMPT_BUCKET set (same as
  // jmap-triage-mcp already required) and S3 read access, same AWS
  // credential chain the Bedrock path already needs.
  const current = await getCurrentPrompt();

  await runPipeline({
    token,
    model,
    pushover,
    mailboxOverrides: readMailboxOverrides(),
    options,
    prompt: { version: current.version, text: current.prompt },
  });
}
