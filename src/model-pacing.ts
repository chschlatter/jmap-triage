// Single source of truth for how fast/concurrently a Bedrock model can be
// called without hitting its RPM quota. Every caller (main.ts, evaluate.ts,
// eval/run-eval.ts) goes through this instead of its own hand-copied
// constant, so a BEDROCK_MODEL_ID change stays correctly paced everywhere
// automatically.
//
// RPM values come from this account's actual Bedrock quotas
// (`aws service-quotas list-service-quotas --service-code bedrock`, filter
// on "requests per minute"), not vendor docs -- they're account-specific.
// Observed pattern: any model callable on-demand (no cross-region
// inference profile) gets a flat 100 RPM in this account; every model that
// can *only* be invoked through a cross-region inference profile (every
// current Claude model here) is capped much lower, 2-10 RPM.
//
// Delay values are NOT a naive 60000/RPM -- real call latency overlaps
// with the artificial delay rather than adding to it, and how much of the
// RPM budget that latency alone covers differs by tier. At the fast tier
// this was measured empirically (150ms sleep + real latency held ~93
// req/min against a 100 RPM quota, no throttling). At the slow tier,
// latency is comparatively negligible against a 10 RPM budget, so the
// delay sits close to the full naive 6000ms (60000/10) instead.
const FAST_TIER_DELAY_MS = 150; // on-demand models, 100 RPM in this account
const SLOW_TIER_DELAY_MS = 6000; // cross-region-profile-only models, 10 RPM in this account

const KNOWN_MODEL_DELAY_MS: Record<string, number> = {
  // On-demand, 100 RPM.
  "openai.gpt-oss-20b-1:0": FAST_TIER_DELAY_MS,
  "openai.gpt-oss-120b-1:0": FAST_TIER_DELAY_MS,
  "qwen.qwen3-235b-a22b-2507-v1:0": FAST_TIER_DELAY_MS,
  "qwen.qwen3-32b-v1:0": FAST_TIER_DELAY_MS,
  "zai.glm-4.7-flash": FAST_TIER_DELAY_MS,
  "minimax.minimax-m2.5": FAST_TIER_DELAY_MS,
  // Cross-region inference profile only.
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0": SLOW_TIER_DELAY_MS,
  "global.anthropic.claude-haiku-4-5-20251001-v1:0": SLOW_TIER_DELAY_MS,
};

// Mistral (api.mistral.ai directly, not Bedrock) uses its own tier system
// entirely separate from the Bedrock RPM numbers above -- measured
// empirically against this account's tier during the eval that validated
// this model (eval/run-eval-mistral.ts), not read off vendor docs.
// Concurrency 4/300ms and even 1/1500ms both produced persistent 429s
// against mistral-medium-latest on this account; 1/4000ms ran the full
// 36-case golden set clean. mistral-large-latest isn't a pacing problem to
// solve here at all -- it returned 403 tier_not_allowed outright (confirmed
// via direct curl), meaning this account's subscription tier can't call it
// regardless of pacing. Re-measure before trusting a different Mistral
// model id or a different account's tier.
const MISTRAL_MODEL_DELAY_MS: Record<string, number> = {
  "mistral-medium-latest": 4000,
};
const MISTRAL_DEFAULT_DELAY_MS = 4000;
const MISTRAL_CONCURRENCY = 1;

export type ModelProvider = "bedrock" | "mistral";

// A Bedrock model not yet catalogued above falls back to the slow tier
// rather than the fast one: under-guessing costs wall-clock time,
// over-guessing costs throttling retries against a quota we haven't
// actually confirmed. invokeBedrock's retry-with-backoff (classify.ts) is
// still a second line of defense either way, but this fallback is meant to
// avoid leaning on it.
export function getPacingDelayMs(provider: ModelProvider, modelId: string): number {
  if (provider === "mistral") return MISTRAL_MODEL_DELAY_MS[modelId] ?? MISTRAL_DEFAULT_DELAY_MS;
  return KNOWN_MODEL_DELAY_MS[modelId] ?? SLOW_TIER_DELAY_MS;
}

// How many classifyBatch calls may run concurrently. Against a slow-tier
// (cross-region-profile) Bedrock model, or against Mistral on this
// account's tier, the RPM quota itself is the bottleneck -- concurrency
// there just means more simultaneous demand on the same ceiling, which
// measured out as throttling retries and outright failures with no
// throughput gain. Against a fast-tier (on-demand) Bedrock model the quota
// isn't the bottleneck -- real call latency is -- so a worker pool gives a
// real speedup; burst-tested at up to 8 concurrent workers with zero
// errors. That burst test only ran a few seconds at a time, well short of
// a sustained minute-long load, which is what MAX_BURST_CALLS/
// BURST_COOLDOWN_MS below guard against.
const FAST_TIER_CONCURRENCY = 8;
const SLOW_TIER_CONCURRENCY = 1;

export function getConcurrency(provider: ModelProvider, modelId: string): number {
  if (provider === "mistral") return MISTRAL_CONCURRENCY;
  return KNOWN_MODEL_DELAY_MS[modelId] === FAST_TIER_DELAY_MS ? FAST_TIER_CONCURRENCY : SLOW_TIER_CONCURRENCY;
}

// Pause after every MAX_BURST_CALLS completed so a long-running call (a
// bigger GOLDEN_SET, a larger live counterweight sample) can't quietly run
// concurrency=8 for minutes against a quota only ever burst-tested for a
// few seconds at a time. BURST_COOLDOWN_MS is a full rate-limit window
// (60s) so every call from before the pause has aged out of the quota's
// rolling window by the time the burst resumes -- the simplest guarantee
// available without knowing Bedrock's exact window/refill algorithm.
export const MAX_BURST_CALLS = 100;
export const BURST_COOLDOWN_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared concurrency-limited, burst-capped executor -- used by main.ts's
// production classify loop, evaluate_candidate's live-mail replay, and
// eval/run-eval.ts alike. onItemDone fires as each item finishes (out of
// input order under concurrency > 1) -- use it for progress logging; the
// returned array stays indexed in input order regardless.
export async function runPaced<T, R>(
  items: T[],
  provider: ModelProvider,
  modelId: string,
  fn: (item: T, index: number) => Promise<R>,
  onItemDone?: (result: R, item: T, index: number) => void
): Promise<R[]> {
  const concurrency = getConcurrency(provider, modelId);
  const delayMs = getPacingDelayMs(provider, modelId);
  const results: R[] = new Array(items.length);

  let nextIndex = 0;
  let completedSinceCooldown = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      const result = await fn(items[i], i);
      results[i] = result;
      onItemDone?.(result, items[i], i);

      if (nextIndex >= items.length) return;

      completedSinceCooldown++;
      if (completedSinceCooldown >= MAX_BURST_CALLS) {
        completedSinceCooldown = 0;
        await sleep(BURST_COOLDOWN_MS);
      } else if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
