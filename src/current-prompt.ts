// get_current_prompt -- reads current.json, the live pointer approve.ts
// writes and every caller (CLI, eval, Lambda, MCP) fetches. Throws on a
// failed fetch; there is no local prompt to fall back to (DECISIONS.md).

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
