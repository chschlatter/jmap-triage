// Orchestrates the full pipeline: classify -> act (move) -> notify.
// runPipeline() is the reusable pipeline body; main() is the CLI-only shell
// around it (argv, .env) -- the Lambda handler (src/lambda.ts) calls
// runPipeline() directly, with its own config assembled from SSM/env instead.

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

// Every run summary in here is a titled table that's worth printing only if
// it has rows -- an empty "Move failures" section is noise, not information.
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
  // Live prompt to classify with -- always the S3-fetched current.json (see
  // current-prompt.ts), no bundled local fallback. Required, not optional:
  // there is no offline default, so every caller -- CLI main() below and
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

  // --- Classify (one call per email; concurrency and pacing from
  // model-pacing.ts's runPaced() -- the same policy evaluate_candidate's
  // live-mail replay uses, so a model change stays safe in both places) ---

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

// CLI-only shell: argv parsing, .env loading. Kept separate from
// runPipeline() (above) so the Lambda handler can call runPipeline() directly
// with its own config, without inheriting argv/.env assumptions.
export async function main() {
  await loadEnvFile();

  const options = parseArgs(process.argv.slice(2));
  const token = requireFastmailToken();
  const model = requireModelConfig();
  const pushover: PushoverConfig | null = options.notify ? requirePushoverConfig() : null;
  // No bundled local prompt to fall back to -- CLI runs need PROMPT_BUCKET
  // set (same as jmap-triage-mcp already required) and S3 read access.
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
