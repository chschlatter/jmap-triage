// Lambda entrypoint. Assembles the same PipelineConfig the CLI's main()
// builds from argv/.env, but from Lambda's own config sources instead: the
// three secrets (FASTMAIL_TOKEN, PUSHOVER_TOKEN, PUSHOVER_USER) come from
// SSM Parameter Store SecureStrings, fetched once per container and cached
// across warm invocations; everything else (BEDROCK_MODEL_ID, the six
// mailbox id overrides, LIMIT) is a plain Lambda env var. See
// triage.ts-DEPLOY-v1-2026-08-02.md §2/§3/§8.

import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { readMailboxOverrides, type PushoverConfig } from "./config.js";
import { runPipeline } from "./main.js";

const DEFAULT_LIMIT = 20;

interface Secrets {
  fastmailToken: string;
  pushoverToken: string;
  pushoverUser: string;
}

// Cached across warm invocations of the same container -- one SSM call per
// cold start, not per invocation.
let secretsPromise: Promise<Secrets> | undefined;

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
    });
  } catch (err) {
    // Rethrow (not swallow) so the invocation reports as failed -- Lambda's
    // Errors metric and default async-invoke retry both depend on that. See
    // triage.ts-DEPLOY-v1-2026-08-02.md §6/§7.
    console.error(err instanceof Error ? err.message : err);
    throw err;
  }
}
