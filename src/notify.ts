// Pushover notification for a successfully-moved email. See
// triage.ts-DESIGN-v5-2026-08-02.md §3.4.

import type { PushoverConfig } from "./config.js";
import type { Destination } from "./actions.js";
import type { TriageEmail } from "./fetch-emails.js";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

// v7: a single notify tier, driven entirely by the model's own `notify`
// field (see classify.ts / prompt.ts v7) -- not by category. There is
// deliberately no category gate here: prompt.ts's NOTIFY section is what
// keeps e.g. suspicious mail from pushing, not this code. Priority 0
// (normal) was specified by the user, not derived.
const PUSHOVER_PRIORITY = 0;

// Deep link uses the destination mailbox's full path and the bare emailId
// -- verified live against a real nested mailbox
// (https://app.fastmail.com/mail/Inbox/Triage/StnVqnj87Erc uses the full
// "Inbox/Triage" path, not a leaf name; the request's original example used
// a threadId.emailId composite, which v5 deliberately doesn't use -- see
// design doc §3.4/§5).
function buildFastmailUrl(email: TriageEmail, destination: Destination): string {
  return `https://app.fastmail.com/mail/${destination.path}/${email.id}`;
}

// Non-fatal by design: a Pushover failure is logged by the caller and the
// run continues -- notification delivery isn't critical enough to abort a
// run that already committed real mailbox moves.
export async function sendPushoverNotification(
  config: PushoverConfig,
  email: TriageEmail,
  destination: Destination
): Promise<void> {
  const body = new URLSearchParams({
    token: config.token,
    user: config.user,
    title: email.subject || "(no subject)",
    message: `${email.from}\n${email.preview}`,
    priority: String(PUSHOVER_PRIORITY),
    url: buildFastmailUrl(email, destination),
    url_title: "Open in Fastmail",
  });

  const res = await fetch(PUSHOVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Pushover request failed: ${res.status} ${await res.text()}`);
  }
}
