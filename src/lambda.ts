// Lambda entrypoint. Assembles the same PipelineConfig the CLI's main()
// builds from argv/.env, but from Lambda's own config sources instead: the
// three secrets (FASTMAIL_TOKEN, PUSHOVER_TOKEN, PUSHOVER_USER) come from
// SSM Parameter Store SecureStrings, fetched once per container and cached
// across warm invocations; everything else (BEDROCK_MODEL_ID, the six
// mailbox id overrides, LIMIT) is a plain Lambda env var. See
// triage.ts-DEPLOY-v1-2026-08-02.md §2/§3/§8.
//
// The classification prompt itself is also fetched once per container and
// cached across warm invocations, from S3's current.json -- the live
// pointer jmap-triage-mcp's approve_prompt_diff writes -- falling back to
// the bundled prompt.ts if that fetch fails (see loadPrompt() below). This
// is what makes a prompt approval in the review loop actually change what
// production classifies with; before this, PROMPT/PROMPT_VERSION were
// imported directly from prompt.ts and nothing short of a redeploy could
// change them. See jmap-triage-mcp-proposal-v4.md.

import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { readMailboxOverrides, type PushoverConfig } from "./config.js";
import { getCurrentPrompt } from "./current-prompt.js";
import { runPipeline } from "./main.js";
import { PROMPT, PROMPT_VERSION } from "../prompt.js";

const DEFAULT_LIMIT = 20;

interface Secrets {
  fastmailToken: string;
  pushoverToken: string;
  pushoverUser: string;
}

// Cached across warm invocations of the same container -- one SSM call per
// cold start, not per invocation.
let secretsPromise: Promise<Secrets> | undefined;

interface LivePrompt {
  version: string;
  text: string;
}

// Cached across warm invocations, same as secretsPromise -- but unlike
// secrets, a failed S3 fetch is not fatal: loadPrompt() itself never
// rejects, it resolves to the bundled prompt.ts as a fail-open fallback and
// logs a warning. That fallback result is cached for the rest of the
// container's life too (not retried every invocation) -- an S3/history
// outage degrades this container to the bundled prompt until it's
// recycled, rather than paying a failed round trip on every single
// invocation. See jmap-triage-mcp-proposal-v4.md's S3-source-of-truth
// migration: without this, approve_prompt_diff's writes to current.json
// never reach production.
let promptPromise: Promise<LivePrompt> | undefined;

async function loadPrompt(): Promise<LivePrompt> {
  try {
    const current = await getCurrentPrompt();
    return { version: current.version, text: current.prompt };
  } catch (err) {
    console.warn(
      `Falling back to bundled prompt.ts (S3 fetch of current.json failed): ${
        err instanceof Error ? err.message : err
      }`
    );
    return { version: PROMPT_VERSION, text: PROMPT };
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function loadSecrets(): Promise<Secrets> {
  const fastmailTokenParam = requireEnv("FASTMAIL_TOKEN_PARAM");
  const pushoverTokenParam = requireEnv("PUSHOVER_TOKEN_PARAM");
  const pushoverUserParam = requireEnv("PUSHOVER_USER_PARAM");

  const ssm = new SSMClient({});
  const response = await ssm.send(
    new GetParametersCommand({
      Names: [fastmailTokenParam, pushoverTokenParam, pushoverUserParam],
      WithDecryption: true,
    })
  );

  if (response.InvalidParameters && response.InvalidParameters.length > 0) {
    throw new Error(`SSM parameters not found: ${response.InvalidParameters.join(", ")}`);
  }

  const byName = new Map((response.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const fastmailToken = byName.get(fastmailTokenParam);
  const pushoverToken = byName.get(pushoverTokenParam);
  const pushoverUser = byName.get(pushoverUserParam);
  if (!fastmailToken || !pushoverToken || !pushoverUser) {
    throw new Error("One or more SSM parameters returned an empty value");
  }

  return { fastmailToken, pushoverToken, pushoverUser };
}

// event.dryRun overrides the default apply:true/notify:true production
// path -- e.g. `aws lambda invoke --payload '{"dryRun": true}'` to validate
// a deployment against real Inbox/Triage state without moving mail. See
// triage.ts-DEPLOY-v1-2026-08-02.md §8.
export interface LambdaEvent {
  dryRun?: boolean;
}

export async function handler(event: LambdaEvent | undefined): Promise<void> {
  try {
    secretsPromise ??= loadSecrets();
    // A failed fetch must not stick around for the next warm invocation --
    // clear the cache so it retries SSM instead of failing forever.
    const secrets = await secretsPromise.catch((err) => {
      secretsPromise = undefined;
      throw err;
    });

    promptPromise ??= loadPrompt();
    const prompt = await promptPromise;

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
      modelId: requireEnv("BEDROCK_MODEL_ID"),
      pushover,
      mailboxOverrides: readMailboxOverrides(),
      options: { limit, apply, notify: apply },
      prompt,
    });
  } catch (err) {
    // Rethrow (not swallow) so the invocation reports as failed -- Lambda's
    // Errors metric and default async-invoke retry both depend on that. See
    // triage.ts-DEPLOY-v1-2026-08-02.md §6/§7.
    console.error(err instanceof Error ? err.message : err);
    throw err;
  }
}
