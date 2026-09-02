// Lambda entrypoint. Assembles the same PipelineConfig the CLI's main()
// builds from argv/.env, but from Lambda's own config sources instead: the
// secrets (FASTMAIL_TOKEN, PUSHOVER_TOKEN, PUSHOVER_USER, and MISTRAL_API_KEY
// when MODEL_PROVIDER=mistral) come from SSM Parameter Store SecureStrings,
// fetched once per container and cached across warm invocations; everything
// else (BEDROCK_MODEL_ID, MODEL_PROVIDER, MISTRAL_MODEL_ID, the six mailbox
// id overrides, LIMIT) is a plain Lambda env var.
//
// The classification prompt itself is also fetched once per container and
// cached across warm invocations, from S3's current.json -- the live
// pointer jmap-triage-mcp's approve_prompt_diff writes (see loadPrompt()
// below). This is what makes a prompt approval in the review loop actually
// change what production classifies with. There is no bundled local
// fallback (no prompt.ts) -- the real prompt describes a specific person,
// so a "safe to commit" bundled copy would have to be either generic-and-
// wrong or PII-bearing-and-uncommittable; see current-prompt.ts's header
// comment. A failed S3 fetch is therefore fatal, same as a failed secrets
// fetch below, not a silent degrade.

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { readMailboxOverrides, type PushoverConfig } from "./config.js";
import type { ClassifierConfig } from "./classify.js";
import { getCurrentPrompt } from "./current-prompt.js";
import { runPipeline } from "./main.js";

const DEFAULT_LIMIT = 20;
const BEDROCK_REGION = "eu-central-1";

interface Secrets {
  fastmailToken: string;
  pushoverToken: string;
  pushoverUser: string;
  // Only fetched (see loadSecrets()) when MODEL_PROVIDER=mistral -- a
  // Bedrock-mode deploy has no dependency on the Mistral SSM parameter
  // existing at all, which is what keeps the provider genuinely switchable.
  mistralApiKey?: string;
}

// Cached across warm invocations of the same container -- one SSM call per
// cold start, not per invocation.
let secretsPromise: Promise<Secrets> | undefined;

interface LivePrompt {
  version: string;
  text: string;
}

// Cached across warm invocations, same pattern as secretsPromise -- one S3
// round trip per cold start, not per invocation. Unlike the old fail-open
// version, a failed fetch here is fatal (no bundled prompt.ts to fall back
// to) -- handler() clears this cache on failure the same way it already
// does for secretsPromise, so the next invocation retries S3 instead of
// failing forever on a stale rejected promise.
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
  const fastmailTokenParam = requireEnv("FASTMAIL_TOKEN_PARAM");
  const pushoverTokenParam = requireEnv("PUSHOVER_TOKEN_PARAM");
  const pushoverUserParam = requireEnv("PUSHOVER_USER_PARAM");
  // Only requested when MODEL_PROVIDER=mistral -- a Bedrock-mode deploy
  // never touches this param name, so it doesn't need to exist in SSM at
  // all until someone actually switches the provider.
  const mistralApiKeyParam = process.env.MODEL_PROVIDER === "mistral" ? requireEnv("MISTRAL_API_KEY_PARAM") : undefined;

  const names = [fastmailTokenParam, pushoverTokenParam, pushoverUserParam];
  if (mistralApiKeyParam) names.push(mistralApiKeyParam);

  const ssm = new SSMClient({});
  const response = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));

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
  const mistralApiKey = mistralApiKeyParam ? byName.get(mistralApiKeyParam) : undefined;
  if (mistralApiKeyParam && !mistralApiKey) {
    throw new Error("MISTRAL_API_KEY_PARAM SSM parameter returned an empty value");
  }

  return { fastmailToken, pushoverToken, pushoverUser, mistralApiKey };
}

function loadModelConfig(secrets: Secrets): ClassifierConfig {
  const provider = process.env.MODEL_PROVIDER ?? "bedrock";
  if (provider === "mistral") {
    return {
      provider: "mistral",
      apiKey: secrets.mistralApiKey!, // guaranteed by loadSecrets() when provider is "mistral"
      modelId: requireEnv("MISTRAL_MODEL_ID"),
    };
  }
  return { provider: "bedrock", client: new BedrockRuntimeClient({ region: BEDROCK_REGION }), modelId: requireEnv("BEDROCK_MODEL_ID") };
}

// event.dryRun overrides the default apply:true/notify:true production
// path -- e.g. `aws lambda invoke --payload '{"dryRun": true}'` to validate
// a deployment against real Inbox/Triage state without moving mail.
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
    // Rethrow (not swallow) so the invocation reports as failed -- Lambda's
    // Errors metric and default async-invoke retry both depend on that.
    console.error(err instanceof Error ? err.message : err);
    throw err;
  }
}
