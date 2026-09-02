// .env loading, CLI flag parsing, and env-var validation. Kept separate from
// the modules that consume the values so a new required env var or flag
// touches one file, not the orchestration logic in main.ts.

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { MAILBOX_SPECS, type MailboxOverrides } from "./mailboxes.js";
import type { ClassifierConfig } from "./classify.js";

const DEFAULT_LIMIT = 20;
const BEDROCK_REGION = "eu-central-1";

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
// --apply): perform moves, skip Pushover.
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

// Provider-agnostic entrypoint every non-Lambda caller (CLI main(),
// evaluate.ts inside McpServerFunction) uses instead of reaching for
// requireBedrockModelId() directly -- MODEL_PROVIDER picks which of the two
// underlying providers actually classifies. Defaults to "bedrock" when
// unset so an existing .env with only BEDROCK_MODEL_ID keeps working
// unchanged. lambda.ts does NOT use this: TriageFunction threads its three
// secrets through explicitly rather than mutating process.env (see its own
// loadSecrets()), so it builds its ClassifierConfig inline instead.
export function requireModelConfig(): ClassifierConfig {
  const provider = process.env.MODEL_PROVIDER ?? "bedrock";

  if (provider === "mistral") {
    const apiKey = process.env.MISTRAL_API_KEY;
    const modelId = process.env.MISTRAL_MODEL_ID;
    if (!apiKey || !modelId) {
      throw new Error(
        "Error: MISTRAL_API_KEY and MISTRAL_MODEL_ID environment variables are both required\n" +
          "when MODEL_PROVIDER=mistral.\n" +
          "Create a key at https://console.mistral.ai/ and check which models your account's\n" +
          "tier can actually call (some, e.g. mistral-large-latest, return a 403\n" +
          "tier_not_allowed on lower tiers -- verify with a direct API call before setting\n" +
          "MISTRAL_MODEL_ID, don't assume the name from Mistral's docs is available).\n" +
          "Then set both in .env."
      );
    }
    return { provider: "mistral", apiKey, modelId };
  }

  if (provider !== "bedrock") {
    throw new Error(`Error: Unknown MODEL_PROVIDER "${provider}" -- expected "bedrock" or "mistral".`);
  }
  return { provider: "bedrock", client: new BedrockRuntimeClient({ region: BEDROCK_REGION }), modelId: requireBedrockModelId() };
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

// S3 bucket holding current.json / history/* -- see ARCHITECTURE.md.
// Read by every classify-path caller's live prompt fetch (current-prompt.ts)
// and by every jmap-triage-mcp tool. One bucket, one env var name, shared by
// both deployables -- see template.yaml.
export function requirePromptBucket(): string {
  const bucket = process.env.PROMPT_BUCKET;
  if (!bucket) {
    throw new Error(
      "Error: PROMPT_BUCKET environment variable is not set.\n" +
        "This is the S3 bucket holding current.json and history/* -- see\n" +
        "ARCHITECTURE.md's prompt section."
    );
  }
  return bucket;
}

export type { MailboxOverrides };

// Each override skips one Mailbox/query lookup and uses the given id
// directly -- ids are stable across runs, which is what lets the Lambda
// deployment set all six and skip every lookup. Reads generically off
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
