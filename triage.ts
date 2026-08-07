// jmap-triage CLI entrypoint. v5: classify (Claude Haiku on Bedrock, v4
// logic unchanged) -> act (move classified mail out of Inbox/Triage) ->
// notify (Pushover). Pipeline logic lives in src/ -- this file only wires
// up the run command and top-level error handling. See
// triage.ts-DESIGN-v5-2026-08-02.md for the full design and
// triage.ts-DESIGN-v4-2026-08-02.md for the classification stage's own
// history.
//
// Usage:
//   npx tsx triage.ts [--limit=n]              dry run (default) -- prints
//                                               classification + planned
//                                               moves, writes nothing
//   npx tsx triage.ts --apply                  classify, move, and notify
//   npx tsx triage.ts --apply --no-notify      classify and move, skip
//                                               Pushover

import { main } from "./src/main.js";

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
