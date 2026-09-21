// get_version_history -- the read side of approve.ts's history. Without it
// that history is durable but unusable: "check what was already tried before
// re-proposing it" needs a read path. Never writes.

import { requirePromptBucket } from "./config.js";
import { getJson } from "./s3-json.js";
import { DEFAULT_STAGE, stageSpec, type StageKey } from "./stages.js";
import type { CorrectionResult } from "./evaluate.js";

export function historyIndexKey(stage: StageKey = DEFAULT_STAGE): string {
  return `${stageSpec(stage).s3Prefix}history/index.json`;
}
export function historyRecordKey(version: string, stage: StageKey = DEFAULT_STAGE): string {
  return `${stageSpec(stage).s3Prefix}history/${version}.json`;
}

export interface VersionRecord {
  version: string;
  previousVersion: string | null;
  prompt: string;
  approvedAt: string;
  rationale: string;
  evidence: string[];
  paragraphsEdited: string[];
  replay: { fixes: CorrectionResult[]; regressions: CorrectionResult[] };
}

export interface GetVersionHistoryParams {
  limit?: number;
  // Only versions approved after this one, for paging a long history. Most
  // callers omit it and get everything, most-recent-first.
  sinceVersion?: string;
  stage?: StageKey;
}

export async function getVersionHistory(params: GetVersionHistoryParams = {}): Promise<VersionRecord[]> {
  const bucket = requirePromptBucket();
  const stage = params.stage ?? DEFAULT_STAGE;

  let index: string[];
  try {
    index = await getJson<string[]>(bucket, historyIndexKey(stage));
  } catch (err) {
    // No approval written yet -- a normal starting state, not an error. Any
    // other failure (permissions, malformed JSON) still propagates.
    if (err instanceof Error && err.name === "NoSuchKey") return [];
    throw err;
  }

  // index.json is append-order (oldest first); callers expect the reverse.
  let versions = [...index].reverse();

  if (params.sinceVersion) {
    const cursor = versions.indexOf(params.sinceVersion);
    versions = cursor === -1 ? [] : versions.slice(cursor + 1);
  }

  if (params.limit !== undefined) {
    versions = versions.slice(0, params.limit);
  }

  return Promise.all(versions.map((v) => getJson<VersionRecord>(bucket, historyRecordKey(v, stage))));
}
