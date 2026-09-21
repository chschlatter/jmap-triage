// evaluate_candidate -- a static gate, then, only if it passes, a replay
// against a corpus derived live on every call (nothing is persisted; see
// ARCHITECTURE.md for why). Gate and replay are one tool rather than two
// because the gate always has to run first anyway -- merging moves that
// sequencing rule out of the caller's head and into this contract.

import { requireFastmailToken, requireModelConfig } from "./config.js";
import { getCurrentPrompt } from "./current-prompt.js";
import { getVersionHistory } from "./history.js";
import { classifyEmail, type ClassifierConfig } from "./classify.js";
import { judgePhishing } from "./phish.js";
import { runPaced } from "./model-pacing.js";
import { fetchEmailsByIds, type TriageEmail } from "./fetch-emails.js";
import { bootstrapSession } from "./jmap-session.js";
import { scanKeywordState, type KeywordMatch, type KeywordMismatch } from "./keyword-scan.js";
import { MAILBOX_SPECS, categoriesForStage } from "./mailboxes.js";
import { CLEAN_VERDICT, DEFAULT_STAGE, PHISHING_CATEGORY, stageSpec, type StageKey } from "./stages.js";

// Sized to leave margin under Claude Desktop's hard, non-configurable 240s
// timeout on remote MCP tool calls as the mailbox grows. Past fixes are
// folded in on top of this cap, uncapped -- they matter more.
export const COUNTERWEIGHT_PER_CATEGORY = 6;
// Larger, because the cap above exists to keep a *five-category sweep* under
// the 240s budget -- the cost was always "N x 5", never "N".
const COUNTERWEIGHT_SINGLE_CATEGORY = 20;

// The trailing instruction the live prompt ends with. Dropping or rewording
// it breaks classify.ts's parse contract for every email, not just a
// misclassified one -- worth gating before spending a classify call.
const JSON_REPLY_INSTRUCTION = /reply with only a json array/i;

// The CATEGORY section enumerates categories as top-level bullets starting
// with a quoted lowercase name and a colon (`- "orders": ...`). A structural
// check on that convention, not a prose parser: a candidate that renames a
// category or changes the formatting should fail and get a human look.
const CATEGORY_BULLET = /^-\s*"([a-z]+)":/gm;

// Round 1 has no CATEGORY section -- it ends with a verdict union instead, so
// its vocabulary is read off the quoted alternatives in that closing line.
const VERDICT_LITERAL = /"verdict"\s*:\s*((?:"[a-z]+"\s*\|?\s*)+)/;

function extractCategoryNames(promptText: string): Set<string> {
  const names = new Set<string>();
  for (const match of promptText.matchAll(CATEGORY_BULLET)) {
    names.add(match[1]);
  }
  return names;
}

function extractVerdictNames(promptText: string): Set<string> {
  const names = new Set<string>();
  const block = promptText.match(VERDICT_LITERAL)?.[1] ?? "";
  for (const match of block.matchAll(/"([a-z]+)"/g)) names.add(match[1]);
  return names;
}

function extractVocabulary(promptText: string, stage: StageKey): Set<string> {
  return stage === "phish" ? extractVerdictNames(promptText) : extractCategoryNames(promptText);
}

