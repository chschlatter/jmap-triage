// get_current_prompt (jmap-triage-mcp tool #1) -- reads current.json, the
// live pointer approve.ts writes. Pure: no fallback-to-bundled-prompt.ts
// behavior here. That fallback belongs to the *production pipeline's*
// cold-start fetch (lambda.ts), which wraps this function in a try/catch --
// a review tool should surface a real error instead of silently returning a
// stale local copy. See jmap-triage-mcp-claude-code-instructions.md.

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
