// Classification via one of three providers, chosen by MODEL_PROVIDER (see
// config.ts's requireModelConfig()):
//   bedrock -- AWS Bedrock Converse, model chosen by BEDROCK_MODEL_ID.
//   mistral -- api.mistral.ai directly, model chosen by MISTRAL_MODEL_ID.
//   greenpt -- api.greenpt.ai directly, model chosen by GREENPT_MODEL_ID.
//              Utrecht NL, renewable EU datacenters, EU-owned rather than
//              merely EU-region (which is what Bedrock eu-central-1 gives).
// Mistral and GreenPT are both plain OpenAI chat-completions APIs and share
// invokeOpenAICompatible() below; only the base URL differs. Changing any
// model id also needs a matching entry in model-pacing.ts, or classification
// falls back to conservative pacing rather than the model's real quota.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { TriageEmail } from "./fetch-emails.js";

export const CLASSIFY_BATCH_SIZE = 1;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const GREENPT_API_URL = "https://api.greenpt.ai/v1/chat/completions";

export type ClassifierConfig =
  | { provider: "bedrock"; client: BedrockRuntimeClient; modelId: string }
  | { provider: "mistral"; apiKey: string; modelId: string }
  | { provider: "greenpt"; apiKey: string; modelId: string };

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

// Bedrock throttles fairly aggressively under sequential load. Retry with
// backoff on throttling rather than assume it won't happen.
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

// A provider's own EU-hosted OpenAI-compatible endpoint (api.mistral.ai or
// api.greenpt.ai), not Bedrock -- no cross-region inference profile or AWS
// credential chain involved, just an API key and a base URL. Retries on 429
// the same way invokeBedrock retries on throttling; Mistral's tier needs
// real backoff (see model-pacing.ts for the empirically-measured pacing that
// keeps this from firing at all), GreenPT measured clean at concurrency 8.
//
// Note that a 429 here is not necessarily throttling: GreenPT returns 402
// Payment Required on exhausted credits, but some gateways signal an empty
// balance as a 429 with an insufficient_quota code. Retrying that just burns
// the backoff ladder, so it is surfaced rather than retried.
async function invokeOpenAICompatible(
  apiUrl: string,
  apiKey: string,
  modelId: string,
  systemText: string,
  userContent: string,
  maxTokens: number
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
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
        throw new Error(`No text content in response from ${apiUrl}: ${JSON.stringify(data)}`);
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
      throw new Error(`API error ${response.status} from ${apiUrl}: ${body.slice(0, 300)}`);
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }
}

// Shared by both providers -- JSON extraction, per-id lookup, and notify's
// fail-closed coercion (missing/non-boolean -> false rather than erroring
// the whole email out; a lost notification is a mild inconvenience, but a
// bad batch response shouldn't leave the email stuck in Inbox/Triage over
// one malformed field) don't depend on which provider produced responseText.
export function parseClassificationResponse(responseText: string, emails: TriageEmail[]): ClassificationOutcome[] {
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

// Request-body shape and output budget, factored out of classifyBatch so an
// eval script benchmarking an alternative transport (eval/run-eval-melious.ts)
// can send the byte-identical request and grade with the identical parser --
// only the HTTP call differs, which is what keeps its accuracy numbers
// comparable to the production Bedrock baseline instead of measuring a
// re-implementation's drift.
export function buildClassifyUserContent(emails: TriageEmail[]): string {
  return JSON.stringify(
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
}

// ~150 tokens/email covers the id/category/notify JSON itself, but
// reasoning-first models (gpt-oss, MiniMax, GLM) spend additional tokens on a
// reasoning block *before* emitting that JSON -- observed ~100-150 reasoning
// tokens on a trivial test email, more expected on real classification
// decisions. 1000/email leaves headroom for that without costing anything
// extra for direct-answer models (every provider here bills actual output
// tokens, not maxTokens), still capped well under the 4096 ceiling at
// CLASSIFY_BATCH_SIZE=1.
export function classifyMaxTokens(emails: TriageEmail[]): number {
  return Math.min(4096, 1000 * emails.length + 200);
}

export async function classifyBatch(
  config: ClassifierConfig,
  emails: TriageEmail[],
  // Required, no bundled-constant default -- there is no local fallback
  // prompt (see current-prompt.ts's header comment on why one shouldn't
  // exist: the real prompt describes a specific person, so a "safe to
  // commit" bundled copy would have to be either generic-and-wrong or
  // PII-bearing-and-uncommittable). Every caller fetches the live prompt
  // from S3 first (getCurrentPrompt()) and passes it in explicitly.
  promptText: string
): Promise<ClassificationOutcome[]> {
  const userContent = buildClassifyUserContent(emails);

  const maxTokens = classifyMaxTokens(emails);

  let responseText: string;
  try {
    if (config.provider === "bedrock") {
      responseText = await invokeBedrock(config.client, config.modelId, promptText, userContent, maxTokens);
    } else {
      const apiUrl = config.provider === "mistral" ? MISTRAL_API_URL : GREENPT_API_URL;
      responseText = await invokeOpenAICompatible(apiUrl, config.apiKey, config.modelId, promptText, userContent, maxTokens);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emails.map((e) => ({ id: e.id, error: message }));
  }

  return parseClassificationResponse(responseText, emails);
}
