// Fetches classification input from Inbox/Triage. `preview` is fetched for
// Pushover notification bodies, not for classification.

import { convert as htmlToText } from "html-to-text";
import { CORE, MAIL, jmapRequest, type Session } from "./jmap-session.js";

// Server-side cap, passed to Email/get rather than sliced client-side: JMAP
// truncates on a valid UTF-8 boundary.
const MAX_BODY_VALUE_BYTES = 4000;
// Evidence reads the HTML part separately and much further in. Marketing HTML
// routinely spends its first several kB on head, CSS and an invisible
// preheader, so at 4000 bytes most messages yielded no links at all. This
// budget is never sent to the model -- only link and hidden-text facts are
// derived from it -- so it costs bandwidth, not tokens.
const MAX_EVIDENCE_HTML_BYTES = 60_000;
// Keeps a pathological attachment list (a newsletter with dozens of inline
// images) from eating the token budget for no classification benefit.
const MAX_ATTACHMENTS = 10;

export interface TriageEmail {
  id: string;
  subject: string;
  from: string;
  to: string;
  receivedAt: string;
  body: string;
  attachments: string[];
  preview: string;
  raw?: EmailRaw;
}

// Round-1 inputs, consumed only by evidence.ts. Optional because the
// golden-set fixtures build TriageEmail literals by hand; a required field
// would break all of them.
export interface EmailRaw {
  fromName: string;
  replyTo: string;
  rawHtml: string;
  // Fastmail splits its Authentication-Results across several header
  // instances, so this is every instance, in order -- evidence.ts merges the
  // ones whose authserv-id is Fastmail's own.
  authResults: string[];
  icloudHme: string | null;
  returnPath: string | null;
  spamScore: string | null;
  spamHits: string | null;
  spamKnownSender: string | null;
  spamReputation: string | null;
}

function formatAddresses(addrs: Array<{ name?: string | null; email: string }> | null | undefined): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs.map((a) => a.email).join(", ");
}

function withTruncationMarker(text: string, isTruncated: boolean | undefined): string {
  return isTruncated ? `${text}\n...[truncated]` : text;
}

// Prefers a real text/plain part, else converts text/html (most marketing
// mail is HTML-only). Per RFC 8621 SS4.1.4 a server may put the text/html
// part inside `textBody`, so `type` has to be checked either way.
function extractBodyText(m: any): string {
  const bodyValues: Record<string, { value: string; isTruncated?: boolean }> = m.bodyValues ?? {};
  const textParts: Array<{ partId: string; type: string }> = m.textBody ?? [];
  const htmlParts: Array<{ partId: string; type: string }> = m.htmlBody ?? [];

  const plainPart = textParts.find((p) => p.type === "text/plain" && bodyValues[p.partId]);
  if (plainPart) {
    const bv = bodyValues[plainPart.partId];
    return withTruncationMarker(bv.value, bv.isTruncated);
  }

  const htmlPart =
    textParts.find((p) => p.type === "text/html" && bodyValues[p.partId]) ??
    htmlParts.find((p) => bodyValues[p.partId]);
  if (!htmlPart) return "";

  const bv = bodyValues[htmlPart.partId];
  return withTruncationMarker(htmlToText(bv.value, { wordwrap: false }), bv.isTruncated);
}

// Drops inline/CID assets (signature logos, tracking pixels) -- not
// attachments a human would recognize as such.
function extractAttachmentNames(m: any): string[] {
  const attachments: Array<{ name?: string | null; disposition?: string | null }> = m.attachments ?? [];
  return attachments
    .filter((a) => a.disposition !== "inline" && a.name)
    .map((a) => a.name as string)
    .slice(0, MAX_ATTACHMENTS);
}

// The unconverted text/html part. extractBodyText prefers text/plain, where
// anchor text and href have already been flattened away, so link evidence has
// to come from here instead.
function extractRawHtml(m: any): string {
  const bodyValues: Record<string, { value: string }> = m.bodyValues ?? {};
  const part =
    (m.textBody ?? []).find((p: any) => p.type === "text/html" && bodyValues[p.partId]) ??
    (m.htmlBody ?? []).find((p: any) => bodyValues[p.partId]);
  return part ? bodyValues[part.partId].value : "";
}

// `bodyValues` has to be listed explicitly: Fastmail honours the properties
// list strictly and returns no bodyValues without it, whatever
// fetchTextBodyValues says -- which silently emptied every classified body.
const EMAIL_GET_PROPERTIES = [
  "subject",
  "from",
  "to",
  "receivedAt",
  "textBody",
  "htmlBody",
  "bodyValues",
  "attachments",
  "preview",
  "replyTo",
  // :all because Fastmail emits Authentication-Results four times per
  // message, one group of methods each.
  "header:Authentication-Results:asText:all",
  "header:X-Icloud-Hme:asText",
  "header:Return-Path:asText",
  "header:X-Spam-score:asText",
  "header:X-Spam-hits:asText",
  "header:X-Spam-known-sender:asText",
  "header:X-Spam-sender-reputation:asText",
];
const EMAIL_GET_BODY_PROPERTIES = ["partId", "type", "name", "disposition"];

