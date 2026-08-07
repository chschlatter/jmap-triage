// One-off audit script -- not part of the deployed pipeline. Pulls every
// email since SINCE that carries an $ai-v4-* keyword (i.e. actually went
// through classify.ts), and reports the AI's category against where the
// email currently sits, so a Claude+Fastmail-MCP session can spot-check
// mismatches and rewrite prompt.ts. Read-only: no Email/set calls.
//
// Run: FASTMAIL_TOKEN=... npx tsx reports/generate-report.ts

import { loadEnvFile } from "../src/config.js";
import { bootstrapSession, jmapRequest, CORE, MAIL } from "../src/jmap-session.js";

const SINCE = "2026-07-31T00:00:00Z";
const CATEGORIES = ["attention", "keep", "suspicious", "newsletters", "noise"] as const;
type Category = (typeof CATEGORIES)[number];

// Mirrors destinationsFor in src/actions.ts -- the folder each category
// should land in immediately after a triage run.
const EXPECTED_PATH: Record<Category, string> = {
  attention: "Inbox",
  keep: "Inbox",
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

  const keywordFilters = CATEGORIES.map((c) => ({ hasKeyword: `$ai-v4-${c}` }));
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
    const categoryKey = Object.keys(keywords).find((k) => /^\$ai-v4-/.test(k));
    if (!categoryKey) continue; // shouldn't happen given the query filter, but stay defensive
    const category = categoryKey.replace("$ai-v4-", "") as Category;

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

  // Agreement signal:
  // - suspicious/newsletters/noise each have a folder distinct from Inbox,
  //   so "moved somewhere other than the expected folder" is a direct
  //   disagreement signal.
  // - attention/keep both land in Inbox, so folder alone can't distinguish
  //   them. Flag "left Inbox entirely" as disagreement (the user didn't
  //   think it belonged there), and otherwise mark unknown.
  function agreement(row: ReportRow): "match" | "mismatch" | "unknown" {
    const inExpected = row.currentPaths.includes(row.expectedPath);
    if (row.category === "attention" || row.category === "keep") {
      if (!row.currentPaths.includes("Inbox")) return "mismatch";
      return "unknown";
    }
    return inExpected ? "match" : "mismatch";
  }

  const withAgreement = rows.map((r) => ({ ...r, agreement: agreement(r) }));
  const mismatches = withAgreement.filter((r) => r.agreement === "mismatch");
  const unknowns = withAgreement.filter((r) => r.agreement === "unknown");
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
    `Prompt version audited: \`v4\` (see \`prompt.ts\`). Categories land in: attention/keep → Inbox, ` +
      `suspicious → Inbox/Suspicious, newsletters → Inbox/News, noise → Archive/Noise. A "mismatch" means ` +
      `the email is no longer in its expected folder — i.e. the AI's category and the user's actual filing ` +
      `disagree. attention/keep share one folder, so those can only be flagged as "mismatch" when the user ` +
      `moved the email out of Inbox entirely; otherwise they're "unknown" (no signal either way from location alone — ` +
      `check read/flagged/answered as a secondary clue).`
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Category | Total | Match | Mismatch | Unknown |");
  lines.push("|---|---|---|---|---|");
  for (const c of CATEGORIES) {
    const total = counts[c] ?? 0;
    const m = matches.filter((r) => r.category === c).length;
    const mm = mismatches.filter((r) => r.category === c).length;
    const u = unknowns.filter((r) => r.category === c).length;
    lines.push(`| ${c} | ${total} | ${m} | ${mm} | ${u} |`);
  }
  lines.push(`| **Total** | **${rows.length}** | **${matches.length}** | **${mismatches.length}** | **${unknowns.length}** |`);
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
      ? "These are the highest-value cases to feed back into `prompt.ts` — pull the full body via `read_email` before editing the prompt."
      : "None found."
  );
  lines.push("");
  for (const r of mismatches) lines.push(rowLine(r));

  lines.push("## Unresolved — attention/keep, still in Inbox (no folder signal)");
  lines.push("");
  lines.push(
    "Check `seen`/`flagged`/`answered` as a secondary clue: an *unseen, unflagged* `attention` email sitting " +
      "untouched may have been over-flagged; a `keep` email the user replied to may have deserved `attention`."
  );
  lines.push("");
  for (const r of unknowns) lines.push(rowLine(r));

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
