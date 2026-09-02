// Resolves the mailboxes the action stage moves mail between. Every
// mailbox is described once, in MAILBOX_SPECS below -- config.ts's
// override reading and actions.ts's category->destination mapping both
// derive from this same table instead of each keeping their own
// hand-synced copy, so adding a category means adding one row here, not
// editing multiple files in lockstep with nothing enforcing they stay in
// sync.

import { CORE, MAIL, jmapRequest, type Session } from "./jmap-session.js";

interface MailboxSpec {
  key: string;
  // Full path from the account root, e.g. ["Inbox", "Orders"].
  path: readonly string[];
  envVar: string;
  // Present only for mailboxes a classification category moves mail
  // into -- Inbox/Triage (the source, not a destination) omits it.
  category?: string;
}

export const MAILBOX_SPECS = [
  { key: "triageId", path: ["Inbox", "Triage"], envVar: "TRIAGE_MAILBOX_ID", category: undefined },
  { key: "inboxId", path: ["Inbox"], envVar: "INBOX_MAILBOX_ID", category: "inbox" },
  { key: "inboxOrdersId", path: ["Inbox", "Orders"], envVar: "INBOX_ORDERS_MAILBOX_ID", category: "orders" },
  {
    key: "inboxSuspiciousId",
    path: ["Inbox", "Suspicious"],
    envVar: "INBOX_SUSPICIOUS_MAILBOX_ID",
    category: "suspicious",
  },
  { key: "inboxNewsId", path: ["Inbox", "News"], envVar: "INBOX_NEWS_MAILBOX_ID", category: "newsletters" },
  { key: "archivedNoiseId", path: ["Archive", "Noise"], envVar: "ARCHIVE_NOISE_MAILBOX_ID", category: "noise" },
] as const satisfies readonly MailboxSpec[];

export type MailboxKey = (typeof MAILBOX_SPECS)[number]["key"];
export type MailboxRefs = Record<MailboxKey, string>;
export type MailboxOverrides = Partial<Record<MailboxKey, string>>;

// JMAP role for each top-level name a spec's path can start with -- role is
// the part of RFC 8621 actually guaranteed unique and stable, unlike a
// display-name match, which is incidental and would break under a renamed
// or localized mailbox.
const TOP_LEVEL_ROLES: Record<string, string> = { Inbox: "inbox", Archive: "archive" };

function actionableMissingMailboxError(name: string, parentLabel: string, envVar: string): Error {
  return new Error(
    `Could not find a mailbox named "${name}" under "${parentLabel}".\n` +
      `Create it in Fastmail Settings -> Mailboxes, or set ${envVar} if it already\n` +
      `exists under a different name or parent.`
  );
}

async function resolveTopLevelMailbox(
  session: Session,
  name: string,
  role: string | undefined,
  envVar: string
): Promise<string> {
  if (role) {
    const data = await jmapRequest(session, [CORE, MAIL], [
      ["Mailbox/query", { accountId: session.accountId, filter: { role } }, "a"],
    ]);
    const ids = data.methodResponses.find((m: any) => m[2] === "a")?.[1]?.ids as string[] | undefined;
    if (ids && ids.length > 0) return ids[0];
  }

  const data = await jmapRequest(session, [CORE, MAIL], [
    ["Mailbox/query", { accountId: session.accountId, filter: { name, parentId: null } }, "a"],
  ]);
  const ids = data.methodResponses.find((m: any) => m[2] === "a")?.[1]?.ids as string[] | undefined;
  if (!ids || ids.length === 0) {
    throw actionableMissingMailboxError(name, "(top level)", envVar);
  }
  return ids[0];
}

async function resolveChildMailbox(
  session: Session,
  parentId: string,
  parentLabel: string,
  name: string,
  envVar: string
): Promise<string> {
  const data = await jmapRequest(session, [CORE, MAIL], [
    ["Mailbox/query", { accountId: session.accountId, filter: { parentId, name } }, "a"],
  ]);
  const ids = data.methodResponses.find((m: any) => m[2] === "a")?.[1]?.ids as string[] | undefined;
  if (!ids || ids.length === 0) {
    throw actionableMissingMailboxError(name, parentLabel, envVar);
  }
  return ids[0];
}

// Resolves one spec's full path, reusing an already-resolved (or
// in-flight) top-level lookup across specs that share a root -- e.g. the
// four Inbox-rooted destination specs plus Inbox/Triage hit Mailbox/query
// for "Inbox" itself only once between them, keyed by whichever spec's
// envVar got there first.
async function resolvePath(
  session: Session,
  path: readonly string[],
  envVar: string,
  topLevelCache: Map<string, Promise<string>>
): Promise<string> {
  const [top, ...rest] = path;
  let topPromise = topLevelCache.get(top);
  if (!topPromise) {
    topPromise = resolveTopLevelMailbox(session, top, TOP_LEVEL_ROLES[top], envVar);
    topLevelCache.set(top, topPromise);
  }
  let id = await topPromise;
  let label = top;
  for (const segment of rest) {
    id = await resolveChildMailbox(session, id, label, segment, envVar);
    label = `${label}/${segment}`;
  }
  return id;
}

// Resolves every mailbox in MAILBOX_SPECS for one run. A missing mailbox
// fails the whole run (not just moves for the affected category) --
// resolution happens before any fetching or classifying, so a missing
// destination is caught before spending a single classify call.
export async function resolveMailboxes(session: Session, overrides: MailboxOverrides): Promise<MailboxRefs> {
  const topLevelCache = new Map<string, Promise<string>>();
  const refs = {} as Record<MailboxKey, string>;
  for (const spec of MAILBOX_SPECS) {
    refs[spec.key] = overrides[spec.key] ?? (await resolvePath(session, spec.path, spec.envVar, topLevelCache));
  }
  return refs;
}
