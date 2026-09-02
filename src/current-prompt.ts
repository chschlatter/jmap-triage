// get_current_prompt (jmap-triage-mcp tool #1) -- reads current.json, the
// live pointer approve.ts writes. Pure: throws on a failed fetch rather
// than falling back to anything -- there is no local prompt to fall back
// to (the real prompt describes a specific person, so a git-committable
// copy would have to be either generic-and-wrong or
// PII-bearing-and-uncommittable). Every caller (CLI, eval, Lambda,
// jmap-triage-mcp) fetches this live.

import { requirePromptBucket } from "./config.js";
import { getJson } from "./s3-json.js";

export const CURRENT_PROMPT_KEY = "current.json";

export interface CurrentPrompt {
  version: string;
  prompt: string;
}

export async function getCurrentPrompt(): Promise<CurrentPrompt> {
  const bucket = requirePromptBucket();
  const data = await getJson<Partial<CurrentPrompt>>(bucket, CURRENT_PROMPT_KEY);
  if (typeof data.version !== "string" || typeof data.prompt !== "string") {
    throw new Error(`Malformed s3://${bucket}/${CURRENT_PROMPT_KEY}: expected {version, prompt}`);
  }
  return { version: data.version, prompt: data.prompt };
}
