// get_triage_report (jmap-triage-mcp tool #3). Calls keyword-scan.ts's
// scanKeywordState() for category agreement, computes ratios from the
// mismatches bucket, and does its own separate lightweight notify-keyword
// scan -- notify is an independent model decision, not part of the
// category-agreement comparison keyword-scan.ts exists to answer, so it
// isn't bundled into that shared scan.

import { requireFastmailToken } from "./config.js";
import { getKnownPromptVersions, scanKeywordState } from "./keyword-scan.js";
import { bootstrapSession, jmapRequest, CORE, MAIL, type Session } from "./jmap-session.js";
import { MAILBOX_SPECS } from "./mailboxes.js";

export interface TriageReportParams {
  // Not currently wired into the scan -- keyword-scan.ts's shared query has
  // no date-bound support at all. Kept on the tool's params for forward
  // compatibility rather than breaking the schema if this lands later.
  since?: string;
}

export interface TriageReportRatio {
  mismatches: number;
  total: number;
}

export interface TriageReportMismatch {
  messageId: string;
  predictedCategory: string;
  actualFolder: string;
  promptVersion: string;
}

export interface TriageReportNotifyRow {
  messageId: string;
  notify: boolean;
}

export interface TriageReport {
  ratios: Record<string, TriageReportRatio>;
  notifyRows: TriageReportNotifyRow[];
  mismatches: TriageReportMismatch[];
}

async function fetchNotifiedIds(session: Session, versions: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const version of versions) {
    const data = await jmapRequest(session, [CORE, MAIL], [
      ["Email/query", { accountId: session.accountId, filter: { hasKeyword: `$ai-${version}-notified` }, limit: 2000 }, "a"],
    ]);
    const queryResult = data.methodResponses.find((m: any) => m[2] === "a")?.[1];
    for (const id of (queryResult?.ids ?? []) as string[]) ids.add(id);
  }
  return ids;
}

export async function getTriageReport(_params: TriageReportParams = {}): Promise<TriageReport> {
  const categories = MAILBOX_SPECS.flatMap((s) => (s.category ? [s.category as string] : []));

  const { matches, mismatches } = await scanKeywordState();

  const ratios: Record<string, TriageReportRatio> = {};
  for (const c of categories) ratios[c] = { mismatches: 0, total: 0 };
  for (const m of matches) ratios[m.category].total++;
  for (const m of mismatches) {
    ratios[m.predictedCategory].total++;
    ratios[m.predictedCategory].mismatches++;
  }

  // Own session, independent of scanKeywordState()'s -- deliberately not
  // shared (see keyword-scan.ts's header comment): notify state isn't part
  // of what that module scans for.
  const session = await bootstrapSession(requireFastmailToken());
  const versions = await getKnownPromptVersions();
  const notifiedIds = await fetchNotifiedIds(session, versions);

  const allIds = [...matches.map((m) => m.messageId), ...mismatches.map((m) => m.messageId)];
  const notifyRows: TriageReportNotifyRow[] = allIds.map((messageId) => ({
    messageId,
    notify: notifiedIds.has(messageId),
  }));

  return { ratios, notifyRows, mismatches };
}
