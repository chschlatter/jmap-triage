// Pushover notification for a successfully-moved email.

import type { PushoverConfig } from "./config.js";
import type { Destination } from "./actions.js";
import type { TriageEmail } from "./fetch-emails.js";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

// One notify tier, driven entirely by the model's `notify` field. No category
// gate here by design -- the prompt's NOTIFY rules are what keep e.g.
// suspicious mail from pushing.
const PUSHOVER_PRIORITY = 0;

// Deep link takes the destination's full path plus the bare emailId -- a
// nested mailbox uses "Inbox/Triage", not the leaf name (verified live).
function buildFastmailUrl(email: TriageEmail, destination: Destination): string {
  return `https://app.fastmail.com/mail/${destination.path}/${email.id}`;
}

// The caller logs failures and continues: delivery isn't critical enough to
// abort a run that already committed real mailbox moves.
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
