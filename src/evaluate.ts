// evaluate_candidate (jmap-triage-mcp tool #4) -- a static gate, then, only
// if it passes, a replay against a corpus derived LIVE on every call, not a
// stored one (there is no persisted regression corpus anywhere). Merged
// gate+replay into one call rather than two tools: the gate always has to
// run before replay anyway (there's no point spending a classify call and a
// JMAP round trip on a candidate that fails a cheap structural check
// first), so merging removes a sequencing rule from the caller's head into
// this function's own contract.

import { requireFastmailToken, requireModelConfig } from "./config.js";
import { getCurrentPrompt } from "./current-prompt.js";
import { getVersionHistory } from "./history.js";
import { classifyEmail } from "./classify.js";
import { runPaced } from "./model-pacing.js";
import { fetchEmailsByIds } from "./fetch-emails.js";
import { bootstrapSession } from "./jmap-session.js";
import { scanKeywordState, type KeywordMatch, type KeywordMismatch } from "./keyword-scan.js";
import { MAILBOX_SPECS } from "./mailboxes.js";

// Deterministic (sorted, not randomized) so re-evaluating the same
// candidate mid-round compares against an identical baseline every call.
// Sized to leave real margin under Claude Desktop's hard, non-configurable
// 4-minute (240s) timeout on remote MCP tool calls as the mailbox keeps
// growing -- the fixes-map entries folded in on top of this cap (uncapped)
// are what actually matter most, per the "highest-value regression guards"
// reasoning above.
export const COUNTERWEIGHT_PER_CATEGORY = 6;
// Used instead of COUNTERWEIGHT_PER_CATEGORY when the caller scopes a call
// to a single category (evaluateCandidate's `category` param) -- larger,
// since the 6-per-category cap above exists to keep a *5-category sweep*
// under the 240s budget. One category alone never had that problem; the
// sweep's cost was always "N x 5", not "N".
const COUNTERWEIGHT_SINGLE_CATEGORY = 20;
// Concurrency and pacing come from model-pacing.ts's runPaced(), measured
// against the live provider -- see DECISIONS.md.

// The exact trailing instruction the live prompt ends with. A candidate
// that drops or rewords this breaks classify.ts's
// extractJsonArray/JSON.parse contract for every email, not just a
// misclassified one -- worth gating on before spending a single classify
// call.
const JSON_REPLY_INSTRUCTION = /reply with only a json array/i;

// The candidate's CATEGORY section is expected to enumerate categories the
// same way the live prompt does: a top-level bullet whose text starts with
// a quoted, lowercase category name followed by a colon (e.g.
// `- "orders": the lifecycle of...`). This is a structural check on that
// convention, not a prose parser -- a candidate that renames a category or
// changes this formatting convention should fail the gate and get a human
// look, not be silently misparsed.
const CATEGORY_BULLET = /^-\s*"([a-z]+)":/gm;

function extractCategoryNames(promptText: string): Set<string> {
  const names = new Set<string>();
  for (const match of promptText.matchAll(CATEGORY_BULLET)) {
    names.add(match[1]);
  }
  return names;
}

