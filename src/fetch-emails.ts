// Fetches classification input from Inbox/Triage. `preview` is fetched for
// Pushover notification bodies, not for classification.

import { convert as htmlToText } from "html-to-text";
import { CORE, MAIL, jmapRequest, type Session } from "./jmap-session.js";

// Server-side cap, passed to Email/get rather than sliced client-side: JMAP
// truncates on a valid UTF-8 boundary.
const MAX_BODY_VALUE_BYTES = 4000;
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

const EMAIL_GET_PROPERTIES = ["subject", "from", "to", "receivedAt", "textBody", "htmlBody", "attachments", "preview"];
const EMAIL_GET_BODY_PROPERTIES = ["partId", "type", "name", "disposition"];

function toTriageEmail(m: any): TriageEmail {
  return {
    id: m.id,
    subject: m.subject ?? "",
    from: formatAddresses(m.from),
    to: formatAddresses(m.to),
    receivedAt: m.receivedAt ?? "",
    body: extractBodyText(m),
    attachments: extractAttachmentNames(m),
    preview: m.preview ?? "",
  };
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
  ]);

  const emailGet = data.methodResponses.find((m: any) => m[2] === "b")?.[1];
  if (!emailGet) {
    throw new Error(`Unexpected JMAP response: ${JSON.stringify(data, null, 2)}`);
  }

  return (emailGet.list as any[]).map(toTriageEmail);
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
  ]);

  const emailGet = data.methodResponses.find((m: any) => m[2] === "a")?.[1];
  if (!emailGet) {
    throw new Error(`Unexpected JMAP response: ${JSON.stringify(data, null, 2)}`);
  }

  return (emailGet.list as any[]).map(toTriageEmail);
}
