// CLI entrypoint. Pipeline logic lives in src/ (ARCHITECTURE.md); this file
// only wires up the run command and top-level error handling.
//
//   npx tsx triage.ts [--limit=n]           dry run (default), writes nothing
//   npx tsx triage.ts --apply               classify, move, tag, notify
//   npx tsx triage.ts --apply --no-notify   as above, skip Pushover

import { main } from "./src/main.js";

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