function expectedCategoryNames(): Set<string> {
  return new Set(MAILBOX_SPECS.flatMap((s) => (s.category ? [s.category as string] : [])));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export interface CorrectionResult {
  id: string;
  subject: string;
  expectedCategory: string;
  actualCategory: string;
  // "fixed"/"unfixed" describe an open correction's replay outcome;
  // "regressed" describes a counterweight row that broke; "error" covers
  // both -- a classify call that failed outright, surfaced instead of
  // silently dropped so it can't be mistaken for "still wrong"/"still
  // held" (see runPaced() callers below).
  status: "fixed" | "unfixed" | "regressed" | "error";
  expectedNotify?: boolean;
  actualNotify?: boolean;
  error?: string;
}

export interface EvaluateCandidateResult {
  gate: { pass: boolean; reasons: string[]; candidateCategories: string[] };
  fixes: CorrectionResult[];
  // Every open correction's outcome, not just the ones that flipped -- an
  // "unfixed" or "error" row here is what previously vanished as a bare
  // `null`, making a candidate that didn't help indistinguishable from one
  // that couldn't be evaluated at all.
  corrections: CorrectionResult[];
  regressions: CorrectionResult[];
}

async function runGate(
  candidate: { version: string; prompt: string },
  category?: string
): Promise<{ pass: boolean; reasons: string[]; candidateCategories: string[] }> {
  const reasons: string[] = [];

  const current = await getCurrentPrompt();
  if (candidate.version === current.version) {
    reasons.push(`candidate version "${candidate.version}" is the same as the live version -- bump it`);
  }

  if (!JSON_REPLY_INSTRUCTION.test(candidate.prompt)) {
    reasons.push('trailing "Reply with ONLY a JSON array" instruction is missing or reworded');
  }

  const candidateCategories = extractCategoryNames(candidate.prompt);
  const expected = expectedCategoryNames();
  // Checked against the FULL vocabulary even when `category` scopes the
  // replay below to one of them -- a candidate always has to support every
  // category regardless of which one this particular call is replay-
  // testing, so this check never narrows with `category`.
  if (!setsEqual(candidateCategories, expected)) {
    reasons.push(
      `category vocabulary mismatch -- candidate has {${[...candidateCategories].sort().join(", ")}}, ` +
        `folder map has {${[...expected].sort().join(", ")}}`
    );
  }

  if (category !== undefined && !expected.has(category)) {
    reasons.push(`unknown category "${category}" -- expected one of {${[...expected].sort().join(", ")}}`);
  }

  // Echoed regardless of pass/fail -- lets a caller see exactly which
  // category names the candidate's CATEGORY section parsed as, without
  // having to reverse-engineer it from the vocabulary-mismatch reason text.
  return { pass: reasons.length === 0, reasons, candidateCategories: [...candidateCategories].sort() };
}

// The one thing a live JMAP scan alone can't tell evaluate_candidate:
// which mismatches have *already been fixed* by a prior approval. A
// message's $ai-* keyword reflects whatever the prompt predicted when
// that email arrived -- approving a new version doesn't retroactively
// re-stamp old mail, so scanKeywordState() will list a message as a
// mismatch forever even after a later version starts classifying its kind
// correctly. approve_prompt_diff writes the evaluate_candidate result that
// justified each approval into history/<version>.json's replay.fixes
// field specifically so this can be reconstructed later -- read it back
// instead of re-deriving it from nothing. Most-recent record wins if a
// message appears in more than one past fixes list.
async function buildFixesMap(): Promise<Map<string, string>> {
  const history = await getVersionHistory({}); // most-recent-first
  const map = new Map<string, string>();
  for (const record of [...history].reverse()) {
    for (const fix of record.replay?.fixes ?? []) {
      map.set(fix.id, fix.expectedCategory);
    }
  }
  return map;
}

// The ground-truth category a mismatch's actual folder corresponds to, if
// any -- e.g. a message sitting in Inbox/Orders is "orders" regardless of
// what it was predicted as. Not resolvable for a message the user deleted
// (folder shows "(none — deleted?)") or trashed via a path that isn't one
// of the five category folders (e.g. plain Trash, outside the "suspicious"
// exception scanKeywordState() already special-cases as a match) -- those
// return null, and a null ground truth can never count as "fixed" below,
// which is the conservative, correct default when there's nothing to
// verify a fix against.
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

// Sorted (not sampled/randomized) so the same candidate re-evaluated
// mid-round always compares against an identical baseline. Every message a
// past fix targeted is folded in directly regardless of the per-category cap --
// those are the highest-value regression guards, each the specific case a
// prior fix was needed for. `capPerCategory` is the caller's choice
// (COUNTERWEIGHT_PER_CATEGORY for an unscoped sweep,
// COUNTERWEIGHT_SINGLE_CATEGORY when `category` narrows `matches` to one
// category already) -- this function doesn't know or care which.
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

async function replay(
  candidatePrompt: string,
  category?: string
): Promise<{ corrections: CorrectionResult[]; regressions: CorrectionResult[] }> {
  const [{ matches, mismatches }, fixesMap] = await Promise.all([scanKeywordState(), buildFixesMap()]);

  const scopedMismatches = category ? mismatches.filter((m) => m.predictedCategory === category) : mismatches;
  const scopedMatches = category ? matches.filter((m) => m.category === category) : matches;

  // "Already resolved" is checked against the FULL fixes map regardless of
  // scope -- a mismatch's resolution status doesn't depend on which
  // category this particular call happens to be testing.
  const openCorrections = scopedMismatches.filter((m) => !fixesMap.has(m.messageId));

  // Folding past fixes into the counterweight, though, *is* scoped: an
  // unscoped call still gets every past fix folded in (full coverage,
  // matching the original design); a category-scoped call only pulls in
  // that category's own past fixes, so a "suspicious"-scoped call doesn't
  // drag a "noise" guard message along and blow the point of scoping.
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

  // One email per classify call, same as production -- a replay is only
  // meaningful if it reflects what actually gets asked of the model at
  // runtime, against the same model id production classifies with.
  const correctionResults = await runPaced(openCorrections, model.modelId, async (correction): Promise<CorrectionResult | null> => {
    const email = emailById.get(correction.messageId);
    const actualCategory = actualCategoryFromMismatch(correction);
    // No fetched body, or no resolvable ground truth to check against --
    // nothing meaningful to report (no subject, no ground truth to compare
    // against), so this one row stays dropped rather than the whole
    // corrections list.
    if (!email || actualCategory === null) return null;

    const outcome = await classifyEmail(model, email, candidatePrompt);
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

    const outcome = await classifyEmail(model, email, candidatePrompt);
    if ("error" in outcome) {
      // Can't verify this guard still holds -- conservatively flag it
      // rather than silently drop it.
      return {
        id: cw.id,
        subject: email.subject,
        expectedCategory: cw.expectedCategory,
        actualCategory: "(error)",
        status: "error",
        error: outcome.error,
      };
    }

    if (outcome.category === cw.expectedCategory) return null;
    return {
      id: cw.id,
      subject: email.subject,
      expectedCategory: cw.expectedCategory,
      actualCategory: outcome.category,
      status: "regressed",
    };
  });
  const regressions = counterweightResults.filter(isCorrectionResult);

  return { corrections, regressions };
}

// `category` narrows the replay to just that one category's open
// corrections and counterweight sample -- omit it for the original
// full-sweep behavior. Scoping exists purely for latency: a diff that only
// touches one category's wording (the common case, since the review loop
// works one cluster per round by default) never needed the other four
// categories re-verified every call, and skipping them is what lets
// COUNTERWEIGHT_SINGLE_CATEGORY stay near the original per-category sample
// size instead of the sweep's shrunk one. The gate still checks the
// candidate's FULL category vocabulary regardless of `category` -- a
// candidate has to support every category either way, see runGate().
// Coverage for a cross-category diff (e.g. a tie-breaker spanning
// categories) is the caller's responsibility: call once per affected
// category, or omit `category` for a full sweep.
export async function evaluateCandidate(
  candidate: { version: string; prompt: string },
  category?: string
): Promise<EvaluateCandidateResult> {
  const gate = await runGate(candidate, category);
  if (!gate.pass) {
    return { gate, fixes: [], corrections: [], regressions: [] };
  }

  const { corrections, regressions } = await replay(candidate.prompt, category);
  const fixes = corrections.filter((c) => c.status === "fixed");
  return { gate, fixes, corrections, regressions };
}
