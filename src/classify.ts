// Classification against GreenPT (api.greenpt.ai), a plain OpenAI
// chat-completions API, one email per call. DECISIONS.md has why this
// provider, why one email, and the rollback path.
//
// A new GREENPT_MODEL_ID also needs an entry in model-pacing.ts, or it runs
// at the conservative default instead of its measured pacing.

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

// The model sometimes wraps its JSON in a ```json fence or appends prose
// ("**Reasoning:** ...") despite being told to reply with ONLY the array --
// so take the first balanced top-level [...] rather than the whole response.
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

// Retries on 429 -- except the ones that aren't throttling: GreenPT returns
// 402 on exhausted credits, but some gateways signal an empty balance as a
// 429 with insufficient_quota. Backing off will not add credit.
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
    // Checked before the retry, so an empty balance fails fast with the
    // provider's own message instead of after five sleeps.
    const billing = response.status === 402 || /insufficient_quota|billing_error/.test(body);
    const throttled = response.status === 429 && !billing;
    if (!throttled || attempt >= MAX_RETRIES) {
      throw new Error(`API error ${response.status} from ${GREENPT_API_URL}: ${body.slice(0, 300)}`);
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }
}

// notify is fail-closed (missing/non-boolean -> false): a lost push is a mild
// inconvenience, a stuck email in Inbox/Triage is worse.
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

  // Array-in/array-out per the prompt, so this is an array of one -- match on
  // id rather than [0], so an unexpected echo fails loudly instead of being
  // misattributed.
  for (const item of parsed as Array<{ id?: unknown; category?: unknown; notify?: unknown }>) {
    if (item.id === email.id && typeof item.category === "string") {
      return { id: email.id, category: item.category, notify: item.notify === true };
    }
  }
  return { id: email.id, error: `Missing from response: ${responseText.slice(0, 200)}` };
}

// One-element array: the prompt describes array-in/array-out, so the wire
// format stays an array. Exported so an eval sends the identical request.
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

// ~150 tokens covers the JSON itself; the rest is headroom for a
// reasoning-first model's preamble. Costs nothing extra -- GreenPT bills
// actual output tokens, not max_tokens.
export const CLASSIFY_MAX_TOKENS = 1200;

export async function classifyEmail(
  config: ClassifierConfig,
  email: TriageEmail,
  // Required, no default: there is no local fallback prompt. Every caller
  // fetches the live S3 prompt first (DECISIONS.md).
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