// Round 2's vocabulary is the folder map filtered to its own stage, so
// removing `suspicious` from round 2 is a MAILBOX_SPECS edit, not one here.
function expectedVocabulary(stage: StageKey): Set<string> {
  const spec = stageSpec(stage);
  return new Set(spec.vocabulary ? [...spec.vocabulary] : categoriesForStage(stage));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export interface CorrectionResult {
  id: string;
  subject: string;
  expectedCategory: string;
  actualCategory: string;
  // "fixed"/"unfixed" are an open correction's outcome, "regressed" a broken
  // counterweight row. "error" covers both: a classify call that failed, kept
  // rather than dropped so it can't read as "still wrong"/"still held".
  status: "fixed" | "unfixed" | "regressed" | "error";
  expectedNotify?: boolean;
  actualNotify?: boolean;
  error?: string;
}

export interface EvaluateCandidateResult {
  gate: { pass: boolean; reasons: string[]; candidateCategories: string[] };
  fixes: CorrectionResult[];
  // Every open correction's outcome, not just the ones that flipped -- else
  // a candidate that didn't help looks like one that couldn't be evaluated.
  corrections: CorrectionResult[];
  regressions: CorrectionResult[];
}

async function runGate(
  candidate: { version: string; prompt: string },
  category?: string,
  stage: StageKey = DEFAULT_STAGE
): Promise<{ pass: boolean; reasons: string[]; candidateCategories: string[] }> {
  const reasons: string[] = [];

  const current = await getCurrentPrompt(stage);
  if (candidate.version === current.version) {
    reasons.push(`candidate version "${candidate.version}" is the same as the live version -- bump it`);
  }
  const { versionPrefix } = stageSpec(stage);
  if (!candidate.version.startsWith(versionPrefix)) {
    reasons.push(`candidate version "${candidate.version}" does not start with "${versionPrefix}" -- each stage has its own version line`);
  }

  if (!JSON_REPLY_INSTRUCTION.test(candidate.prompt)) {
    reasons.push('trailing "Reply with ONLY a JSON array" instruction is missing or reworded');
  }

  const candidateCategories = extractVocabulary(candidate.prompt, stage);
  const expected = expectedVocabulary(stage);
  // Against the FULL vocabulary even when `category` scopes the replay: a
  // candidate has to support every category either way.
  if (!setsEqual(candidateCategories, expected)) {
    reasons.push(
      `${stage} vocabulary mismatch -- candidate has {${[...candidateCategories].sort().join(", ")}}, ` +
        `expected {${[...expected].sort().join(", ")}}`
    );
  }

  if (category !== undefined && !expected.has(category)) {
    reasons.push(`unknown category "${category}" -- expected one of {${[...expected].sort().join(", ")}}`);
  }

  // Echoed pass or fail, so a caller can see what the CATEGORY section parsed
  // as without reverse-engineering it from the mismatch reason text.
  return { pass: reasons.length === 0, reasons, candidateCategories: [...candidateCategories].sort() };
}

// The one thing a live JMAP scan can't tell: which mismatches a prior
// approval already fixed. Old mail is never re-stamped, so scanKeywordState()
// lists a message as a mismatch forever -- approve_prompt_diff records each
// approval's replay.fixes precisely so it can be read back here. Most recent
// record wins if a message appears in several.
async function buildFixesMap(stage: StageKey): Promise<Map<string, string>> {
  const history = await getVersionHistory({ stage }); // most-recent-first
  const map = new Map<string, string>();
  for (const record of [...history].reverse()) {
    for (const fix of record.replay?.fixes ?? []) {
      map.set(fix.id, fix.expectedCategory);
    }
  }
  return map;
}

// The ground truth a mismatch's current folder implies -- a message in
// Inbox/Orders is "orders" whatever it was predicted as. Null for a deleted
// message, or one trashed outside the "suspicious" exception
// scanKeywordState() special-cases; a null can never count as "fixed", the
// right default when there's nothing to verify against.
function actualCategoryFromMismatch(mismatch: KeywordMismatch): string | null {
  const paths = mismatch.actualFolder.split(", ");
  for (const spec of MAILBOX_SPECS) {
    if (spec.category && paths.includes(spec.path.join("/"))) return spec.category;
  }
  return null;
}

export interface CounterweightRow {
  id: string;
  expectedCategory: string;
}

// Sorted, not sampled, so re-evaluating the same candidate mid-round always
// compares against an identical baseline. Past fixes are folded in past the
// cap -- each is the specific case a prior fix was needed for, the
// highest-value guard there is. The cap itself is the caller's choice.
export function buildCounterweight(
  matches: KeywordMatch[],
  fixesMap: Map<string, string>,
  capPerCategory: number
): CounterweightRow[] {
  const byCategory = new Map<string, KeywordMatch[]>();
  for (const m of matches) {
    const list = byCategory.get(m.category);
    if (list) list.push(m);
    else byCategory.set(m.category, [m]);
  }

  const rows: CounterweightRow[] = [];
  const seen = new Set<string>();
  for (const [category, list] of byCategory) {
    const sorted = [...list].sort((a, b) => a.messageId.localeCompare(b.messageId));
    for (const m of sorted.slice(0, capPerCategory)) {
      rows.push({ id: m.messageId, expectedCategory: category });
      seen.add(m.messageId);
    }
  }
  for (const [id, expectedCategory] of fixesMap) {
    if (!seen.has(id)) {
      rows.push({ id, expectedCategory });
      seen.add(id);
    }
  }
  return rows;
}

function isCorrectionResult(row: CorrectionResult | null): row is CorrectionResult {
  return row !== null;
}

// Both rounds answer with one label per email, so the replay below is the
// same shape either way -- only which model call produces the label, and how
// a folder maps back to ground truth, differ by stage.
function judgeFor(stage: StageKey, model: ClassifierConfig) {
  if (stage === "phish") {
    return async (email: TriageEmail, prompt: string) => {
      const outcome = await judgePhishing(model, email, prompt);
      return "error" in outcome ? outcome : { id: outcome.id, category: outcome.verdict };
    };
  }
  return async (email: TriageEmail, prompt: string) => {
    const outcome = await classifyEmail(model, email, prompt);
    return "error" in outcome ? outcome : { id: outcome.id, category: outcome.category };
  };
}

// Round 1's vocabulary is {phishing, clean} but its keyword and folder are
// "suspicious" -- every other folder simply means the message wasn't phishing.
function groundTruthFor(stage: StageKey, folderCategory: string): string {
  if (stage !== "phish") return folderCategory;
  return folderCategory === PHISHING_CATEGORY ? "phishing" : CLEAN_VERDICT;
}

async function replay(
  candidatePrompt: string,
  category: string | undefined,
  stage: StageKey
): Promise<{ corrections: CorrectionResult[]; regressions: CorrectionResult[] }> {
  const [{ matches, mismatches }, fixesMap] = await Promise.all([scanKeywordState(), buildFixesMap(stage)]);

  const stageMismatches = mismatches.filter((m) => m.stage === stage);
  const stageMatches = matches.filter((m) => m.stage === stage);

  const scopedMismatches = category ? stageMismatches.filter((m) => m.predictedCategory === category) : stageMismatches;
  const scopedMatches = category ? stageMatches.filter((m) => m.category === category) : stageMatches;

  // Against the FULL fixes map regardless of scope: whether a mismatch is
  // resolved doesn't depend on which category this call is testing.
  const openCorrections = scopedMismatches.filter((m) => !fixesMap.has(m.messageId));

  // Folding past fixes into the counterweight *is* scoped, though -- else a
  // "suspicious"-scoped call would drag every "noise" guard along and blow
  // the point of scoping.
  const foldInMap = category
    ? new Map([...fixesMap].filter(([, expectedCategory]) => expectedCategory === category))
    : fixesMap;

  const counterweightCap = category ? COUNTERWEIGHT_SINGLE_CATEGORY : COUNTERWEIGHT_PER_CATEGORY;
  const counterweight = buildCounterweight(scopedMatches, foldInMap, counterweightCap);

  const idsToFetch = [...new Set([...openCorrections.map((c) => c.messageId), ...counterweight.map((c) => c.id)])];
  if (idsToFetch.length === 0) return { corrections: [], regressions: [] };

  const token = requireFastmailToken();
  const model = requireModelConfig();
  const session = await bootstrapSession(token);
  const emails = await fetchEmailsByIds(session, idsToFetch);
  const emailById = new Map(emails.map((e) => [e.id, e]));
  const judge = judgeFor(stage, model);

  // One email per call against the production model id: a replay is only
  // meaningful if it matches what runtime actually asks of the model.
  const correctionResults = await runPaced(openCorrections, model.modelId, async (correction): Promise<CorrectionResult | null> => {
    const email = emailById.get(correction.messageId);
    const folderCategory = actualCategoryFromMismatch(correction);
    // No body or no resolvable ground truth -- nothing meaningful to report,
    // so drop this row rather than failing the whole list.
    if (!email || folderCategory === null) return null;
    const actualCategory = groundTruthFor(stage, folderCategory);

    const outcome = await judge(email, candidatePrompt);
    if ("error" in outcome) {
      return {
        id: correction.messageId,
        subject: email.subject,
        expectedCategory: actualCategory,
        actualCategory: "(error)",
        status: "error",
        error: outcome.error,
      };
    }

    const status: CorrectionResult["status"] = outcome.category === actualCategory ? "fixed" : "unfixed";
    return {
      id: correction.messageId,
      subject: email.subject,
      expectedCategory: actualCategory,
      actualCategory: outcome.category,
      status,
    };
  });
  const corrections = correctionResults.filter(isCorrectionResult);

  const counterweightResults = await runPaced(counterweight, model.modelId, async (cw): Promise<CorrectionResult | null> => {
    const email = emailById.get(cw.id);
    if (!email) return null;
    const expectedCategory = groundTruthFor(stage, cw.expectedCategory);

    const outcome = await judge(email, candidatePrompt);
    if ("error" in outcome) {
      // Can't verify the guard still holds -- flag it rather than drop it.
      return {
        id: cw.id,
        subject: email.subject,
        expectedCategory,
        actualCategory: "(error)",
        status: "error",
        error: outcome.error,
      };
    }

    if (outcome.category === expectedCategory) return null;
    return {
      id: cw.id,
      subject: email.subject,
      expectedCategory,
      actualCategory: outcome.category,
      status: "regressed",
    };
  });
  const regressions = counterweightResults.filter(isCorrectionResult);

  return { corrections, regressions };
}

// `category` narrows the replay to one category's open corrections and
// counterweight; omit it for a full sweep. Purely a latency trade: a diff
// touching one category's wording (the common case, one cluster per round)
// never needed the other four re-verified, and skipping them is what buys
// COUNTERWEIGHT_SINGLE_CATEGORY's larger sample. The gate still checks the
// full vocabulary either way (runGate()). Covering a cross-category diff is
// the caller's job: call once per category, or omit it.
export async function evaluateCandidate(
  candidate: { version: string; prompt: string },
  category?: string,
  stage: StageKey = DEFAULT_STAGE
): Promise<EvaluateCandidateResult> {
  const gate = await runGate(candidate, category, stage);
  if (!gate.pass) {
    return { gate, fixes: [], corrections: [], regressions: [] };
  }

  const { corrections, regressions } = await replay(candidate.prompt, category, stage);
  const fixes = corrections.filter((c) => c.status === "fixed");
  return { gate, fixes, corrections, regressions };
}
