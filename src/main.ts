// Orchestrates the full v5 pipeline: classify (v4, unchanged) -> act (move)
// -> notify. See triage.ts-DESIGN-v5-2026-08-02.md for the full picture;
// this is the body of v4's triage.ts main(), split out per §4 and extended
// with the two new stages. runPipeline() vs. main(): see
// triage.ts-DEPLOY-v1-2026-08-02.md §2 -- main() is the CLI-only shell
// (argv, .env, CLI-flavored error messages); runPipeline() is the reusable
// body the Lambda handler (src/lambda.ts) also calls, with its own config
// assembled from SSM/env instead.

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  loadEnvFile,
  parseArgs,
  readMailboxOverrides,
  requireBedrockModelId,
  requireFastmailToken,
  requirePushoverConfig,
  type CliOptions,
  type MailboxOverrides,
  type PushoverConfig,
} from "./config.js";
import { bootstrapSession } from "./jmap-session.js";
import { resolveMailboxes } from "./mailboxes.js";
import { fetchTriageEmails } from "./fetch-emails.js";
import { CLASSIFY_BATCH_SIZE, classifyBatch, type ClassificationOutcome } from "./classify.js";
import { applyMoves, destinationsFor, planActions } from "./actions.js";
import { sendPushoverNotification } from "./notify.js";

const BEDROCK_REGION = "eu-central-1";
const DELAY_BETWEEN_BATCHES_MS = 300;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PipelineConfig {
  token: string;
  modelId: string;
  pushover: PushoverConfig | null;
  mailboxOverrides: MailboxOverrides;
  options: CliOptions;
}

export async function runPipeline(config: PipelineConfig) {
  const { token, modelId, pushover, mailboxOverrides, options } = config;

  const session = await bootstrapSession(token);
  const mailboxes = await resolveMailboxes(session, mailboxOverrides);
  const destinations = destinationsFor(mailboxes);

  const emails = await fetchTriageEmails(session, mailboxes.triageId, options.limit);
  if (emails.length === 0) {
    console.log("No messages found in Inbox/Triage.");
    return;
  }

  // --- Classify (v4, unchanged) ---

  const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

  const classificationRows: Array<{ emailId: string; subject: string; from: string; category: string; notify: boolean }> = [];
  const classificationFailures: Array<{ emailId: string; subject: string; error: string }> = [];
  const outcomes: ClassificationOutcome[] = [];

  const batches = chunk(emails, CLASSIFY_BATCH_SIZE);
  for (const [batchIndex, batch] of batches.entries()) {
    console.log(`[batch ${batchIndex + 1}/${batches.length}] Classifying ${batch.length} email(s)...`);
    const batchOutcomes = await classifyBatch(bedrock, modelId, batch);
    outcomes.push(...batchOutcomes);

    const emailById = new Map(batch.map((e) => [e.id, e]));
    for (const outcome of batchOutcomes) {
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

    if (batchIndex < batches.length - 1) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log("\n--- Triage classification ---");
  console.table(classificationRows);
  if (classificationFailures.length > 0) {
    console.log("\n--- Classification failures (left in Inbox/Triage) ---");
    console.table(classificationFailures);
  }

  // --- Act: plan moves, apply only with --apply ---

  const { planned, skipped } = planActions(emails, outcomes, destinations);

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
  const modelId = requireBedrockModelId();
  const pushover: PushoverConfig | null = options.notify ? requirePushoverConfig() : null;

  await runPipeline({
    token,
    modelId,
    pushover,
    mailboxOverrides: readMailboxOverrides(),
    options,
  });
}
