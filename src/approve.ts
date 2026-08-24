// approve_prompt_diff (jmap-triage-mcp tool #5) -- the only write path in
// the entire server. Takes the evaluate_candidate result as input, not
// re-derived, so a history record can never claim a replay outcome that
// wasn't actually produced by a real evaluation call. The calling Claude
// session is responsible for having gotten explicit human approval before
// calling this at all -- see mcp-server.ts's tool description.
//
// Writes, in order: current.json (the new live pointer), then
// history/<version>.json (the full immutable record), then
// history/index.json (append the new version). See
// jmap-triage-mcp-proposal-v4.md's S3 layout.

import { requirePromptBucket } from "./config.js";
import { getJson, putJson } from "./s3-json.js";
import { CURRENT_PROMPT_KEY, getCurrentPrompt } from "./current-prompt.js";
import { HISTORY_INDEX_KEY, historyRecordKey, type VersionRecord } from "./history.js";
import type { CorrectionResult } from "./evaluate.js";

export interface ApproveCandidate {
  version: string;
  prompt: string;
}

export interface ApproveEvaluation {
  fixes: CorrectionResult[];
  regressions: CorrectionResult[];
}

export interface ApproveMeta {
  rationale: string;
  evidence: string[];
  paragraphsEdited: string[];
}

export interface ApprovePromptDiffResult {
  written: true;
  version: string;
}

export async function approvePromptDiff(
  candidate: ApproveCandidate,
  evaluation: ApproveEvaluation,
  meta: ApproveMeta
): Promise<ApprovePromptDiffResult> {
  const bucket = requirePromptBucket();

  // Read the live pointer at write time (not caller-supplied) so
  // previousVersion in the record reflects what was actually live the
  // instant this approval landed, not whatever the caller's evaluate_candidate
  // call saw earlier in the round.
  const previous = await getCurrentPrompt().catch(() => null);

  const record: VersionRecord = {
    version: candidate.version,
    previousVersion: previous?.version ?? null,
    prompt: candidate.prompt,
    approvedAt: new Date().toISOString(),
    rationale: meta.rationale,
    evidence: meta.evidence,
    paragraphsEdited: meta.paragraphsEdited,
    replay: evaluation,
  };

  await putJson(bucket, CURRENT_PROMPT_KEY, { version: candidate.version, prompt: candidate.prompt });
  await putJson(bucket, historyRecordKey(candidate.version), record);

  let index: string[];
  try {
    index = await getJson<string[]>(bucket, HISTORY_INDEX_KEY);
  } catch (err) {
    if (err instanceof Error && err.name === "NoSuchKey") {
      index = [];
    } else {
      throw err;
    }
  }
  index.push(candidate.version);
  await putJson(bucket, HISTORY_INDEX_KEY, index);

  return { written: true, version: candidate.version };
}