function toEmailRaw(m: any, html: string): EmailRaw {
  return {
    fromName: m.from?.[0]?.name ?? "",
    replyTo: formatAddresses(m.replyTo),
    rawHtml: html,
    authResults: m["header:Authentication-Results:asText:all"] ?? [],
    icloudHme: m["header:X-Icloud-Hme:asText"] ?? null,
    returnPath: m["header:Return-Path:asText"] ?? null,
    spamScore: m["header:X-Spam-score:asText"] ?? null,
    spamHits: m["header:X-Spam-hits:asText"] ?? null,
    spamKnownSender: m["header:X-Spam-known-sender:asText"] ?? null,
    spamReputation: m["header:X-Spam-sender-reputation:asText"] ?? null,
  };
}

function toTriageEmail(m: any, htmlById: Map<string, string>): TriageEmail {
  return {
    id: m.id,
    subject: m.subject ?? "",
    from: formatAddresses(m.from),
    to: formatAddresses(m.to),
    receivedAt: m.receivedAt ?? "",
    body: extractBodyText(m),
    attachments: extractAttachmentNames(m),
    preview: m.preview ?? "",
    raw: toEmailRaw(m, htmlById.get(m.id) ?? extractRawHtml(m)),
  };
}

// The second Email/get in each request: the HTML part alone, at the evidence
// budget. maxBodyValueBytes is per-request, so it takes its own call -- but
// it rides along in the same round trip.
function evidenceHtmlCall(accountId: string, ids: unknown, callId: string) {
  return [
    "Email/get",
    { accountId, ...(ids as object), properties: ["id", "htmlBody", "bodyValues"], bodyProperties: ["partId", "type"], fetchHTMLBodyValues: true, maxBodyValueBytes: MAX_EVIDENCE_HTML_BYTES },
    callId,
  ];
}

function htmlMapFrom(data: any, callId: string): Map<string, string> {
  const list: any[] = data.methodResponses.find((m: any) => m[2] === callId)?.[1]?.list ?? [];
  return new Map(list.map((m) => [m.id, extractRawHtml(m)]));
}

export async function fetchTriageEmails(session: Session, mailboxId: string, limit: number): Promise<TriageEmail[]> {
  const data = await jmapRequest(session, [CORE, MAIL], [
    [
      "Email/query",
      {
        accountId: session.accountId,
        filter: { inMailbox: mailboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
      },
      "a",
    ],
    [
      "Email/get",
      {
        accountId: session.accountId,
        "#ids": { resultOf: "a", name: "Email/query", path: "/ids" },
        properties: EMAIL_GET_PROPERTIES,
        bodyProperties: EMAIL_GET_BODY_PROPERTIES,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
      },
      "b",
    ],
    evidenceHtmlCall(session.accountId, { "#ids": { resultOf: "a", name: "Email/query", path: "/ids" } }, "c"),
  ]);

  const emailGet = data.methodResponses.find((m: any) => m[2] === "b")?.[1];
  if (!emailGet) {
    throw new Error(`Unexpected JMAP response: ${JSON.stringify(data, null, 2)}`);
  }

  const htmlById = htmlMapFrom(data, "c");
  return (emailGet.list as any[]).map((m) => toTriageEmail(m, htmlById));
}

// By id, wherever the message currently lives -- evaluate.ts's replay needs
// bodies from outside Inbox/Triage. A deleted or inaccessible id is simply
// absent from the result rather than failing the call.
export async function fetchEmailsByIds(session: Session, ids: string[]): Promise<TriageEmail[]> {
  if (ids.length === 0) return [];

  const data = await jmapRequest(session, [CORE, MAIL], [
    [
      "Email/get",
      {
        accountId: session.accountId,
        ids,
        properties: EMAIL_GET_PROPERTIES,
        bodyProperties: EMAIL_GET_BODY_PROPERTIES,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
      },
      "a",
    ],
    evidenceHtmlCall(session.accountId, { ids }, "b"),
  ]);

  const emailGet = data.methodResponses.find((m: any) => m[2] === "a")?.[1];
  if (!emailGet) {
    throw new Error(`Unexpected JMAP response: ${JSON.stringify(data, null, 2)}`);
  }

  const htmlById = htmlMapFrom(data, "b");
  return (emailGet.list as any[]).map((m) => toTriageEmail(m, htmlById));
}
