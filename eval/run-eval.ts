// Classification eval -- NOT part of the deployed pipeline and NOT run in
// CI. Runs the synthetic fixtures in golden-set.ts through the real
// classifyEmail() and reports category/notify mismatches against the
// CURRENTLY LIVE prompt (S3's current.json, fetched via getCurrentPrompt() --
// there is no bundled local prompt to test against instead, see
// DECISIONS.md). Isolated to the classify stage on purpose: no
// JMAP session, no mailboxes, no moves, no Pushover -- it exists to catch
// a prompt approval that silently breaks a rule the prompt already relies
// on, quickly and without touching Fastmail. See golden-set.ts for what
// these fixtures are (and aren't) a substitute for.
//
// Run: npx tsx eval/run-eval.ts
// Requires PROMPT_BUCKET set (S3 read access) -- same as jmap-triage-mcp.
// Exits non-zero if any category mismatch is found.

import { loadEnvFile, requireModelConfig } from "../src/config.js";
import { classifyEmail, type ClassificationOutcome } from "../src/classify.js";
import { getConcurrency, runPaced } from "../src/model-pacing.js";
import { getCurrentPrompt } from "../src/current-prompt.js";
import { GOLDEN_SET } from "./golden-set.js";

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
  const model = requireModelConfig();
  const current = await getCurrentPrompt();
  // Concurrency, pacing and the burst-cap cooldown all come from
  // model-pacing.ts's runPaced(), same as production.
  console.log(
    `Evaluating classify.ts against live prompt ${current.version} ` +
      `(model: ${model.modelId}, concurrency: ${getConcurrency()})`
  );
  console.log(`${GOLDEN_SET.length} case(s)\n`);

  // Progress lines below may print out of GOLDEN_SET order when
  // concurrency > 1 -- rows[] itself stays correctly indexed regardless.
  const rows = await runPaced(GOLDEN_SET, model.modelId, async (c) => {
    return buildRow(c, await classifyEmail(model, c, current.prompt));
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
