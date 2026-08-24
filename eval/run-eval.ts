// Classification eval -- NOT part of the deployed pipeline and NOT run in
// CI. Runs the synthetic fixtures in golden-set.ts through the real
// classifyBatch() against live Bedrock, and reports category/notify
// mismatches against the current prompt.ts. Isolated to the classify stage
// on purpose: no JMAP session, no mailboxes, no moves, no Pushover -- it
// exists to catch a prompt.ts edit that silently breaks a rule the prompt
// already relies on, quickly and without touching Fastmail. See
// golden-set.ts for what these fixtures are (and aren't) a substitute for.
//
// Run: npx tsx eval/run-eval.ts
// Exits non-zero if any category mismatch is found.

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { loadEnvFile, requireBedrockModelId } from "../src/config.js";
import { classifyBatch, type ClassificationOutcome } from "../src/classify.js";
import { getConcurrency, runPaced } from "../src/model-pacing.js";
import { PROMPT_VERSION } from "../prompt.js";
import { GOLDEN_SET } from "./golden-set.js";

// Same region as main.ts's BEDROCK_REGION; kept as its own constant here
// rather than imported, since main.ts doesn't export it (it's meant to stay
// pipeline-internal) and this script has no other reason to import main.ts.
const BEDROCK_REGION = "eu-central-1";

interface ReportRow {
  id: string;
  subject: string;
  expectedCategory: string;
  actualCategory: string;
  categoryOk: boolean;
  expectedNotify?: boolean;
  actualNotify?: boolean;
  notifyOk?: boolean;
  error?: string;
}

function buildRow(c: (typeof GOLDEN_SET)[number], outcome: ClassificationOutcome): ReportRow {
  if ("error" in outcome) {
    return {
      id: c.id,
      subject: c.subject,
      expectedCategory: c.expectedCategory,
      actualCategory: "(error)",
      categoryOk: false,
      expectedNotify: c.expectedNotify,
      error: outcome.error,
    };
  }
  const categoryOk = outcome.category === c.expectedCategory;
  const notifyOk = c.expectedNotify === undefined ? undefined : outcome.notify === c.expectedNotify;
  return {
    id: c.id,
    subject: c.subject,
    expectedCategory: c.expectedCategory,
    actualCategory: outcome.category,
    categoryOk,
    expectedNotify: c.expectedNotify,
    actualNotify: outcome.notify,
    notifyOk,
  };
}

async function main() {
  await loadEnvFile();
  const modelId = requireBedrockModelId();
  const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });
  // Mirrors classify.ts's CLASSIFY_BATCH_SIZE=1 production behavior: emails
  // are sent to the model one at a time, not batched, so this eval reflects
  // what actually gets asked of the model at runtime. Concurrency, pacing
  // and the burst-cap cooldown all come from model-pacing.ts's runPaced().
  console.log(`Evaluating classify.ts against prompt.ts ${PROMPT_VERSION} (model: ${modelId}, concurrency: ${getConcurrency(modelId)})`);
  console.log(`${GOLDEN_SET.length} case(s)\n`);

  // Progress lines below may print out of GOLDEN_SET order when
  // concurrency > 1 -- rows[] itself stays correctly indexed regardless.
  const rows = await runPaced(GOLDEN_SET, modelId, async (c) => {
    const [outcome] = await classifyBatch(bedrock, modelId, [c]);
    return buildRow(c, outcome);
  }, (row, c, i) => {
    const status = row.error ? `ERROR: ${row.error}` : row.categoryOk && row.notifyOk !== false ? "ok" : "MISMATCH";
    console.log(`[${i + 1}/${GOLDEN_SET.length}] ${c.id}... ${status}`);
  });

  const categoryMismatches = rows.filter((r) => !r.categoryOk);
  const notifyMismatches = rows.filter((r) => r.notifyOk === false);

  console.log("\n--- Results ---");
  console.table(
    rows.map((r) => ({
      id: r.id,
      subject: r.subject.slice(0, 40),
      expected: r.expectedCategory,
      actual: r.actualCategory,
      categoryOk: r.categoryOk,
      expectedNotify: r.expectedNotify,
      actualNotify: r.actualNotify,
      notifyOk: r.notifyOk,
    }))
  );

  if (categoryMismatches.length > 0) {
    console.log("\n--- Category mismatches ---");
    for (const r of categoryMismatches) {
      const note = GOLDEN_SET.find((c) => c.id === r.id)?.note ?? "";
      console.log(`  ${r.id}: expected "${r.expectedCategory}", got "${r.actualCategory}"${r.error ? ` (${r.error})` : ""}`);
      console.log(`    rule: ${note}`);
    }
  }

  if (notifyMismatches.length > 0) {
    console.log("\n--- Notify mismatches ---");
    for (const r of notifyMismatches) {
      const note = GOLDEN_SET.find((c) => c.id === r.id)?.note ?? "";
      console.log(`  ${r.id}: expected notify=${r.expectedNotify}, got notify=${r.actualNotify}`);
      console.log(`    rule: ${note}`);
    }
  }

  const gradedNotifyCount = rows.filter((r) => r.expectedNotify !== undefined).length;
  console.log(
    `\n${rows.length - categoryMismatches.length}/${rows.length} category match, ` +
      `${gradedNotifyCount - notifyMismatches.length}/${gradedNotifyCount} notify match`
  );

  if (categoryMismatches.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
