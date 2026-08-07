// html-to-text 10.x ships no type declarations and @types/html-to-text is
// pinned to the older 9.x API, so this is a minimal ambient declaration for
// the one export triage.ts actually uses.
declare module "html-to-text" {
  export function convert(html: string, options?: Record<string, unknown>): string;
}
