// Orchestrates the pipeline: classify -> act (move) -> notify. runPipeline()
// is the reusable body; main() is the CLI-only shell (argv, .env) around it.
// lambda.ts calls runPipeline() directly with its own config.

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
import { classifyEmail, type ClassifierConfig } from "./classify.js";
import { applyMoves, destinationsFor, planActions } from "./actions.js";
import { sendPushoverNotification } from "./notify.js";
import { getConcurrency, runPaced } from "./model-pacing.js";
import { getCurrentPrompt } from "./current-prompt.js";

// An empty "Move failures" section is noise, not information.
function printTable(title: string, rows: object[]) {
  if (rows.length === 0) return;
  console.log(`\n--- ${title} ---`);
  console.table(rows);
}

export interface PipelineConfig {
  token: string;
  model: ClassifierConfig;
  pushover: PushoverConfig | null;
  mailboxOverrides: MailboxOverrides;
  options: CliOptions;
  // The S3-fetched current.json. Required, not optional -- there is no
  // offline default, so every caller fetches it before building this config.
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

  // --- Classify: one call per email, paced by runPaced() -- the same policy
  // evaluate_candidate's replay uses, so a model change stays safe in both.

  console.log(`Classifying ${emails.length} email(s) via GreenPT ${model.modelId} (concurrency: ${getConcurrency()})...`);
  const outcomes = await runPaced(
    emails,
    model.modelId,
    (email) => classifyEmail(model, email, prompt.text),
    (_outcome, _email, i) => console.log(`[${i + 1}/${emails.length}] classified`)
  );

  const emailById = new Map(emails.map((e) => [e.id, e]));
  printTable(
    "Triage classification",
    outcomes.flatMap((o) =>
      "error" in o ? [] : [{ emailId: o.id, subject: emailById.get(o.id)!.subject, from: emailById.get(o.id)!.from, category: o.category, notify: o.notify }]
    )
  );
  printTable(
    "Classification failures (left in Inbox/Triage)",
    outcomes.flatMap((o) => ("error" in o ? [{ emailId: o.id, subject: emailById.get(o.id)!.subject, error: o.error }] : []))
  );

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

  printTable(
    "Moves",
    moveResults.flatMap((r) =>
      r.ok
        ? [
            {
              emailId: r.action.email.id,
              subject: r.action.email.subject,
              category: r.action.category,
              destination: r.action.destination.path,
              keyword: r.action.keyword,
            },
          ]
        : []
    )
  );
  printTable(
    "Move failures (left in Inbox/Triage)",
    moveResults.flatMap((r) =>
      r.ok ? [] : [{ emailId: r.action.email.id, subject: r.action.email.subject, error: r.error ?? "unknown error" }]
    )
  );
  printTable(
    "Skipped, not moved (classification failed or unknown category, left in Inbox/Triage)",
    skipped.map((s) => ({ emailId: s.email.id, subject: s.email.subject, reason: s.reason }))
  );

  // --- Notify: only for successfully-moved, notification-eligible emails ---

  const notificationRows: Array<{ emailId: string; subject: string; category: string; sent: boolean; error?: string }> = [];
  for (const result of moveResults) {
    if (!result.ok || !result.action.notify) continue;
    const { email, category, destination } = result.action;
    const row = { emailId: email.id, subject: email.subject, category };

    if (!pushover) {
      notificationRows.push({ ...row, sent: false, error: "notifications disabled" });
      continue;
    }
    try {
      await sendPushoverNotification(pushover, email, destination);
      notificationRows.push({ ...row, sent: true });
    } catch (err) {
      notificationRows.push({ ...row, sent: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  printTable("Notifications", notificationRows);
}

// CLI-only shell: argv, .env. Separate from runPipeline() so the Lambda
// handler doesn't inherit argv/.env assumptions.
export async function main() {
  await loadEnvFile();

  const options = parseArgs(process.argv.slice(2));
  const token = requireFastmailToken();
  const model = requireModelConfig();
  const pushover: PushoverConfig | null = options.notify ? requirePushoverConfig() : null;
  // No local fallback prompt, so a CLI run needs PROMPT_BUCKET and S3 reads.
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
