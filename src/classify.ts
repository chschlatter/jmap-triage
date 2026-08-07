// Classification via Claude Haiku on Bedrock. Relocated from triage.ts (v4)
// verbatim -- v5 doesn't change the classification stage itself, only what
// happens downstream of it. See triage.ts-DESIGN-v5-2026-08-02.md §4 and
// triage.ts-DESIGN-v4-2026-08-02.md §3 for the original rationale.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
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
function extractJsonArray(text: string): string | null {
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
async function invokeBedrock(client: BedrockRuntimeClient, modelId: string, body: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await client.send(
        new InvokeModelCommand({ modelId, contentType: "application/json", accept: "application/json", body })
      );
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const text = responseBody?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error(`No text content in Bedrock response: ${JSON.stringify(responseBody)}`);
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
  emails: TriageEmail[]
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

  // ~150 tokens/email of headroom, based on observed output size for the
  // id/category schema.
  const maxTokens = Math.min(4096, 150 * emails.length + 200);

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature: 0,
    system: PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  let responseText: string;
  try {
    responseText = await invokeBedrock(client, modelId, body);
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
