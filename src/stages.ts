// The two rounds of triage, as data. Round 1 decides phishing vs clean and
// maps to one folder; round 2 classifies what survives into categories.
//
// Each stage owns its own prompt, version line and S3 prefix, so a round-2
// edit never re-versions round 1 (DESIGN-v8 SS3.5). The triage prefix is ""
// deliberately: current.json and history/ stay where they already are, so
// adding round 1 needs no S3 migration.

export type StageKey = "phish" | "triage";

export interface StageSpec {
  key: StageKey;
  // Prepended to every S3 key this stage reads or writes.
  s3Prefix: string;
  // What a version string for this stage looks like, e.g. ph1 / v11. Used to
  // tell the two version lines apart in a keyword scan.
  versionPrefix: string;
  // What the model is allowed to answer. Round 2's comes from MAILBOX_SPECS
  // rather than being duplicated here.
  vocabulary?: readonly string[];
}

export const STAGE_SPECS = {
  phish: { key: "phish", s3Prefix: "phish/", versionPrefix: "ph", vocabulary: ["phishing", "clean"] },
  triage: { key: "triage", s3Prefix: "", versionPrefix: "v" },
} as const satisfies Record<StageKey, StageSpec>;

export const STAGE_KEYS = Object.keys(STAGE_SPECS) as StageKey[];

export const DEFAULT_STAGE: StageKey = "triage";

export function stageSpec(stage: StageKey = DEFAULT_STAGE): StageSpec {
  return STAGE_SPECS[stage];
}

// Round 1's verdict maps to exactly one destination, so this is the category
// name it borrows from MAILBOX_SPECS when a phishing verdict becomes an
// action. "clean" never moves mail on its own -- it only stamps a keyword.
export const PHISHING_CATEGORY = "suspicious";
export const CLEAN_VERDICT = "clean";
