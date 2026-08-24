// .env loading, CLI flag parsing, and env-var validation. Kept separate from
// the modules that consume the values (v5, see
// triage.ts-DESIGN-v5-2026-08-02.md §4) so a new required env var or flag
// touches one file, not the orchestration logic in main.ts.

import { MAILBOX_SPECS, type MailboxOverrides } from "./mailboxes.js";

const DEFAULT_LIMIT = 20;

export async function loadEnvFile(path = ".env") {
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(path, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

export interface CliOptions {
  limit: number;
  apply: boolean;
  notify: boolean;
}

function parseLimit(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--limit"));
  if (!flag) return DEFAULT_LIMIT;
  const value = flag.includes("=") ? flag.split("=")[1] : argv[argv.indexOf(flag) + 1];
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --limit value: ${value}`);
  }
  return n;
}

// --apply: perform real moves + notifications. Default is dry run -- print
// what would happen, write nothing. --no-notify (only meaningful with
// --apply): perform moves, skip Pushover. See
// triage.ts-DESIGN-v5-2026-08-02.md §3.5 for why the default is dry run.
export function parseArgs(argv: string[]): CliOptions {
  const apply = argv.includes("--apply");
  const notify = apply && !argv.includes("--no-notify");
  return { limit: parseLimit(argv), apply, notify };
}

export function requireFastmailToken(): string {
  const token = process.env.FASTMAIL_TOKEN;
  if (!token) {
    throw new Error(
      "Error: FASTMAIL_TOKEN environment variable is not set.\n" +
        "Create an API token at https://app.fastmail.com/settings/security/tokens\n" +
        "Scope: Mail (read/write -- v5 moves mail between mailboxes when run with --apply).\n" +
        "then run: FASTMAIL_TOKEN=fmu1-... npx tsx triage.ts"
    );
  }
  return token;
}

export function requireBedrockModelId(): string {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error(
      "Error: BEDROCK_MODEL_ID environment variable is not set.\n" +
        "Bedrock model IDs change over time, so this script does not hardcode one.\n" +
        "Look up the current Claude Haiku model available in eu-central-1:\n" +
        "  aws bedrock list-foundation-models --region eu-central-1 --by-provider anthropic \\\n" +
        "    --query \"modelSummaries[?contains(modelId,'haiku')].modelId\"\n" +
        "If that model isn't directly invokable in eu-central-1 (some models require a\n" +
        "cross-region inference profile), also check:\n" +
        "  aws bedrock list-inference-profiles --region eu-central-1 \\\n" +
        "    --query \"inferenceProfileSummaries[?contains(inferenceProfileId,'haiku')].inferenceProfileId\"\n" +
        "Then set BEDROCK_MODEL_ID in .env."
    );
  }
  return modelId;
}

export interface PushoverConfig {
  token: string;
  user: string;
}

export function requirePushoverConfig(): PushoverConfig {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) {
    throw new Error(
      "Error: PUSHOVER_TOKEN and PUSHOVER_USER environment variables are required to send\n" +
        "notifications (any email the model marks notify: true, on a successful --apply run).\n" +
        "Create an application at https://pushover.net/apps/build for a token, and find your\n" +
        "user key on your Pushover dashboard at https://pushover.net/.\n" +
        "Pass --no-notify to run --apply without sending notifications instead."
    );
  }
  return { token, user };
}

// S3 bucket holding current.json / history/* (jmap-triage-mcp-proposal-v4.md).
// Read by the Lambda pipeline's cold-start prompt fetch (lambda.ts,
// current-prompt.ts) and by every jmap-triage-mcp tool. One bucket, one env
// var name, shared by both deployables -- see template.yaml.
export function requirePromptBucket(): string {
  const bucket = process.env.PROMPT_BUCKET;
  if (!bucket) {
    throw new Error(
      "Error: PROMPT_BUCKET environment variable is not set.\n" +
        "This is the S3 bucket holding current.json and history/* -- see\n" +
        "jmap-triage-mcp-proposal-v4.md's S3 layout section."
    );
  }
  return bucket;
}

export type { MailboxOverrides };

// Each override skips one Mailbox/query lookup and uses the given id
// directly -- same pattern as v4's TRIAGE_MAILBOX_ID (stable across runs,
// intended for the future Lambda deployment to set all six and skip every
// lookup). See triage.ts-DESIGN-v5-2026-08-02.md §3.2. Reads generically off
// MAILBOX_SPECS (mailboxes.ts) instead of a hand-written field per mailbox,
// so a new mailbox spec doesn't need a matching edit here.
export function readMailboxOverrides(): MailboxOverrides {
  const overrides: MailboxOverrides = {};
  for (const spec of MAILBOX_SPECS) {
    const value = process.env[spec.envVar];
    if (value) overrides[spec.key] = value;
  }
  return overrides;
}
