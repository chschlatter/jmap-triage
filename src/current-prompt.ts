// get_current_prompt -- reads current.json, the live pointer approve.ts
// writes and every caller (CLI, eval, Lambda, MCP) fetches. Throws on a
// failed fetch; there is no local prompt to fall back to (DECISIONS.md).

import { requirePromptBucket } from "./config.js";
import { getJson } from "./s3-json.js";
import { DEFAULT_STAGE, stageSpec, type StageKey } from "./stages.js";

// Round 2 keeps the bare key it has always had, so its object never moves;
// round 1 lands under phish/.
export function currentPromptKey(stage: StageKey = DEFAULT_STAGE): string {
  return `${stageSpec(stage).s3Prefix}current.json`;
}

export interface CurrentPrompt {
  version: string;
  prompt: string;
}

export async function getCurrentPrompt(stage: StageKey = DEFAULT_STAGE): Promise<CurrentPrompt> {
  const bucket = requirePromptBucket();
  const key = currentPromptKey(stage);
  const data = await getJson<Partial<CurrentPrompt>>(bucket, key);
  if (typeof data.version !== "string" || typeof data.prompt !== "string") {
    throw new Error(`Malformed s3://${bucket}/${key}: expected {version, prompt}`);
  }
  return { version: data.version, prompt: data.prompt };
}
