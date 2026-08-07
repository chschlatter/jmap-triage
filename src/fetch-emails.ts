// Fetches classification input from Inbox/Triage. Relocated from triage.ts
// (v4) verbatim except for one addition: the JMAP `preview` property, needed
// for Pushover notification bodies (v5) but not used for classification
// itself -- see triage.ts-DESIGN-v5-2026-08-02.md §3.1/§3.4.

import { convert as htmlToText } from "html-to-text";
import { CORE, MAIL, jmapRequest, type Session } from "./jmap-session.js";

// Server-side cap on each body part's returned text (JMAP truncates on a
// valid UTF-8 boundary, so this is applied in the Email/get request itself
// rather than sliced client-side after a full fetch).
const MAX_BODY_VALUE_BYTES = 4000;
// Defends against a pathological attachments list (e.g. a newsletter with
// dozens of inline images all marked as attachments) eating into the token
// budget for no classification benefit.
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
}

function formatAddresses(addrs: Array<{ name?: string | null; email: string }> | null | undefined): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs.map((a) => a.email).join(", ");
}

function withTruncationMarker(text: string, isTruncated: boolean | undefined): string {
  return isTruncated ? `${text}\n...[truncated]` : text;
}

// Prefers a genuine text/plain part; falls back to converting text/html to
// plain text (many transactional/marketing mail is HTML-only). Per RFC 8621
// SS4.1.4, when a message has no text/plain part, servers may return the
// text/html part itself inside `textBody` -- so a part in `textBody` isn't
// necessarily text/plain, and `type` has to be checked either way.
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

// Drops inline/CID assets (signature logos, tracking-pixel-adjacent images)
// that aren't attachments a human would recognize as such, and caps the
// count so one pathological email can't eat the token budget.
function extractAttachmentNames(m: any): string[] {
  const attachments: Array<{ name?: string | null; disposition?: string | null }> = m.attachments ?? [];
  return attachments
    .filter((a) => a.disposition !== "inline" && a.name)
    .map((a) => a.name as string)
    .slice(0, MAX_ATTACHMENTS);
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
        properties: ["subject", "from", "to", "receivedAt", "textBody", "htmlBody", "attachments", "preview"],
        bodyProperties: ["partId", "type", "name", "disposition"],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
      },
      "b",
    ],
  ]);

  const emailGet = data.methodResponses.find((m: any) => m[2] === "b")?.[1];
  if (!emailGet) {
    throw new Error(`Unexpected JMAP response: ${JSON.stringify(data, null, 2)}`);
  }

  return (emailGet.list as any[]).map((m) => ({
    id: m.id,
    subject: m.subject ?? "",
    from: formatAddresses(m.from),
    to: formatAddresses(m.to),
    receivedAt: m.receivedAt ?? "",
    body: extractBodyText(m),
    attachments: extractAttachmentNames(m),
    preview: m.preview ?? "",
  }));
}
