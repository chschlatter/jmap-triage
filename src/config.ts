// .env loading, CLI flag parsing, env-var validation. Separate from the
// modules that consume the values, so a new env var or flag touches one file.

import { MAILBOX_SPECS, type MailboxOverrides } from "./mailboxes.js";
import type { ClassifierConfig } from "./classify.js";

// Halved when triage became two rounds: each email now costs two model calls,
// so 10 emails is the same 20 calls -- two waves at the current concurrency,
// which still fits TriageFunction's 240s budget at the provider's slow-day
// latency (DECISIONS.md).
const DEFAULT_LIMIT = 10;

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

// Default is dry run; --no-notify is only meaningful with --apply.
export function parseArgs(argv: string[]): CliOptions {
  const apply = argv.includes("--apply");
  const notify = apply && !argv.includes("--no-notify");
  return { limit: parseLimit(argv), apply, notify };
}

function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (${purpose}). See README.md, Prerequisites.`);
  }
  return value;
}

export function requireFastmailToken(): string {
  return requireEnv("FASTMAIL_TOKEN", "Fastmail API token, Mail read/write scope");
}

// Every non-Lambda caller (CLI main(), evaluate.ts). lambda.ts builds its
// ClassifierConfig inline instead -- it threads secrets through explicitly
// rather than mutating process.env.
export function requireModelConfig(): ClassifierConfig {
  return {
    apiKey: requireEnv("GREENPT_API_KEY", "GreenPT API key, greenpt.com"),
    // Verify a new id against GET /v1/models first -- a plan restriction can
    // hide a model the key cannot invoke (DECISIONS.md).
    modelId: requireEnv("GREENPT_MODEL_ID", "GreenPT model id, e.g. glm-5.3-flash"),
  };
}

export interface PushoverConfig {
  token: string;
  user: string;
}

export function requirePushoverConfig(): PushoverConfig {
  return {
    token: requireEnv("PUSHOVER_TOKEN", "Pushover application token; or pass --no-notify"),
    user: requireEnv("PUSHOVER_USER", "Pushover user key; or pass --no-notify"),
  };
}

// One bucket, shared by both deployables: every classify path's live prompt
// fetch and every MCP tool read/write it. See ARCHITECTURE.md.
export function requirePromptBucket(): string {
  return requireEnv("PROMPT_BUCKET", "S3 bucket holding current.json and history/*");
}

export type { MailboxOverrides };

// Each override skips one Mailbox/query lookup. Read off MAILBOX_SPECS rather
// than a field per mailbox, so a new spec needs no edit here.
export function readMailboxOverrides(): MailboxOverrides {
  const overrides: MailboxOverrides = {};
  for (const spec of MAILBOX_SPECS) {
    const value = process.env[spec.envVar];
    if (value) overrides[spec.key] = value;
  }
  return overrides;
}
