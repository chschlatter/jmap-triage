// Classification eval -- not deployed, not in CI. Runs golden-set.ts's
// synthetic fixtures through the real classifyEmail() against the currently
// live S3 prompt, and reports category/notify mismatches. Isolated to the
// classify stage on purpose (no JMAP, no moves, no Pushover): it exists to
// catch a prompt approval that silently breaks a rule the prompt already
// relies on, without touching Fastmail. See golden-set.ts for what these
// fixtures are and aren't a substitute for.
//
// Run: npx tsx eval/run-eval.ts -- needs PROMPT_BUCKET and S3 read access.
// Exits non-zero on any category mismatch.

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
  // Concurrency, pacing and burst cooldown all via runPaced(), as production.
  console.log(
    `Evaluating classify.ts against live prompt ${current.version} ` +
      `(model: ${model.modelId}, concurrency: ${getConcurrency()})`
  );
  console.log(`${GOLDEN_SET.length} case(s)\n`);

  // Progress lines print out of order under concurrency > 1; rows[] doesn't.
  const rows = await runPaced(GOLDEN_SET, model.modelId, async (c) => {
    return buildRow(c, await classifyEmail(model, c, current.prompt));
  }, (row, c, i) => {
    const status = row.error ? `ERROR: ${row.error}` : row.categoryOk && row.notifyOk !== false ? "ok" : "MISMATCH";
    console.log(`[${i + 1}/${GOLDEN_SET.length}] ${c.id}... ${status}`);
  });

  // A failed API call is not a wrong answer. Scoring it as a category
  // mismatch (and, because notifyOk stays undefined on an error row, leaving
  // notify untouched) makes a provider outage look exactly like a prompt
  // regression -- which it did once, on a 395s run that scored 30/36 while
  // notify stayed normal. Errors are counted and reported on their own.
  const errored = rows.filter((r) => r.error);
  const categoryMismatches = rows.filter((r) => !r.categoryOk && !r.error);
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
      console.log(`  ${r.id}: expected "${r.expectedCategory}", got "${r.actualCategory}"`);
      console.log(`    rule: ${note}`);
    }
  }

  if (errored.length > 0) {
    console.log("\n--- Errors (not scored) ---");
    for (const r of errored) {
      console.log(`  ${r.id}: ${r.error}`);
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

  const gradedCount = rows.length - errored.length;
  const gradedNotifyCount = rows.filter((r) => r.expectedNotify !== undefined && !r.error).length;
  console.log(
    `\n${gradedCount - categoryMismatches.length}/${gradedCount} category match, ` +
      `${gradedNotifyCount - notifyMismatches.length}/${gradedNotifyCount} notify match` +
      (errored.length > 0 ? `, ${errored.length} error(s) not scored -- re-run before reading this as a regression` : "")
  );

  if (categoryMismatches.length > 0 || errored.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
