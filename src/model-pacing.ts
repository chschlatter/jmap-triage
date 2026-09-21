// How fast/concurrently the classifier may be called. Every caller (main.ts,
// evaluate.ts, eval/run-eval.ts) goes through runPaced(), so a model change
// stays correctly paced everywhere.
//
// Measured, not read off vendor docs -- GreenPT publishes no rate limits and
// returns no x-ratelimit-* headers. Probe results: DECISIONS.md. Re-measure
// before raising either number.

const MODEL_DELAY_MS: Record<string, number> = {
  "glm-5.3-flash": 150,
};
const DEFAULT_DELAY_MS = 150;
// Sized so TriageFunction's worst observed case still fits its 240s budget.
// GreenPT's latency is a ~30s floor per call with a ~94s tail (re-measured
// 2026-09-21), so LIMIT=20 costs ceil(20/CONCURRENCY) waves of up to 94s:
// at 4 that is 5 waves = 470s (over budget), at 8 3 waves = 282s (over), at
// 10 it is 2 waves = 188s, which fits. Going past 10 does not buy a wave
// back at LIMIT=20, so it would be risk without benefit. A 1/4/8/16 probe
// measured zero throttled and zero failed at every level.
const CONCURRENCY = 10;

export function getPacingDelayMs(modelId: string): number {
  return MODEL_DELAY_MS[modelId] ?? DEFAULT_DELAY_MS;
}

export function getConcurrency(): number {
  return CONCURRENCY;
}

// Keeps a long run (a bigger golden set, a large counterweight sample) from
// sustaining full concurrency for minutes against limits only ever probed in
// short bursts. The cooldown is a full 60s window, so every pre-pause call
// has aged out by the time the burst resumes.
export const MAX_BURST_CALLS = 100;
export const BURST_COOLDOWN_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// onItemDone fires as each item finishes, so out of input order under
// concurrency > 1 -- it's for progress logging. The returned array stays
// indexed in input order regardless.
// concurrency overrides CONCURRENCY for offline callers only. The default is
// sized for TriageFunction, which shares an account-wide Lambda limit and a
// 240s budget; an eval run on a laptop has neither constraint.
export async function runPaced<T, R>(
  items: T[],
  modelId: string,
  fn: (item: T, index: number) => Promise<R>,
  onItemDone?: (result: R, item: T, index: number) => void,
  concurrency: number = CONCURRENCY
): Promise<R[]> {
  const delayMs = getPacingDelayMs(modelId);
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

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return results;
}
