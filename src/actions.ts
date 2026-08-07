// The action stage: maps a classification to a destination mailbox and
// moves the email there via a JMAP Email/set patch. See
// triage.ts-DESIGN-v5-2026-08-02.md §2, §3.3.

import { CORE, MAIL, jmapRequest, type Session } from "./jmap-session.js";
import { MAILBOX_SPECS, type MailboxRefs } from "./mailboxes.js";
import type { TriageEmail } from "./fetch-emails.js";
import type { ClassificationOutcome } from "./classify.js";
import { PROMPT_VERSION } from "../prompt.js";

// Below typical JMAP server maxObjectsInSet limits -- confirm against
// session.capabilities["urn:ietf:params:jmap:core"].maxObjectsInSet if this
// is ever raised.
const WRITE_BATCH_SIZE = 50;

export interface Destination {
  mailboxId: string;
  // Full path, matching the Fastmail web UI's deep-link URL segment for a
  // nested mailbox (verified live -- see notify.ts and
  // triage.ts-DESIGN-v5-2026-08-02.md §3.4).
  path: string;
}

// Derived from MAILBOX_SPECS (mailboxes.ts) instead of a hand-written
// record literal -- that table is the single place a category's mailbox is
// named, so this function can't drift out of sync with it. v7: "attention"
// and "keep" collapsed into "inbox" -- once the `notify` field carried
// urgency on its own, the two categories no longer differed in any
// downstream action (see prompt.ts v7 §1). "orders" is new, for the
// lifecycle of a placed order; it gets its own mailbox for the same reason
// suspicious does: the $ai-* keyword it also carries isn't surfaced
// anywhere in the Fastmail UI, so without a distinct destination there was
// no in-reader indicator that an email had been flagged -- only the
// Pushover ping, which is easy to miss after the fact. Mapping specified by
// the user, not derived; see design doc §2/§5.
export function destinationsFor(mailboxes: MailboxRefs): Record<string, Destination> {
  const destinations: Record<string, Destination> = {};
  for (const spec of MAILBOX_SPECS) {
    if (!spec.category) continue;
    destinations[spec.category] = { mailboxId: mailboxes[spec.key], path: spec.path.join("/") };
  }
  return destinations;
}

export interface PlannedAction {
  email: TriageEmail;
  category: string;
  notify: boolean;
  destination: Destination;
  // $ai-<promptVersion>-<category>, e.g. "$ai-v7-inbox". Stamped on the
  // email as a keyword at move time so a future learning stage can compare
  // this original classification against wherever the email ends up after
  // the user files it manually -- independent of PlannedAction.destination,
  // which only reflects where the AI filed it just now. See
  // triage.ts-DESIGN-v5-2026-08-02.md §3.6.
  keyword: string;
  // $ai-<promptVersion>-notified, present only when notify is true (absent
  // = false, same fail-closed convention as everywhere else -- see
  // classify.ts). Records that this email was flagged for a push, not that
  // Pushover delivery actually succeeded; those are different failure
  // modes and main.ts's notify stage can fail independently of this. Added
  // in v7 because `notify` was otherwise the one decision in the pipeline
  // that left no trace in the mailbox once the email moved out of Triage.
  notifiedKeyword: string;
}

export interface SkippedEmail {
  email: TriageEmail;
  reason: string;
}

function aiKeywordFor(category: string): string {
  return `$ai-${PROMPT_VERSION}-${category}`;
}

function aiNotifiedKeyword(): string {
  return `$ai-${PROMPT_VERSION}-notified`;
}

// Pure planning step -- no writes. A classification failure, or a category
// string the mapping doesn't recognize, is skipped rather than moved: the
// email is simply left in Inbox/Triage for the next run (or a human) to
// deal with.
export function planActions(
  emails: TriageEmail[],
  outcomes: ClassificationOutcome[],
  destinations: Record<string, Destination>
): { planned: PlannedAction[]; skipped: SkippedEmail[] } {
  const emailById = new Map(emails.map((e) => [e.id, e]));
  const planned: PlannedAction[] = [];
  const skipped: SkippedEmail[] = [];

  for (const outcome of outcomes) {
    const email = emailById.get(outcome.id);
    if (!email) continue;

    if ("error" in outcome) {
      skipped.push({ email, reason: outcome.error });
      continue;
    }

    const destination = destinations[outcome.category];
    if (!destination) {
      skipped.push({ email, reason: `Unknown category "${outcome.category}"` });
      continue;
    }

    planned.push({
      email,
      category: outcome.category,
      notify: outcome.notify,
      destination,
      keyword: aiKeywordFor(outcome.category),
      notifiedKeyword: aiNotifiedKeyword(),
    });
  }

  return { planned, skipped };
}

export interface MoveResult {
  action: PlannedAction;
  ok: boolean;
  error?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Moves are patch updates on mailboxIds ({"mailboxIds/<triageId>": null,
// "mailboxIds/<destId>": true}), not a wholesale replace -- an email can
// belong to more than one mailbox at once in JMAP, and patching only the two
// entries in play leaves any other membership untouched. Batched (unlike
// classification's one-call-per-email): there's no Bedrock-style accuracy
// constraint on Email/set, so multiple emails' updates share one call.
// Email/set's response separates updated from notUpdated per id, so one
// rejected email doesn't fail the rest of its batch. The $ai-* keyword
// (§ PlannedAction.keyword) rides in the same patch object as the mailbox
// change -- one write per email, not two -- so a move and its keyword
// always succeed or fail together.
export async function applyMoves(
  session: Session,
  triageMailboxId: string,
  planned: PlannedAction[]
): Promise<MoveResult[]> {
  const results: MoveResult[] = [];

  for (const batch of chunk(planned, WRITE_BATCH_SIZE)) {
    const update: Record<string, Record<string, unknown>> = {};
    for (const action of batch) {
      const patch: Record<string, unknown> = {
        [`mailboxIds/${triageMailboxId}`]: null,
        [`mailboxIds/${action.destination.mailboxId}`]: true,
        [`keywords/${action.keyword}`]: true,
      };
      if (action.notify) {
        patch[`keywords/${action.notifiedKeyword}`] = true;
      }
      update[action.email.id] = patch;
    }

    const data = await jmapRequest(session, [CORE, MAIL], [
      ["Email/set", { accountId: session.accountId, update }, "a"],
    ]);
    const emailSet = data.methodResponses.find((m: any) => m[2] === "a")?.[1];
    if (!emailSet) {
      throw new Error(`Unexpected JMAP response: ${JSON.stringify(data, null, 2)}`);
    }

    for (const action of batch) {
      const notUpdated = emailSet.notUpdated?.[action.email.id];
      if (notUpdated) {
        results.push({ action, ok: false, error: JSON.stringify(notUpdated) });
      } else {
        results.push({ action, ok: true });
      }
    }
  }

  return results;
}
