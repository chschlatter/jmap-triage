# Decisions

Measured results and rejected alternatives. This file exists so the modules
and [ARCHITECTURE.md](ARCHITECTURE.md) can state *what* they do without also
carrying the record of *why that number and not another one*.

Everything here was measured against this account, this mailbox and this
prompt. Re-measure before trusting any of it for a different model or
provider tier.

---

## 2026-09-20 — Classifier is GreenPT, and only GreenPT

`glm-5.3-flash` on api.greenpt.ai (Utrecht NL, renewable EU datacenters).

**Why.** The point is EU *ownership*, not EU residency. Bedrock eu-central-1
already kept this mailbox's content in the EU — that is why deepseek-v3.2 was
rejected below despite tying for best accuracy — but AWS is US-owned.
GreenPT's API-only account has no monthly fee despite the pricing page's
"requires an active Pro, Teams, or API-only subscription" wording, bills per
token (EUR 0.11/M in, 0.022/M cached in, 0.44/M out), and its credits do not
expire.

**Accuracy.** 35-36/36 category and 29-31/36 notify across four runs against
the live v10 prompt, at or above the `qwen.qwen3-235b-a22b-2507-v1:0` Bedrock
baseline it replaced (35/36, 28/36). Run-to-run variance is real — temperature
0 is not deterministic on a MoE model — so treat a single run as a range.

**Pacing: concurrency 4, 150ms delay.** A 40-request-per-level probe at
1/2/4/8 came back zero throttled and zero failed at every level, extrapolating
to 537 req/min at the top. GreenPT publishes no rate limits and returns no
`x-ratelimit-*` headers, so measuring was the only option. Deployed at 4, not
8, because:

- The concurrency-8 level finished its 40 requests in 4.5 seconds, so "537
  req/min" is extrapolation from a 4.5-second burst, not a sustained minute.
  Concurrency 4 halves peak demand while still collapsing TriageFunction's 20
  calls (`LIMIT=20`) into 5 waves.
- p99 latency measured 1.74s on one 36-call run and 6.76s on another — the
  tail is not well characterised by samples this small. At concurrency 4 the
  delay costs ~0.75s across a 20-email invocation; worst case that invocation
  needs ~34s of the 240s budget.

**Latency re-measured 2026-09-21: wildly variable, so plan for the tail.**
Across one session GreenPT served the same 36-case golden set in anywhere
from **10s to 395s** at the same concurrency. Per-call latency ranged from
~3s in fast periods to ~30s in slow ones, with a 94s outlier. Within any one
period it is flat in input size (269 vs 1528 prompt tokens both ~30s for
45-60 output tokens), so the slow periods are provider capacity, not our
payload, and not queueing: a 1/4/8/16 concurrency probe during a slow period
measured 0.03 / 0.14 / 0.31 / 0.49 req/s with **zero** throttled or failed at
every level. Throughput scales with concurrency at any latency.

The practical consequence is that a single timing or quality number means
nothing. Size the pacing against the slow case, not the median.

**So concurrency moved 4 -> 10.** The binding constraint is no longer peak
demand, it is wave count against a fixed timeout. `LIMIT=20` costs
`ceil(20/concurrency)` waves of up to 94s:

| concurrency | waves | worst case | 240s budget |
|---|---|---|---|
| 4 | 5 | 470s | over |
| 8 | 3 | 282s | over |
| **10** | **2** | **188s** | **fits** |
| 16+ | 2 | 188s | no further gain at `LIMIT=20` |

10 is the smallest value that makes the worst observed case fit, and past it
the wave count stops improving, so more concurrency would be risk without
benefit. This also pulls `evaluate_candidate` back inside Claude Desktop's
240s MCP timeout: a ~50-call replay was 13 waves (~390s) at concurrency 4 and
is 5 waves (~150s) at 10.

Offline callers can override per call — `eval/ph1/run-ph1.ts` runs at 16
(`PH1_CONCURRENCY`), which took a 57-call run from ~7 minutes to 21s.

