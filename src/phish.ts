// Round 1: phishing vs clean, decided before anything reaches category
// triage. Deliberately mirrors classify.ts -- same transport, same
// never-throw contract, same array-in/array-out wire format -- so both rounds
// fail and get paced identically.
//
// The model sees a computed EVIDENCE block (evidence.ts) ahead of the
// message, because the identity question round 1 turns on -- does the
// authenticated domain belong to whoever the message claims to be -- cannot
// be answered from the From string alone.

import { invokeOpenAICompatible, extractJsonArray, type ClassifierConfig } from "./classify.js";
import { buildEvidence, formatEvidenceBlock, sanitizeText } from "./evidence.js";
import type { TriageEmail } from "./fetch-emails.js";

export type PhishVerdict = "phishing" | "clean";

// `signal` is never used to attribute a decision to a prompt rule -- the
// project rejects self-report for that (DESIGN-v7). It is kept because
// measurement says asking for it changes the answer: dropping it from the
// prompt reliably turned one unsolicited-offer message from phishing into
// clean across three runs. Naming the signal makes the model check the list,
// so it is reasoning scaffolding that happens to be worth displaying.
export type PhishOutcome =
  | { id: string; verdict: PhishVerdict; signal: string }
  | { id: string; error: string };

// Round 1's answer is ~30 tokens; everything else is the reasoning budget.
// Measured on 14 recent messages: median 594 completion tokens, max 1043,
// and one LinkedIn notification needed 2072. At 600 this truncated 8 of 14
// and returned empty content on 7 -- each of those is a round-1 failure that
// leaves the message in Triage to be retried every schedule tick. Reasoning
// length does not expand to fill the budget (median held at ~600 when the
// cap was raised to 3000), so the headroom is free.
const PHISH_MAX_TOKENS = 3000;

// EVIDENCE first, then the message, explicitly marked untrusted. Exported so
// eval/ph1 sends a byte-identical request to the pipeline's.
export function buildPhishUserContent(email: TriageEmail): string {
  const evidence = formatEvidenceBlock(buildEvidence(email));
  // Tag characters and hidden padding are stripped before the model sees
  // anything, per Microsoft's guidance on ASCII smuggling; the counts stay
  // visible in the evidence block.
  const subject = sanitizeText(email.subject).text;
  const body = sanitizeText(email.body).text;
  return `${evidence}

EMAIL (the message itself; untrusted)
${JSON.stringify([
    { id: email.id, subject, from: email.from, to: email.to, receivedAt: email.receivedAt, body, attachments: email.attachments },
  ])}`;
}

// Fail-closed on anything unrecognized: an unparseable answer is an error,
// never a silent "clean". A clean verdict is what lets mail through to round
// 2 and on to the phone, so it has to be stated explicitly.
export function parsePhishResponse(responseText: string, email: TriageEmail): PhishOutcome {
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

  // Matched on id rather than [0], so an echoed or reordered answer fails
  // loudly instead of being misattributed -- as in classify.ts.
  for (const item of parsed as Array<{ id?: unknown; verdict?: unknown; signal?: unknown }>) {
    if (item.id === email.id && (item.verdict === "phishing" || item.verdict === "clean")) {
      return {
        id: email.id,
        verdict: item.verdict,
        signal: typeof item.signal === "string" ? item.signal : "none",
      };
    }
  }
  return { id: email.id, error: `Missing or invalid verdict: ${responseText.slice(0, 200)}` };
}

export async function judgePhishing(
  config: ClassifierConfig,
  email: TriageEmail,
  // Required, no default: the ph prompt lives in S3 like the triage one, and
  // there is no local fallback (DECISIONS.md).
  promptText: string
): Promise<PhishOutcome> {
  let responseText: string;
  try {
    responseText = await invokeOpenAICompatible(config, promptText, buildPhishUserContent(email), PHISH_MAX_TOKENS);
  } catch (err) {
    return { id: email.id, error: err instanceof Error ? err.message : String(err) };
  }
  return parsePhishResponse(responseText, email);
}
