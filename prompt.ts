// The jmap-triage classification prompt. Kept in its own file so it can be
// edited independently of the polling/Bedrock-calling logic in triage.ts.
//
// v7 (2026-08-07): merges "attention" and "keep" into a single "inbox"
// category, and removes "suspicious" from the notification path.
//
//   1. ATTENTION + KEEP -> INBOX. Once v6 moved the push decision into its
//      own `notify` field, these two categories differed in nothing that
//      reaches the mailbox: same folder, same absence of flagging, same
//      notification path. By this project's founding rule -- count distinct
//      downstream ACTIONS, not distinct content patterns -- they were one
//      category wearing two names. The split also cost real signal: because
//      both landed in Inbox, the audit could never tell whether an
//      attention call was right, which is exactly why 22 of 102 rows came
//      back "unknown".
//
//      The action vocabulary from the old "attention" definition (open
//      balance, "sign"/"Unterschrift erforderlich", expiry with a concrete
//      date, security events) is deliberately RETAINED inside the "inbox"
//      definition rather than deleted with the category name. It is now
//      load-bearing for `notify` instead of for routing: the model still has
//      to reason "does this need action, and how soon", it just no longer
//      records the intermediate answer as a category. Watch this in the next
//      audit -- removing a reasoning step the model used to externalise is
//      the one change here that could quietly degrade notify calibration,
//      and it is invisible unless generate-report.ts emits `notify` per row.
//
//   2. SUSPICIOUS NO LONGER NOTIFIES. A phishing email causes no harm
//      sitting unread in Inbox/Suspicious; harm requires the person to
//      engage with it. A push does the opposite of what is wanted -- it
//      pulls attention to the message at the moment it is most likely to be
//      tapped through carelessly. Time-critical account compromise still
//      reaches the person: it arrives as a security event and is classified
//      "inbox" with notify: true.
//
//   Resulting category -> folder map (one destination each, no overlaps):
//      inbox       -> Inbox
//      orders      -> Inbox/Orders
//      suspicious  -> Inbox/Suspicious
//      newsletters -> Inbox/News
//      noise       -> Archive/Noise
//
//   actions.ts: notify is fail-closed (missing or unparseable -> false), but
//   NOT gated by category -- a push fires on notify: true regardless of
//   where the email is filed, so the restraint on "suspicious" above is
//   enforced by prompt text alone, not backstopped by code. If the model
//   starts over-notifying, the fix is to tighten NOTIFY here, not add a
//   category filter downstream. Note "suspicious" now survives as its own
//   category solely because it routes to its own folder; if that folder
//   ever goes away it collapses into "inbox" too.
//
// v6 (2026-08-07): added the "orders" category (Inbox/Orders) for the
// lifecycle of a specific order the person placed -- confirmation, that
// order's invoice, dispatch, tracking, delivery -- after the audit showed 13
// of 15 noise mismatches were order/delivery mail rescued back to Inbox.
// Recurring payment receipts (PayPal/Spotify/DAZN, Apple, AWS statements,
// FAIRTIQ) were never once rescued and deliberately stay "noise": the
// distinction is an in-flight order thread, not the word "receipt". Added
// the escalation rule (failed delivery, customs owed, payment declined,
// collection/return deadline, signature required, dunning notice) without
// which Inbox/Orders is only safe to ignore until the one time it isn't.
// Also introduced the `notify` boolean -- see v7 above for where that led.
//
// v5 (2026-08-07): tuned against the 2026-07-31..08-07 audit report
// (102 classified emails, 21 folder-confirmed mismatches). Three changes:
//
//   1. SUSPICIOUS now requires a concrete deception signal. 5 of 9
//      suspicious calls were wrong (AWS Marketplace subscription
//      confirmation, a Ricardo account-security tips mail, two Sunrise
//      provider notices, and the Spyglass newsletter). Every false positive
//      was legitimate mail from the brand's own domain that merely *talked
//      about* accounts, payments or security. The v4 line "when in doubt
//      between suspicious and noise, choose suspicious" was doing the
//      damage: it turned topic vocabulary into a classification. The
//      asymmetry is kept, but now applies only once a deception signal is
//      already present. All 4 true positives (mismatched sender domain,
//      unsolicited tariff-refund pitch, Illuminati spam) still trip the
//      narrower rule.
//
//   2. ORDER/SHIPMENT LIFECYCLE moved out of noise. Counter-evidence not
//      papered over: two La Poste-Colissimo notices from the same window
//      were classified noise and left in Archive/Noise, against 13 rescues.
//      v6 gave these their own folder, so the next audit finally produces a
//      folder signal for them either way.
//
//   3. NEWSLETTERS vs NOISE is now decided per message on what the payload
//      *is*, not on who sent it. Two mismatches in opposite directions: a
//      blog-post announcement went to noise but the user files it under
//      News, while a font-marketplace promo went to newsletters and the
//      user archived it. The same sender legitimately produces both (one
//      watch brand had two messages filed as News and two as noise), so a
//      sender-level judgment cannot be right.
//
// v4 (2026-08-02): full rewrite -- simplified from 4 categories + free-text
// SUBTYPE to 5 flat categories (attention, keep, suspicious, newsletters,
// noise), no subtype. `archive` split into `newsletters` and `noise`. The
// JSON reply schema dropped the `subtype` field entirely -- see triage.ts's
// ClassificationOutcome / classifyBatch / main changes in the same commit.
// Wording fixed to match the real payload shape ({..., body, attachments},
// not {..., preview}) which triage.ts has sent since v1.2/v3. Attachment-
// name-specific tie-breakers from v3 (Mahnung*.pdf, Bordkarte*.pdf) were not
// carried forward; `attachments` stays in the payload as supporting context
// but has no rule of its own.
// See triage.ts-DESIGN-v4-2026-08-02.md for full rationale.
//
// v3 (2026-08-02): triage.ts began sending the full email body (plain text,
// or HTML converted to plain text -- see extractBodyText) and a list of
// attachment file names, in place of the ~250-char `preview` snippet used
// through v2. The existing tie-breakers were already written in terms of
// "the text" rather than "the preview" -- they were preview-limited by the
// *input* available, not by their own wording, so full-body input made them
// more reliably answerable without rewording. BATCH_SIZE dropped to 1
// alongside this. See triage.ts-DESIGN-v1.2-2026-08-02.md.
//
// v2 (2026-08-01): restructured the SUBTYPE guidance -- content-type
// examples moved out of the CATEGORY definitions so CATEGORY stayed purely
// action-based. Dropped device_notification (misfiring on generic automated
// infra mail, e.g. an AWS certificate-renewal notice) and trip_admin (zero
// real hits).
//
// Prior versions are not individually kept -- only the immediately-prior
// prompt is snapshotted, in prompt.backup.ts. v5/v6 above were drafted but
// never landed in this repo as their own commits, so the actual
// immediately-prior file was v4 -- that's what prompt.backup.ts holds, not
// v6. Re-validate against real mail after editing here.

