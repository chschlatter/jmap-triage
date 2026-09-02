// get_version_history (jmap-triage-mcp tool #2) -- the read side of
// structured note-taking. Without this, the S3 history approve.ts writes is
// durable but unusable: the working rule of "treat prior decisions as
// ground truth before re-proposing something already tried" needs an actual
// read path to be true in practice. Pure: reads history/index.json + each
// history/<version>.json, never writes.

import { requirePromptBucket } from "./config.js";
import { getJson } from "./s3-json.js";
import type { CorrectionResult } from "./evaluate.js";

export const HISTORY_INDEX_KEY = "history/index.json";
export function historyRecordKey(version: string): string {
  return `history/${version}.json`;
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
  // Return only versions approved after this one (index order), for cheap
  // pagination through a long history -- most callers (the interactive
  // loop's "has this been tried before?" check) omit it and get everything
  // back to the start, most-recent-first.
  sinceVersion?: string;
}

export async function getVersionHistory(params: GetVersionHistoryParams = {}): Promise<VersionRecord[]> {
  const bucket = requirePromptBucket();

  let index: string[];
  try {
    index = await getJson<string[]>(bucket, HISTORY_INDEX_KEY);
  } catch (err) {
    // No approval has ever been written -- an empty history is a normal
    // starting state, not an error. Any other failure (permissions,
    // malformed JSON) still propagates.
    if (err instanceof Error && err.name === "NoSuchKey") return [];
    throw err;
  }

  // index.json is append-order (oldest first, per approve.ts) -- reverse
  // for the most-recent-first contract callers expect.
  let versions = [...index].reverse();

  if (params.sinceVersion) {
    const cursor = versions.indexOf(params.sinceVersion);
    versions = cursor === -1 ? [] : versions.slice(cursor + 1);
  }

  if (params.limit !== undefined) {
    versions = versions.slice(0, params.limit);
  }

  return Promise.all(versions.map((v) => getJson<VersionRecord>(bucket, historyRecordKey(v))));
}
