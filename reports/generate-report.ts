// One-off audit script -- not part of the deployed pipeline, and largely
// superseded by the jmap-triage-mcp get_triage_report tool (dynamic across
// all prompt versions, not hardcoded to one -- see keyword-scan.ts). Pulls
// every email since SINCE that carries an $ai-v7-* keyword (i.e. actually
// went through classify.ts), and reports the AI's category against where
// the email currently sits, so a Claude+Fastmail-MCP session can spot-check
// mismatches. There is no bundled prompt.ts to rewrite anymore -- feed
// mismatches back through evaluate_candidate/approve_prompt_diff instead.
// Read-only: no Email/set calls.
//
// Run: FASTMAIL_TOKEN=... npx tsx reports/generate-report.ts

import { loadEnvFile } from "../src/config.js";
import { bootstrapSession, jmapRequest, CORE, MAIL } from "../src/jmap-session.js";

const SINCE = "2026-08-07T00:00:00Z";
const CATEGORIES = ["inbox", "orders", "suspicious", "newsletters", "noise"] as const;
type Category = (typeof CATEGORIES)[number];

// Mirrors destinationsFor in src/actions.ts -- the folder each category
// should land in immediately after a triage run. v7 collapsed "attention"
// and "keep" into "inbox" and added "orders" -- see src/mailboxes.ts
// MAILBOX_SPECS, the single source of truth this table now has to track by
// hand since this script doesn't import it directly.
const EXPECTED_PATH: Record<Category, string> = {
  inbox: "Inbox",
  orders: "Inbox/Orders",
  suspicious: "Inbox/Suspicious",
  newsletters: "Inbox/News",
  noise: "Archive/Noise",
};

interface ReportRow {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  category: Category;
  currentPaths: string[];
  expectedPath: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  attachments: string[];
  excerpt: string;
}

function formatAddresses(addrs: Array<{ name?: string | null; email: string }> | null | undefined): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}