## 2026-09-21 — round 1's `signal` field is load-bearing, not decoration

DESIGN-v8 §5.3 asked whether round 1's `signal` enum was worth its schema
surface, given the project rejects model self-report for rule attribution
(DESIGN-v7). It was dropped on that reasoning while moving the prompt into
S3 — and the offline score fell from 57/57 to 56/57, with the **same**
message flipping phishing → clean on three consecutive runs (an unsolicited
offer from a throwaway domain). Restoring the field restored 57/57.

So the enum is not display: asking the model to name which signal it acted on
makes it check the list, and without that it reads a throwaway-domain
solicitation as ordinary marketing. It stays in the prompt as reasoning
scaffolding.

The self-report stance is unchanged — `signal` is shown in the round-1 table
and never used to attribute a decision to a prompt rule, so nothing tunes
against it. This is also a reminder that "this field is only for display"
is a claim to measure, not to assume.

**Reading `npm run eval` scores.** Seven runs of the unchanged v10 prompt in
one session scored category 30, 35, 35, 35, 36, 36, 36 out of 36 and notify
30-31/36. Six cluster at 35-36; the 30 was the 395s run. `buildRow` sets
`categoryOk: false` on a failed API call but leaves `notifyOk` undefined, and
the notify filter tests `=== false`, so **API failures depress the category
score and leave notify untouched** — which is precisely the shape of that
run. Treat a category score more than one or two below 36 as a provider
symptom to re-run, not a regression, and check the error count first.

**Cost.** ~EUR 0.15-1.40/month at 100 emails/day. 90-97% of input tokens hit
GreenPT's prompt cache at EUR 0.022/M, because one-email-per-call resends an
identical system prompt every time. That same repetition is what blew
Mistral's TPM ceiling; here it is the cheap part.

**Rejected EU-owned alternatives**, so they are not re-litigated:

| provider | verdict |
|---|---|
| Melious (Saarbrücken DE) | B2B only, no consumer accounts — a personal mailbox is not a business. Catalog and limits were fine (glm-5.3-flash, 180 req/min); the wallet was not. |
| Nebius (Amsterdam HQ, EU residency FI/FR) | Viable fallback. True pay-as-you-go, model id `zai-org/GLM-5.3-Flash`. Signup asks for a company or university name. |

### Rollback path

Bedrock and Mistral support was removed from the code on 2026-09-20 (below),
so rollback is no longer the config-only flip it was on the day of the
cutover. If GreenPT fails:

1. `git revert` the "Collapse three classifier providers to one" commit —
   restores `invokeBedrock`, the `ModelProvider` parameter, `BedrockModelId`,
   the Bedrock IAM statement and `@aws-sdk/client-bedrock-runtime`.
2. Set `ModelProvider="bedrock"` and
   `BedrockModelId="qwen.qwen3-235b-a22b-2507-v1:0"` in `samconfig.toml`. That
   model id was live and valid as of the cutover.
3. Redeploy.

Nebius is the faster path if the problem is GreenPT specifically rather than
the OpenAI-compatible transport: it needs a base URL and a key, not a revert.

---

## 2026-09-20 — Three classifier providers collapsed to one

`classify.ts` briefly supported bedrock / mistral / greenpt behind a
`MODEL_PROVIDER` switch, with matching branches in `config.ts`, `lambda.ts`,
`mcp-server.ts`, `model-pacing.ts` and `template.yaml`.

Removed because the switch cost a discriminated union, three config branches,
three pacing tables, a per-provider SSM fetch table, four CloudFormation
parameters and a Bedrock IAM statement — to keep alive one provider already
proven unusable (Mistral) and one the cutover had deliberately moved off
(Bedrock). The rollback path above is cheaper than carrying the switch.

`invokeOpenAICompatible` survives as the single transport: swapping GreenPT
for another OpenAI-compatible EU provider is a base URL and a key.

