// Classification against GreenPT (api.greenpt.ai), a plain OpenAI
// chat-completions API. One email per call -- see DECISIONS.md for why this
// provider, why one email, and what the rollback path is if GreenPT fails.
//
// Changing GREENPT_MODEL_ID also needs a matching entry in model-pacing.ts,
// or classification runs at the conservative default rather than the model's
// measured pacing.

import type { TriageEmail } from "./fetch-emails.js";

const GREENPT_API_URL = "https://api.greenpt.ai/v1/chat/completions";
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;

export interface ClassifierConfig {
  apiKey: string;
  modelId: string;
}

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

// Retries on 429. Note that a 429 is not necessarily throttling: GreenPT
// returns 402 Payment Required on exhausted credits, but some gateways signal
// an empty balance as a 429 with an insufficient_quota code. Retrying that
// just burns the backoff ladder, so it is surfaced rather than retried.
async function invokeOpenAICompatible(
  config: ClassifierConfig,
  systemText: string,
  userContent: string,
  maxTokens: number
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(GREENPT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemText },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new Error(`No text content in response from ${GREENPT_API_URL}: ${JSON.stringify(data)}`);
      }
      return text;
    }

    const body = await response.text().catch(() => "");
    // Billing failures are terminal, not transient -- backing off will not
    // add credit. Checked before the 429 retry so an empty balance fails
    // fast with the provider's own message instead of after five sleeps.
    const billing = response.status === 402 || /insufficient_quota|billing_error/.test(body);
    const throttled = response.status === 429 && !billing;
    if (!throttled || attempt >= MAX_RETRIES) {
      throw new Error(`API error ${response.status} from ${GREENPT_API_URL}: ${body.slice(0, 300)}`);
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }
}

// notify is coerced fail-closed (missing/non-boolean -> false rather than
// erroring the email out): a lost notification is a mild inconvenience, but a
// malformed field shouldn't leave the email stuck in Inbox/Triage.
export function parseClassificationResponse(responseText: string, email: TriageEmail): ClassificationOutcome {
  const candidate = extractJsonArray(responseText) ?? responseText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { id: email.id, error: `Response was not valid JSON: ${responseText.slice(0, 200)}` };
  }

  if (!Array.isArray(parsed)) {
    return { id: email.id, error: `Response was not a JSON array: ${responseText.slice(0, 200)}` };
  }

  // The prompt describes an array-in/array-out contract, so the reply is an
  // array of one -- match on id rather than taking [0], so a model that
  // echoes something unexpected fails loudly instead of being misattributed.
  for (const item of parsed as Array<{ id?: unknown; category?: unknown; notify?: unknown }>) {
    if (item.id === email.id && typeof item.category === "string") {
      return { id: email.id, category: item.category, notify: item.notify === true };
    }
  }
  return { id: email.id, error: `Missing from response: ${responseText.slice(0, 200)}` };
}

// Wraps the single email in a one-element array: the prompt describes a JSON
// array of emails in and a JSON array of results out, so the wire format stays
// an array even though only one email is ever sent. Exported so an eval can
// send the byte-identical request.
export function buildClassifyUserContent(email: TriageEmail): string {
  return JSON.stringify([
    {
      id: email.id,
      subject: email.subject,
      from: email.from,
      to: email.to,
      receivedAt: email.receivedAt,
      body: email.body,
      attachments: email.attachments,
    },
  ]);
}

// ~150 tokens covers the id/category/notify JSON itself, but reasoning-first
// models spend additional tokens on a reasoning block *before* emitting that
// JSON. 1200 leaves headroom for that and costs nothing extra (GreenPT bills
// actual output tokens, not maxTokens).
export const CLASSIFY_MAX_TOKENS = 1200;

export async function classifyEmail(
  config: ClassifierConfig,
  email: TriageEmail,
  // Required, no bundled-constant default -- there is no local fallback
  // prompt (see DECISIONS.md, "no bundled local prompt"). Every caller
  // fetches the live prompt from S3 first and passes it in explicitly.
  promptText: string
): Promise<ClassificationOutcome> {
  let responseText: string;
  try {
    responseText = await invokeOpenAICompatible(config, promptText, buildClassifyUserContent(email), CLASSIFY_MAX_TOKENS);
  } catch (err) {
    return { id: email.id, error: err instanceof Error ? err.message : String(err) };
  }

  return parseClassificationResponse(responseText, email);
}
