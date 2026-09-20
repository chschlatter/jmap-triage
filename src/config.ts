// .env loading, CLI flag parsing, and env-var validation. Kept separate from
// the modules that consume the values so a new required env var or flag
// touches one file, not the orchestration logic in main.ts.
//
// Error messages here name the missing variable and point at README.md's
// Configuration section rather than inlining setup instructions -- they fire
// for one operator on a machine that either has a working .env or needs the
// README anyway.

import { MAILBOX_SPECS, type MailboxOverrides } from "./mailboxes.js";
import type { ClassifierConfig } from "./classify.js";

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
// --apply): perform moves, skip Pushover.
export function parseArgs(argv: string[]): CliOptions {
  const apply = argv.includes("--apply");
  const notify = apply && !argv.includes("--no-notify");
  return { limit: parseLimit(argv), apply, notify };
}

function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (${purpose}). See README.md, Configuration.`);
  }
  return value;
}

export function requireFastmailToken(): string {
  return requireEnv("FASTMAIL_TOKEN", "Fastmail API token, Mail read/write scope");
}

// Used by every non-Lambda caller (CLI main(), evaluate.ts inside
// McpServerFunction). lambda.ts does NOT use this: TriageFunction threads its
// secrets through explicitly rather than mutating process.env, so it builds
// its ClassifierConfig inline instead.
export function requireModelConfig(): ClassifierConfig {
  return {
    apiKey: requireEnv("GREENPT_API_KEY", "GreenPT API key, greenpt.com"),
    // Verify a new id against GET https://api.greenpt.ai/v1/models before
    // setting it -- a plan restriction can hide a model the key cannot
    // invoke (DECISIONS.md, 2026-09-06).
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

// S3 bucket holding current.json / history/* -- see ARCHITECTURE.md. Read by
// every classify-path caller's live prompt fetch (current-prompt.ts) and by
// every jmap-triage-mcp tool. One bucket, one env var name, shared by both
// deployables -- see template.yaml.
export function requirePromptBucket(): string {
  return requireEnv("PROMPT_BUCKET", "S3 bucket holding current.json and history/*");
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
