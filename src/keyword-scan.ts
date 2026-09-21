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
import { MAILBOX_SPECS, categoriesForStage } from "./mailboxes.js";
import { CLEAN_VERDICT, PHISHING_CATEGORY, STAGE_KEYS, stageSpec, type StageKey } from "./stages.js";

export interface KeywordMatch {
  messageId: string;
  category: string;
  stage: StageKey;
}

export interface KeywordMismatch {
  messageId: string;
  predictedCategory: string;
  actualFolder: string;
  promptVersion: string;
  stage: StageKey;
}

export interface KeywordScanResult {
  matches: KeywordMatch[];
  mismatches: KeywordMismatch[];
}

// Every version that has ever classified mail here for one stage: the live
// one plus every one history.ts has a record for. Exported for report.ts's
// notify scan.
export async function getKnownPromptVersions(stage: StageKey = "triage"): Promise<string[]> {
  const [current, history] = await Promise.all([getCurrentPrompt(stage), getVersionHistory({ stage })]);
  return [...new Set([current.version, ...history.map((h) => h.version)])];
}

// What each stamped keyword claims, and how to check it against where the
// message now sits. `clean` is a stage verdict, not a category: it has no
// folder of its own, so the only thing that falsifies it is the message
// later turning up in Suspicious.
interface ScanTarget {
  stage: StageKey;
  category: string;
  isMatch: (paths: string[]) => boolean;
}

function scanTargetsFor(stage: StageKey): ScanTarget[] {
  const pathOf = (category: string) =>
    MAILBOX_SPECS.find((s) => s.category === category)!.path.join("/");

  if (stage === "phish") {
    const suspiciousPath = pathOf(PHISHING_CATEGORY);
    return [
      {
        stage,
        category: PHISHING_CATEGORY,
        // Fastmail's "report phishing" button moves mail straight to Trash,
        // not Inbox/Suspicious -- agreement via a different UI path.
        isMatch: (paths) => paths.includes(suspiciousPath) || paths.includes("Trash"),
      },
      { stage, category: CLEAN_VERDICT, isMatch: (paths) => !paths.includes(suspiciousPath) },
    ];
  }

  return categoriesForStage(stage).map((category) => {
    const expected = pathOf(category);
    return { stage, category, isMatch: (paths: string[]) => paths.includes(expected) };
  });
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

  const pathFor = await buildMailboxPathIndex(session);
  // Each stage has its own version line, so the scan is per stage: a ph
  // version never pairs with a triage category, and vice versa.
  const perStage = await Promise.all(
    STAGE_KEYS.map(async (stage) => ({ stage, versions: await getKnownPromptVersions(stage) }))
  );

  const matches: KeywordMatch[] = [];
  const mismatches: KeywordMismatch[] = [];

  for (const { stage, versions } of perStage) {
    for (const version of versions) {
      for (const target of scanTargetsFor(stage)) {
        const keyword = `$ai-${version}-${target.category}`;
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

          if (target.isMatch(currentPaths)) {
            matches.push({ messageId: m.id, category: target.category, stage });
          } else {
            mismatches.push({
              messageId: m.id,
              predictedCategory: target.category,
              actualFolder: currentPaths.join(", ") || "(none — deleted?)",
              promptVersion: version,
              stage,
            });
          }
        }
      }
    }
  }

  return { matches, mismatches };
}
