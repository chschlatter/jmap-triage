// Shared by report.ts and evaluate.ts: for every email ever classified, does
// its stamped $ai-* category keyword match where the email now lives?
//
// JMAP keyword filters are exact-match with no wildcard, and the keyword
// bakes in the prompt version, so "scan for $ai-*" is one Email/query per
// (known version, category) pair. Known versions come from history.ts plus
// the live one, so old approvals don't drop out of the scan.
//
// Fetches only `mailboxIds`, not `keywords`. notify state is an independent
// scan in report.ts -- it isn't part of the category agreement this module
// exists to answer.

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

// Every version that has ever classified mail here: the live one plus every
// one history.ts has a record for. Exported for report.ts's notify scan.
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
        // Fastmail's "report phishing" button moves mail straight to Trash,
        // not Inbox/Suspicious -- agreement via a different UI path.
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
