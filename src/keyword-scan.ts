// Shared JMAP keyword-state scan. report.ts and evaluate.ts both need to
// know, for every email ever classified, whether its stamped $ai-* category
// keyword matches where the email currently lives -- factored out here so
// neither duplicates the JMAP query logic. Reuses jmap-session.ts's
// bootstrapped session and mailboxes.ts's MAILBOX_SPECS rather than a
// second, hand-synced copy of the category->folder map.
//
// JMAP keyword filters are exact-match, no wildcard, and the keyword name
// bakes in the prompt version ($ai-<version>-<category>) -- so scanning
// "every mailbox for $ai-* keywords" means one Email/query per (known
// version, category) pair, not one query. "Known" versions come from
// history.ts plus whatever's currently live, not a hardcoded list -- old
// approvals don't silently drop out of the scan just because a newer
// version shipped.
//
// Deliberately doesn't fetch or return `keywords` -- only `mailboxIds`, the
// one thing needed to tell match from mismatch. notify-keyword state is a
// separate, independent scan (report.ts does its own lightweight query for
// it) rather than being bundled in here, since it isn't part of the
// category-agreement comparison this module exists to answer.

import { requireFastmailToken } from "./config.js";
import { getCurrentPrompt } from "./current-prompt.js";
import { getVersionHistory } from "./history.js";
import { bootstrapSession, jmapRequest, CORE, MAIL, type Session } from "./jmap-session.js";
import { MAILBOX_SPECS } from "./mailboxes.js";

export interface KeywordMatch {
  messageId: string;
  category: string;
}

export interface KeywordMismatch {
  messageId: string;
  predictedCategory: string;
  actualFolder: string;
  promptVersion: string;
}

export interface KeywordScanResult {
  matches: KeywordMatch[];
  mismatches: KeywordMismatch[];
}

// Every prompt version this account has ever had classify mail with --
// current.json's live version plus every version/history.ts has a record
// for. Exported since report.ts's own separate notify-keyword scan needs
// the same version list.
export async function getKnownPromptVersions(): Promise<string[]> {
  const [current, history] = await Promise.all([getCurrentPrompt(), getVersionHistory({})]);
  return [...new Set([current.version, ...history.map((h) => h.version)])];
}

export async function buildMailboxPathIndex(session: Session): Promise<(id: string) => string> {
  const data = await jmapRequest(session, [CORE, MAIL], [
    ["Mailbox/get", { accountId: session.accountId, properties: ["name", "parentId"] }, "a"],
  ]);
  const list = data.methodResponses.find((m: any) => m[2] === "a")?.[1]?.list as Array<{
    id: string;
    name: string;
    parentId: string | null;
  }>;
  const byId = new Map(list.map((m) => [m.id, m]));

  return (id: string): string => {
    const parts: string[] = [];
    let cur: string | null = id;
    while (cur) {
      const mb = byId.get(cur);
      if (!mb) break;
      parts.unshift(mb.name);
      cur = mb.parentId;
    }
    return parts.join("/") || id;
  };
}

export async function scanKeywordState(): Promise<KeywordScanResult> {
  const token = requireFastmailToken();
  const session = await bootstrapSession(token);

  const categories = MAILBOX_SPECS.flatMap((s) => (s.category ? [s.category as string] : []));
  const expectedPath: Record<string, string> = {};
  for (const spec of MAILBOX_SPECS) {
    if (spec.category) expectedPath[spec.category] = spec.path.join("/");
  }

  const [versions, pathFor] = await Promise.all([getKnownPromptVersions(), buildMailboxPathIndex(session)]);

  const matches: KeywordMatch[] = [];
  const mismatches: KeywordMismatch[] = [];

  for (const version of versions) {
    for (const category of categories) {
      const keyword = `$ai-${version}-${category}`;
      const data = await jmapRequest(session, [CORE, MAIL], [
        ["Email/query", { accountId: session.accountId, filter: { hasKeyword: keyword }, limit: 2000 }, "a"],
        [
          "Email/get",
          {
            accountId: session.accountId,
            "#ids": { resultOf: "a", name: "Email/query", path: "/ids" },
            properties: ["mailboxIds"],
          },
          "b",
        ],
      ]);
      const emails = (data.methodResponses.find((m: any) => m[2] === "b")?.[1]?.list ?? []) as any[];

      for (const m of emails) {
        const currentPaths = Object.keys(m.mailboxIds ?? {}).map(pathFor);
        // Fastmail's "report phishing" button moves the email straight to
        // Trash, not Inbox/Suspicious -- that's agreement via a different
        // UI path, not a mismatch.
        const isMatch =
          category === "suspicious" && currentPaths.includes("Trash")
            ? true
            : currentPaths.includes(expectedPath[category]);

        if (isMatch) {
          matches.push({ messageId: m.id, category });
        } else {
          mismatches.push({
            messageId: m.id,
            predictedCategory: category,
            actualFolder: currentPaths.join(", ") || "(none — deleted?)",
            promptVersion: version,
          });
        }
      }
    }
  }

  return { matches, mismatches };
}
