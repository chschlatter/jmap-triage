// jmap-triage CLI entrypoint: classify mail in Inbox/Triage, move it to the
// right destination, tag it, and notify. Pipeline logic lives in src/ --
// this file only wires up the run command and top-level error handling.
// See ARCHITECTURE.md for the full design.
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