async function main() {
  await loadEnvFile();
  const token = process.env.FASTMAIL_TOKEN;
  if (!token) throw new Error("FASTMAIL_TOKEN not set (check .env)");

  const session = await bootstrapSession(token);

  // Build mailboxId -> full path map for every mailbox in the account, so a
  // triaged email that got manually moved somewhere outside the five
  // pipeline folders (plain Archive, Trash, a project folder, ...) still
  // shows up with a real name instead of a bare id.
  const mailboxData = await jmapRequest(session, [CORE, MAIL], [
    ["Mailbox/get", { accountId: session.accountId, properties: ["name", "parentId"] }, "a"],
  ]);
  const mailboxList = mailboxData.methodResponses.find((m: any) => m[2] === "a")?.[1]?.list as Array<{
    id: string;
    name: string;
    parentId: string | null;
  }>;
  const byId = new Map(mailboxList.map((m) => [m.id, m]));
  function pathFor(id: string): string {
    const parts: string[] = [];
    let cur: string | null = id;
    while (cur) {
      const mb = byId.get(cur);
      if (!mb) break;
      parts.unshift(mb.name);
      cur = mb.parentId;
    }
    return parts.join("/") || id;
  }

  const keywordFilters = CATEGORIES.map((c) => ({ hasKeyword: `$ai-v7-${c}` }));
  const queryData = await jmapRequest(session, [CORE, MAIL], [
    [
      "Email/query",
      {
        accountId: session.accountId,
        filter: {
          operator: "AND",
          conditions: [{ after: SINCE }, { operator: "OR", conditions: keywordFilters }],
        },
        sort: [{ property: "receivedAt", isAscending: true }],
        limit: 2000,
      },
      "a",
    ],
    [
      "Email/get",
      {
        accountId: session.accountId,
        "#ids": { resultOf: "a", name: "Email/query", path: "/ids" },
        properties: ["subject", "from", "receivedAt", "keywords", "mailboxIds", "attachments", "preview"],
        bodyProperties: ["partId", "type", "disposition"],
      },
      "b",
    ],
  ]);

  const emailGet = queryData.methodResponses.find((m: any) => m[2] === "b")?.[1];
  const emails = emailGet.list as any[];

  const rows: ReportRow[] = [];
  for (const m of emails) {
    const keywords: Record<string, boolean> = m.keywords ?? {};
    // Every category keyword is also matched by /^\$ai-v7-/, but so is the
    // separate $ai-v7-notified push marker (src/actions.ts aiNotifiedKeyword)
    // -- an email can carry both. Match against CATEGORIES explicitly so
    // "notified" never gets mistaken for a category.
    const category = CATEGORIES.find((c) => keywords[`$ai-v7-${c}`]);
    if (!category) continue; // shouldn't happen given the query filter, but stay defensive

    const mailboxIds: string[] = Object.keys(m.mailboxIds ?? {});
    rows.push({
      id: m.id,
      subject: m.subject ?? "(no subject)",
      from: formatAddresses(m.from),
      receivedAt: m.receivedAt ?? "",
      category,
      currentPaths: mailboxIds.map(pathFor),
      expectedPath: EXPECTED_PATH[category],
      seen: !!keywords["$seen"],
      flagged: !!keywords["$flagged"],
      answered: !!keywords["$answered"],
      attachments: (m.attachments ?? [])
        .filter((a: any) => a.disposition !== "inline" && a.name)
        .map((a: any) => a.name),
      excerpt: (m.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }

  // Agreement signal: as of v7 every category has its own distinct
  // destination folder (attention/keep collapsed into inbox -- see
  // src/actions.ts destinationsFor), so "moved somewhere other than the
  // expected folder" is a direct disagreement signal for all five, with one
  // exception: Fastmail's "report phishing" button moves the email straight
  // to Trash (confirmed by the user 2026-08-18), not Inbox/Suspicious. A
  // `suspicious` email in Trash means the user agreed it was bad and acted
  // on that via a different UI path -- treat it as a match, not a mismatch.
  function agreement(row: ReportRow): "match" | "mismatch" {
    if (row.category === "suspicious" && row.currentPaths.includes("Trash")) return "match";
    return row.currentPaths.includes(row.expectedPath) ? "match" : "mismatch";
  }

  const withAgreement = rows.map((r) => ({ ...r, agreement: agreement(r) }));
  const mismatches = withAgreement.filter((r) => r.agreement === "mismatch");
  const matches = withAgreement.filter((r) => r.agreement === "match");

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;

  const lines: string[] = [];
  lines.push(`# Triage classification audit — since ${SINCE.slice(0, 10)}`);
  lines.push("");
  lines.push(
    `Generated ${new Date().toISOString().slice(0, 10)} from JMAP (\`reports/generate-report.ts\`). ` +
      `Each row's \`id\` is a Fastmail email id — pass it directly to the Fastmail MCP connector's ` +
      `\`read_email\` tool to pull the full body for any email flagged below.`
  );
  lines.push("");
  lines.push(
    `Prompt version audited: \`v7\` (this script's keyword filter is hardcoded to v7 -- check get_triage_report for the live version's mismatch ratios instead). Categories land in: inbox → Inbox, ` +
      `orders → Inbox/Orders, suspicious → Inbox/Suspicious, newsletters → Inbox/News, noise → Archive/Noise. ` +
      `A "mismatch" means the email is no longer in its expected folder — i.e. the AI's category and the ` +
      `user's actual filing disagree. Every category now has its own distinct destination folder, so folder ` +
      `location alone is a direct signal for all five (no "unknown" case, unlike the v4 audit where ` +
      `attention/keep shared one folder) — except \`suspicious\` mail the user sent to Trash via Fastmail's ` +
      `"report phishing" button, which is counted as a match (agreement, just via a different UI path) rather ` +
      `than a mismatch against Inbox/Suspicious.`
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Category | Total | Match | Mismatch |");
  lines.push("|---|---|---|---|");
  for (const c of CATEGORIES) {
    const total = counts[c] ?? 0;
    const m = matches.filter((r) => r.category === c).length;
    const mm = mismatches.filter((r) => r.category === c).length;
    lines.push(`| ${c} | ${total} | ${m} | ${mm} |`);
  }
  lines.push(`| **Total** | **${rows.length}** | **${matches.length}** | **${mismatches.length}** |`);
  lines.push("");

  function rowLine(r: (typeof withAgreement)[number]): string {
    const flags = [r.seen ? "seen" : "unseen", r.flagged ? "flagged" : null, r.answered ? "answered" : null]
      .filter(Boolean)
      .join(", ");
    return [
      `### ${r.subject}`,
      "",
      `- id: \`${r.id}\``,
      `- from: ${r.from}`,
      `- received: ${r.receivedAt}`,
      `- AI category: **${r.category}** (expected folder: ${r.expectedPath})`,
      `- current folder(s): ${r.currentPaths.join(", ") || "(none — deleted?)"}`,
      `- flags: ${flags}`,
      `- attachments: ${r.attachments.length ? r.attachments.join(", ") : "(none)"}`,
      `- excerpt: ${r.excerpt || "(empty)"}`,
      "",
    ].join("\n");
  }

  lines.push("## Likely mismatches — AI category disagrees with where the email ended up");
  lines.push("");
  lines.push(
    mismatches.length
      ? "These are the highest-value cases to feed back into a prompt revision via `evaluate_candidate`/`approve_prompt_diff` — pull the full body via `read_email` before drafting the diff."
      : "None found."
  );
  lines.push("");
  for (const r of mismatches) lines.push(rowLine(r));

  lines.push("## Matches — folder confirms the AI's category");
  lines.push("");
  lines.push("| id | subject | from | received | category |");
  lines.push("|---|---|---|---|---|");
  for (const r of matches) {
    lines.push(`| \`${r.id}\` | ${r.subject.replace(/\|/g, "\\|")} | ${r.from} | ${r.receivedAt} | ${r.category} |`);
  }
  lines.push("");

  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