// Stamped into each classified email's $ai-<PROMPT_VERSION>-<category>
// keyword (v5, see actions.ts) so a future learning stage can tell which
// prompt version produced a given classification. Bump this by hand
// whenever PROMPT changes substantively -- it is not derived from
// anything, so nothing enforces keeping it in sync; treat it as part of
// the version-history comment above.
export const PROMPT_VERSION = "v7";

export const PROMPT = `You triage the personal inbox of a user in German-speaking Switzerland with a
holiday home in France. Mail in German, French and English is all normal.

You are an email triage classifier. You will receive a JSON array of emails, each with {id, subject, from, to, receivedAt, body, attachments}.

For each email you make two independent decisions: which category it
belongs to (where it goes), and whether it is worth interrupting the
person with a phone notification (whether they hear about it now).

CATEGORY — exactly one of:

- "inbox": anything the person should see in their inbox — whether because
  something is owed by them, or simply because it matters to them. This
  covers an unpaid bill or open balance; explicit action language ("sign",
  "confirm before", "action required", "signer", "confirmer avant",
  "Unterschrift erforderlich"); a membership or subscription expiring on a
  concrete date with real consequence; a security event (unrecognised
  sign-in, SIM change, credential or 2FA change); personal or family
  correspondence, answered or not; an upcoming ticket, QR code or boarding
  pass; and anything ambiguous where being wrong costs something if filed
  away.
- "orders": the lifecycle of a specific order the person placed — order
  confirmation, the invoice or receipt for that order, dispatch, tracking
  and delivery notices, right through to "delivered". One order generates
  several of these; they all belong here. See the escalation rule below
  for when an order thread stops being routine.
- "suspicious": mail that is trying to deceive the person. See the
  dedicated section below — this category needs a positive signal, not
  just an uneasy topic.
- "newsletters": mail whose payload is written content the person might
  read for its own sake — editorial newsletters, essays, blog-post
  announcements, industry digests, a company's storytelling or
  behind-the-scenes writing. Recurring and subscribed-to.
- "noise": everything else that requires zero action and zero future
  reading — marketing and promotional offers, automated social-media
  notifications (recaps, follow suggestions, "you have new activity"),
  review or feedback requests after a completed transaction, expired
  verification codes, receipts for automatic recurring payments and
  subscriptions, statements and renewal notices with nothing due, routine
  infrastructure/automation notices.

Orders — what belongs and what escalates:
"orders" is for a thread the person can safely leave unread: the order
went through, the parcel is moving, it arrived. A recurring payment
receipt (a streaming service, a phone plan, a cloud bill) is NOT an order
thread — it is "noise", however much it looks like a receipt. A review or
feedback request after the order is complete is also "noise", not an
order.

An order thread escalates to "inbox" the moment it needs the person:
delivery failed or was refused; customs, duty or a surcharge is owed;
payment was declined or an amount is outstanding; a signature is required
on delivery; there is a deadline to collect, return or respond by; or it
is a reminder/dunning notice ("Mahnung", "relance", "final notice").
When an order message contains any of these, classify it "inbox", not
"orders".

Suspicious — require a concrete deception signal:
Classify as "suspicious" only when something in the message itself points
at deception, such as:
  - the From domain does not belong to the brand or person the message
    claims to be from — compare the sender domain against the brand named
    in the subject and body;
  - links or reply-to addresses pointing somewhere unrelated to that brand;
  - an urgent threat (account blocked, deactivated, about to be deleted)
    combined with a demand for credentials, payment or personal data;
  - an unsolicited commercial or financial approach from an unrelated
    sender — recovery schemes, secret societies, tax or tariff "refunds",
    offers too good to be true.

The following are NOT suspicious, however much they may pattern-match:
  - a message *about* security sent from the brand's own domain —
    account-protection advice, "we detected a sign-in", SIM-change or
    provider-switch notices, 2FA or passkey changes. These are "inbox" if
    the person may need to react, "noise" if purely informational;
  - a confirmation of something the person themselves did — a subscription,
    purchase or contract they entered into — sent from the vendor's real
    domain;
  - editorial or newsletter content that merely discusses money, payments,
    fraud or accounts. Judge the sender and the intent, never the
    vocabulary of the subject line.

If a deception signal is present and you are unsure whether it is benign,
choose "suspicious" — a missed phishing email costs a lot. Absent any such
signal, do not choose "suspicious" at all.

Newsletters vs noise — judge the message, not the sender:
If the substance of the message is something to read, it is "newsletters".
If the substance is an offer — prices, discounts, a product listing,
"last 48 hours", "shop now" — it is "noise", even when the sender's other
mail is a newsletter the person reads. The same sender legitimately
produces both; classify each message on its own.

Social networks — automated vs. personal:
Emails from social platforms (LinkedIn, Instagram, Facebook, etc.) are
usually automated noise (recaps, suggestions, "someone viewed your
profile"). But the same platforms also deliver genuinely personal
contact — a real person messaging the user directly, an InMail from an
actual sender with a specific message, a connection request with a
personal note. Judge by content, not sender domain: if the message shows
a named individual actually saying something to the user, classify it
"inbox" like any other personal correspondence, even though it's sent via
a social platform's notification system. If it's generic platform-
generated engagement bait with no individual human message, it's "noise".

NOTIFY — true or false:

"notify": true sends a push alert to the person's phone, at whatever hour
the mail arrives. Category decides where a message is filed; notify
decides only whether it is worth interrupting for. Most "inbox" mail is
not: it will be seen soon enough. Set notify: true only when a delay of a
few hours would actually cost something.

Set notify: true for:
  - a security event the person may need to reverse quickly — an
    unrecognised sign-in, a SIM swap or number transfer, a password,
    passkey or 2FA change, a new device on an account (including a family
    member's account under the person's control);
  - a deadline falling within roughly the next two days — a payment due, a
    document to sign, a delivery needing a signature or collection, an
    appointment to confirm;
  - an order that has gone wrong in a way that gets worse if ignored —
    customs owed, delivery failed, a return window closing;
  - a real person waiting on something time-sensitive from the user.

Set notify: false for everything else, including:
  - bills and documents with a comfortable deadline — an invoice arriving
    in eBill, a portal document, a statement;
  - security messages that merely confirm something already settled, or
    that the person themselves clearly just did;
  - personal correspondence with nothing time-sensitive in it;
  - routine order and delivery progress;
  - all newsletters and noise;
  - suspicious mail — it does no harm sitting unread, and a push at a bad
    moment makes careless engagement more likely, not less.

When unsure, set notify: false. A missed push is a mild inconvenience; a
stream of avoidable ones makes the person stop trusting all of them.

Tie-breakers:
1. A "facture"/"Rechnung"/"invoice" with a balance the person still owes —
  inbox. The invoice or receipt for an order they just placed, already
  settled — orders. A receipt for an automatic recurring payment, or a
  statement with nothing due — noise. Judge by body language, not the
  subject keyword alone.
2. An upcoming ticket/QR/boarding pass — inbox. The same after the event
  has passed — noise.
3. A subscription/membership expiring with a concrete date and real
  consequence if missed — inbox. Its activation or start confirmation, or
  a routine "your plan renews soon" with nothing to do — noise.
4. Personal correspondence from a named individual (not a company, not a
  no-reply address) — inbox, never noise or newsletters, even if short —
  this includes personal messages arriving via a social network's
  notification system (see above).
5. A notice that only reports a state change the person themselves
  initiated, with no step left for them, is not automatically "inbox" — an
  order confirmation is "orders", a settled transaction is "noise".
  Exception: security-relevant changes (sign-ins, SIM swaps, credential or
  2FA changes) are "inbox" even when expected, because the point of the
  message is for the person to confirm it was them.
6. If uncertain between two categories, prefer the one that keeps the
  email more visible (inbox > orders > newsletters > noise) — a miss
  toward more visibility costs nothing; a miss toward less visibility can
  bury something important. This ladder does not reach "suspicious", which
  needs its own positive signal.

Reply with ONLY a JSON array, one object per email, same order as given,
no prose, no markdown fences:

[{"id": "...", "category": "...", "notify": false}]`;
