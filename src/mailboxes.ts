// Resolves the mailboxes the action stage moves mail between. MAILBOX_SPECS
// below is the single source of truth: config.ts's override reading and
// actions.ts's category->destination map both derive from it, so adding a
// category is one row here rather than edits in lockstep across files.

import { CORE, MAIL, jmapRequest, type Session } from "./jmap-session.js";

interface MailboxSpec {
  key: string;
  // Full path from the account root, e.g. ["Inbox", "Orders"].
  path: readonly string[];
  envVar: string;
  // Only set for destinations -- Inbox/Triage is the source, so it omits it.
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

// Match top-level mailboxes by RFC 8621 role, not display name: role is the
// part guaranteed unique and stable under a rename or localized UI.
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

// Resolves one spec's full path, sharing the in-flight top-level lookup
// across specs with the same root -- the five Inbox-rooted specs query for
// "Inbox" itself once between them.
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

// A missing mailbox fails the whole run, not just its category: resolution
// runs before any fetch or classify, so it costs no model calls.
export async function resolveMailboxes(session: Session, overrides: MailboxOverrides): Promise<MailboxRefs> {
  const topLevelCache = new Map<string, Promise<string>>();
  const refs = {} as Record<MailboxKey, string>;
  for (const spec of MAILBOX_SPECS) {
    refs[spec.key] = overrides[spec.key] ?? (await resolvePath(session, spec.path, spec.envVar, topLevelCache));
  }
  return refs;
}
