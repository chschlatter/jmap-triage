// The action stage: maps a classification to a destination mailbox and
// moves the email there via a JMAP Email/set patch.

import { CORE, MAIL, jmapRequest, type Session } from "./jmap-session.js";
import { MAILBOX_SPECS, type MailboxRefs } from "./mailboxes.js";
import type { TriageEmail } from "./fetch-emails.js";
import type { ClassificationOutcome } from "./classify.js";

// Below typical JMAP maxObjectsInSet limits -- confirm against
// session.capabilities[...:core].maxObjectsInSet before raising this.
const WRITE_BATCH_SIZE = 50;

export interface Destination {
  mailboxId: string;
  // Full path -- matches the Fastmail web UI's deep-link segment (notify.ts).
  path: string;
}

// Derived from MAILBOX_SPECS so it can't drift out of sync. Every category
// gets its own mailbox rather than sharing one: the $ai-* keyword isn't
// surfaced anywhere in the Fastmail UI, so a distinct destination is the only
// in-reader indicator of what the AI decided.
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
  // $ai-<promptVersion>-<category>, stamped at move time so
  // get_triage_report/evaluate_candidate can compare the original
  // classification against wherever the user later files the email.
  keyword: string;
  // $ai-<promptVersion>-notified, written only when notify is true. Records
  // that the email was flagged for a push, not that Pushover delivery
  // succeeded -- main.ts's notify stage fails independently of this.
  notifiedKeyword: string;
  // Stamps from an earlier round. Mail that round 2 files carries round 1's
  // $ai-<phVersion>-clean too, which is the only way a round-1 false
  // negative becomes detectable later (DESIGN-v8 SS3.5).
  extraKeywords?: string[];
}

export interface SkippedEmail {
  email: TriageEmail;
  reason: string;
}

function aiKeywordFor(promptVersion: string, category: string): string {
  return `$ai-${promptVersion}-${category}`;
}

function aiNotifiedKeyword(promptVersion: string): string {
  return `$ai-${promptVersion}-notified`;
}

// Pure -- no writes. A classification failure or an unrecognized category is
// skipped, leaving the email in Inbox/Triage for the next run or a human.
//
// promptVersion is the version that actually produced `outcomes`, passed in
// explicitly so each stamped keyword matches the prompt that classified it.
export function planActions(
  emails: TriageEmail[],
  outcomes: ClassificationOutcome[],
  destinations: Record<string, Destination>,
  promptVersion: string,
  extraKeywords: string[] = []
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
      keyword: aiKeywordFor(promptVersion, outcome.category),
      notifiedKeyword: aiNotifiedKeyword(promptVersion),
      extraKeywords,
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

// A move is a patch on mailboxIds, not a wholesale replace -- an email can
// belong to several mailboxes, and patching only the two entries in play
// leaves the rest untouched. The $ai-* keyword rides in the same patch, so a
// move and its tag always succeed or fail together.
//
// Batched, unlike classification: Email/set has no accuracy constraint, and
// its response separates updated from notUpdated per id, so one rejected
// email doesn't fail the rest of its batch.
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
      for (const extra of action.extraKeywords ?? []) {
        patch[`keywords/${extra}`] = true;
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