---

## 2026-09-06 — Mistral rolled back (cutover was 2026-09-02)

Rate-limited to the point of unusable. This account's tier caps
`mistral-medium-latest` at **20,000 tokens/minute**, which one-email-per-call
blows through in under a minute of steady traffic: every request resends the
~950-token system prompt plus up to ~1100 tokens of body
(`MAX_BODY_VALUE_BYTES=4000`), so worst case is ~2200 tokens/request.

The pacing delay at the time (4000ms) had been tuned only against the
requests-per-second limit — persistent 429s below 1/1500ms, clean at 1/4000ms
on the golden set — and never checked against TPM. 1/4000ms is 15 req/min,
i.e. up to ~33,000 TPM against a 20,000 cap. RPS was never the binding
constraint.

No quick fix on Mistral's side: the account only advances tiers on cumulative
lifetime billing, not prepaid credit. `mistral-large-latest` was not an option
either — 403 `tier_not_allowed`, confirmed by direct curl, regardless of
pacing.

**The lesson that outlived Mistral:** the binding constraint here is not
accuracy and not p50 latency — it is whether 20 sequential classify calls fit
inside TriageFunction's 240s timeout at `LIMIT=20`. Check a new provider
against that first, and confirm its model id against its own `/v1/models`
before setting it.

---

## 2026-09-06 — Bedrock model chosen by comparison, not by default

When Mistral was rolled back, the pipeline did not go back to
`openai.gpt-oss-120b-1:0`. A golden-set comparison across the open-weight
models this account could invoke showed it was the weakest of four (31/36
category, 28/36 notify).

| model | verdict |
|---|---|
| `qwen.qwen3-235b-a22b-2507-v1:0` | Chosen. Tied for best category accuracy (35/36), ~5x faster than the others in that run, stays in eu-central-1. |
| `deepseek.v3.2` | Tied on accuracy, but only offered in us-east-1 — would send this mailbox's content out of the EU on every call. Rejected on residency alone. |
| `openai.gpt-oss-120b-1:0` | Weakest of four. |

### Bedrock rate-limit tiers in this account

Kept for the rollback path. From `aws service-quotas list-service-quotas
--service-code bedrock` filtered on "requests per minute" — account-specific,
not vendor docs.

- Any model callable on-demand (no cross-region inference profile): flat **100
  RPM**. Measured pacing was 150ms + real latency, holding ~93 req/min with no
  throttling, at concurrency 8.
- Any model invokable *only* through a cross-region inference profile (every
  Claude model here): **2-10 RPM**. Paced at 6000ms, concurrency 1.

Delays were never a naive 60000/RPM: real call latency overlaps with the
artificial delay rather than adding to it, and how much of the budget latency
alone covers differs by tier.

---

## Standing: one email per classify call

`CLASSIFY_BATCH_SIZE` was 1 for the entire life of the batching code, and a
multi-email batch test against Mistral (does an N-email request come back as N
objects, in order, with matching ids and unchanged accuracy?) never led to
adoption. The batching layer was removed on 2026-09-20.

The wire format did not change: the model still receives a JSON array of one
email and still replies with a JSON array, because that is what the prompt
describes. Only the chunk/flat/re-associate plumbing went away.

Revisit only with a measurement, and note that batching trades away the prompt
cache hit rate that currently makes GreenPT cost pennies.

---

## Standing: no bundled local prompt

There is no `prompt.ts`. The live prompt is fetched from S3's `current.json`
on every path (CLI, eval, Lambda, MCP server), and a failed fetch is fatal
rather than a silent degrade.

The real prompt describes a specific person in detail, so a git-committable
copy would have to be either generic-and-wrong or
PII-bearing-and-uncommittable. This is also why the throwaway eval scripts
that hardcoded a `CANDIDATE_PROMPT` constant were deleted rather than
committed: they carried personal detail in untracked files and had silently
drifted to grading against a stale prompt version.
