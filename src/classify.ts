// Classification via Bedrock (model chosen by BEDROCK_MODEL_ID -- currently
// gpt-oss-120b, see samconfig.toml/.env). Changing BEDROCK_MODEL_ID also
// needs a matching entry in model-pacing.ts, or classification falls back
// to conservative pacing rather than the model's real quota. Relocated
// from triage.ts (v4) verbatim -- v5 doesn't change the classification
// stage itself, only what happens downstream of it. See
// triage.ts-DESIGN-v5-2026-08-02.md §4 and triage.ts-DESIGN-v4-2026-08-02.md
// §3 for the original rationale.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PROMPT } from "../prompt.js";
import type { TriageEmail } from "./fetch-emails.js";

export const CLASSIFY_BATCH_SIZE = 1;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;

export type ClassificationOutcome =
  | { id: string; category: string; notify: boolean }
  | { id: string; error: string };

// The model sometimes wraps its JSON in a ```json fence and/or appends
// trailing prose (e.g. "**Reasoning:** ...") despite being told to reply
// with ONLY the array. Extract the first balanced top-level [...] instead of
// assuming the whole response is bare JSON.
export function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bedrock throttles fairly aggressively under sequential load (observed
// empirically running 50 back-to-back calls). Retry with backoff on
// throttling rather than assume it won't happen.
//
// Goes through Bedrock's Converse API rather than InvokeModel with a
// hand-built Anthropic Messages-on-Bedrock body (anthropic_version,
// content[0].text) -- that schema is Anthropic-specific and doesn't work
// against non-Anthropic models (e.g. Qwen). Converse is the documented
// cross-provider interface, so modelId alone decides which model runs;
// nothing else here is Anthropic-specific.
async function invokeBedrock(
  client: BedrockRuntimeClient,
  modelId: string,
  promptText: string,
  userContent: string,
  maxTokens: number
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: promptText }],
          messages: [{ role: "user", content: [{ text: userContent }] }],
          inferenceConfig: { maxTokens, temperature: 0 },
        })
      );
      // Reasoning-first models (e.g. gpt-oss, MiniMax) emit a
      // reasoningContent block ahead of the actual answer -- content[0] is
      // not reliably the text block the way it is for direct-answer models,
      // so scan for the first block that has one instead of indexing.
      const text = response.output?.message?.content?.find((block) => typeof block.text === "string")?.text;
      if (typeof text !== "string") {
        throw new Error(`No text content in Bedrock response: ${JSON.stringify(response.output)}`);
      }
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const throttled = message.includes("Too many requests") || message.includes("Throttling");
      if (!throttled || attempt >= MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
}

export async function classifyBatch(
  client: BedrockRuntimeClient,
  modelId: string,
  emails: TriageEmail[],
  // Defaults to the bundled prompt so every existing caller (CLI, eval)
  // keeps working unchanged. Callers that classify against a different
  // prompt text -- the Lambda's S3-fetched live prompt, or an
  // evaluate_candidate replay against a draft -- pass it explicitly instead
  // of this module reaching for a single global constant.
  promptText: string = PROMPT
): Promise<ClassificationOutcome[]> {
  const userContent = JSON.stringify(
    emails.map((e) => ({
      id: e.id,
      subject: e.subject,
      from: e.from,
      to: e.to,
      receivedAt: e.receivedAt,
      body: e.body,
      attachments: e.attachments,
    }))
  );

  // ~150 tokens/email covers the id/category/notify JSON itself, but
  // reasoning-first models (gpt-oss, MiniMax) spend additional tokens on a
  // reasoningContent block *before* emitting that JSON -- observed ~100-150
  // reasoning tokens on a trivial test email, more expected on real
  // classification decisions. 1000/email leaves headroom for that without
  // costing anything extra for direct-answer models (Bedrock bills actual
  // output tokens, not maxTokens), still capped well under the 4096 ceiling
  // at CLASSIFY_BATCH_SIZE=1.
  const maxTokens = Math.min(4096, 1000 * emails.length + 200);

  let responseText: string;
  try {
    responseText = await invokeBedrock(client, modelId, promptText, userContent, maxTokens);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emails.map((e) => ({ id: e.id, error: message }));
  }

  const candidate = extractJsonArray(responseText) ?? responseText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const message = `Response was not valid JSON: ${responseText.slice(0, 200)}`;
    return emails.map((e) => ({ id: e.id, error: message }));
  }

  if (!Array.isArray(parsed)) {
    const message = `Response was not a JSON array: ${responseText.slice(0, 200)}`;
    return emails.map((e) => ({ id: e.id, error: message }));
  }

  // notify is fail-closed: missing or non-boolean coerces to false rather
  // than erroring the whole email out -- a lost notification is a mild
  // inconvenience, but a bad batch response shouldn't leave the email
  // stuck in Inbox/Triage over one malformed field. See prompt.ts v7.
  const byId = new Map<string, { category: string; notify: boolean }>();
  for (const item of parsed as Array<{ id?: unknown; category?: unknown; notify?: unknown }>) {
    if (typeof item.id === "string" && typeof item.category === "string") {
      byId.set(item.id, { category: item.category, notify: item.notify === true });
    }
  }

  return emails.map((e) => {
    const result = byId.get(e.id);
    if (!result) {
      return { id: e.id, error: `Missing from batch response: ${responseText.slice(0, 200)}` };
    }
    return { id: e.id, category: result.category, notify: result.notify };
  });
}
