// TriageFunction entrypoint. Builds the same PipelineConfig as the CLI's
// main(), but from Lambda's sources: secrets from SSM SecureStrings,
// everything else (GREENPT_MODEL_ID, mailbox id overrides, LIMIT) from plain
// env vars, both fetched once per container.
//
// The prompt is cached the same way, from S3's current.json -- the pointer
// approve_prompt_diff writes, which is what makes a review-loop approval
// change what production classifies with. A failed fetch is fatal; there is
// no local fallback (DECISIONS.md).

import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { readMailboxOverrides, type PushoverConfig } from "./config.js";
import type { ClassifierConfig } from "./classify.js";
import { getCurrentPrompt } from "./current-prompt.js";
import { runPipeline } from "./main.js";

const DEFAULT_LIMIT = 20;

interface Secrets {
  fastmailToken: string;
  pushoverToken: string;
  pushoverUser: string;
  greenptApiKey: string;
}

// One SSM call per cold start, not per invocation.
let secretsPromise: Promise<Secrets> | undefined;

interface LivePrompt {
  version: string;
  text: string;
}

// Same caching pattern as secretsPromise, including handler() clearing it on
// failure so the next invocation retries instead of failing forever.
let promptPromise: Promise<LivePrompt> | undefined;

async function loadPrompt(): Promise<LivePrompt> {
  const current = await getCurrentPrompt();
  return { version: current.version, text: current.prompt };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function loadSecrets(): Promise<Secrets> {
  const params = {
    fastmailToken: requireEnv("FASTMAIL_TOKEN_PARAM"),
    pushoverToken: requireEnv("PUSHOVER_TOKEN_PARAM"),
    pushoverUser: requireEnv("PUSHOVER_USER_PARAM"),
    greenptApiKey: requireEnv("GREENPT_API_KEY_PARAM"),
  };

  const ssm = new SSMClient({});
  const response = await ssm.send(
    new GetParametersCommand({ Names: Object.values(params), WithDecryption: true })
  );

  if (response.InvalidParameters && response.InvalidParameters.length > 0) {
    throw new Error(`SSM parameters not found: ${response.InvalidParameters.join(", ")}`);
  }

  const byName = new Map((response.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const secrets = Object.fromEntries(
    Object.entries(params).map(([field, name]) => {
      const value = byName.get(name);
      if (!value) throw new Error(`SSM parameter ${name} returned an empty value`);
      return [field, value];
    })
  ) as unknown as Secrets;

  return secrets;
}

function loadModelConfig(secrets: Secrets): ClassifierConfig {
  return { apiKey: secrets.greenptApiKey, modelId: requireEnv("GREENPT_MODEL_ID") };
}

// event.dryRun overrides the default apply:true/notify:true, to validate a
// deployment against real Inbox/Triage state without moving mail.
export interface LambdaEvent {
  dryRun?: boolean;
}

export async function handler(event: LambdaEvent | undefined): Promise<void> {
  try {
    secretsPromise ??= loadSecrets();
    // Don't let a rejected promise stick around for the next invocation.
    const secrets = await secretsPromise.catch((err) => {
      secretsPromise = undefined;
      throw err;
    });

    promptPromise ??= loadPrompt();
    const prompt = await promptPromise.catch((err) => {
      promptPromise = undefined;
      throw err;
    });

    const apply = !(event?.dryRun ?? false);
    const pushover: PushoverConfig | null = apply
      ? { token: secrets.pushoverToken, user: secrets.pushoverUser }
      : null;

    const limitEnv = process.env.LIMIT;
    const limit = limitEnv ? Number(limitEnv) : DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`Invalid LIMIT env var: ${limitEnv}`);
    }

    await runPipeline({
      token: secrets.fastmailToken,
      model: loadModelConfig(secrets),
      pushover,
      mailboxOverrides: readMailboxOverrides(),
      options: { limit, apply, notify: apply },
      prompt,
    });
  } catch (err) {
    // Rethrow so the invocation reports as failed -- Lambda's Errors metric
    // and its async-invoke retry both depend on that.
    console.error(err instanceof Error ? err.message : err);
    throw err;
  }
}
