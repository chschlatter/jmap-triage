// Round-1 evidence: facts about a message computed from headers and the raw
// HTML part, with no model and no network. Pure, so the pipeline and the eval
// can share one implementation (as keyword-scan.ts already is).
//
// Every constant here is a property of the mail infrastructure, not a
// judgement about a sender -- no allow/blocklists, per "prompt as
// configuration" in DECISIONS.md.

import { Parser } from "htmlparser2";
import { getDomain } from "tldts";
import type { EmailRaw } from "./fetch-emails.js";

// Fastmail's MX hosts are <pop>-mx-<nn>.messagingengine.com, so this is a
// suffix test, not the mxN.messagingengine.com the design doc assumed.
// RFC 8601: only our own MTA's Authentication-Results may be trusted; any
// other authserv-id is something an upstream hop wrote and can be forged.
const FASTMAIL_AUTHSERV = /\.messagingengine\.com$/;

// Apple's Hide My Email relay. icloud.com today, private.icloud.com as Apple
// migrates during 2026.
const ICLOUD_RELAY_ORGS = new Set(["icloud.com"]);
const ICLOUD_RELAY_HELO = /(^|\.)icloud\.com$/;

const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly", "is.gd",
  "cutt.ly", "rb.gy", "shorturl.at", "rebrand.ly", "lnkd.in",
]);

// Invisible padding legitimate marketing uses to stretch preheaders. Counted
// and stripped, never flagged -- over-correcting here produces false
// positives (DESIGN-v8 SS2.6).
const PADDING_CHARS = /[​‌‍⠀͏﻿]/g;
// Unicode tag characters. No legitimate use in mail outside a few flag
// emoji sequences, and the documented carrier for ASCII smuggling.
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

const HIDDEN_STYLE = /font-size:\s*0|display:\s*none|visibility:\s*hidden|opacity:\s*0|max-height:\s*0/i;
const MAX_LINKS = 5;

export interface LinkEvidence {
  org: string;
  anchorText: string;
  // Where the link actually sends the reader, when the href is a redirector
  // carrying the real destination in a query parameter. Null when the link
  // goes where it says.
  redirectsTo: string | null;
  flags: string[];
}

export interface RelayEvidence {
  // Whether Fastmail itself verified the message came through Apple's relay.
  // X-Icloud-Hme is added upstream of us and is forgeable on its own, so its
  // fields are only believed behind this gate.
  verified: boolean;
  aliasSite: string | null;
  originalSender: string | null;
  originalOrg: string | null;
  aliasBinding: "match" | "mismatch" | "unknown";
}

export interface Evidence {
  fromName: string;
  fromAddress: string;
  authOrg: string | null;
  dmarc: string | null;
  publishedPolicy: string | null;
  dkimAligned: boolean;
  spfAligned: boolean;
  relay: RelayEvidence | null;
  replyToOrg: string | null;
  links: LinkEvidence[];
  tagCharsRemoved: number;
  hiddenTextChars: number;
  paddingCharsRemoved: number;
  spamScore: string | null;
  knownSender: boolean;
  senderReputation: string | null;
  languages: string | null;
}

export function orgDomain(hostOrEmail: string | null | undefined): string | null {
  if (!hostOrEmail) return null;
  const host = hostOrEmail.includes("@") ? hostOrEmail.slice(hostOrEmail.lastIndexOf("@") + 1) : hostOrEmail;
  return getDomain(host.trim().replace(/^<|>$/g, "").toLowerCase());
}

// Fastmail splits its results across four header instances (x-ptr/x-csa,
// bimi, arc, and the dkim/dmarc/spf/iprev block), so every matching instance
// has to be merged -- taking only the topmost drops DMARC entirely.
function mergeFastmailAuth(authResults: string[]): string {
  return authResults
    .filter((h) => FASTMAIL_AUTHSERV.test(h.slice(0, h.indexOf(";")).trim()))
    .map((h) => h.slice(h.indexOf(";") + 1))
    .join("; ")
    .replace(/\s+/g, " ");
}

function first(blob: string, re: RegExp): string | null {
  return blob.match(re)?.[1] ?? null;
}

function parseIcloudHme(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// Hide My Email rewrites From to <local>_at_<domain with dots as
// underscores>_<suffix>@icloud.com. Only used when X-Icloud-Hme is missing:
// the header carries the same origin plus the alias's site, which the
// address does not.
function decodeRelayAddress(address: string): string | null {
  const local = address.slice(0, address.lastIndexOf("@"));
  const at = local.indexOf("_at_");
  if (at === -1) return null;
  const rest = local.slice(at + 4).split("_");
  // Trailing two segments are Apple's opaque suffix, not part of the domain.
  const domain = rest.slice(0, -2).join(".");
  return orgDomain(domain);
}

function buildRelay(raw: EmailRaw, blob: string, authOrg: string | null, fromAddress: string): RelayEvidence | null {
  const hme = raw.icloudHme ? parseIcloudHme(raw.icloudHme) : null;
  const looksRelayed = hme !== null || (authOrg !== null && ICLOUD_RELAY_ORGS.has(authOrg) && fromAddress.includes("_at_"));
  if (!looksRelayed) return null;

  const helo = first(blob, /smtp\.helo=([^\s;"]+)/);
  const verified =
    first(blob, /dmarc=(\w+)/) === "pass" &&
    authOrg !== null &&
    ICLOUD_RELAY_ORGS.has(authOrg) &&
    helo !== null &&
    ICLOUD_RELAY_HELO.test(helo);

  if (!hme || !verified) {
    const originalOrg = decodeRelayAddress(fromAddress);
    return { verified, aliasSite: null, originalSender: null, originalOrg, aliasBinding: "unknown" };
  }

  const aliasSite = orgDomain(hme.d);
  const originalOrg = orgDomain(hme.s);
  return {
    verified: true,
    aliasSite,
    originalSender: hme.s ?? null,
    originalOrg,
    // Each alias is created for one site, so mail from anywhere else means
    // the alias leaked (DESIGN-v8 SS2.3).
    aliasBinding: aliasSite && originalOrg ? (aliasSite === originalOrg ? "match" : "mismatch") : "unknown",
  };
}

// Query parameters that carry a redirect destination. Every large sender
// wraps its links this way for click tracking, and so does every phisher
// abusing an open redirector -- the shape is identical, which is exactly why
// the destination has to be a computed fact rather than something the model
// has to spot in a wall of tracking URLs.
const REDIRECT_PARAMS = ["url", "u", "q", "target", "dest", "destination", "redirect", "redirect_uri", "r", "link", "to"];

function redirectTarget(url: URL): string | null {
  for (const key of REDIRECT_PARAMS) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    // searchParams already decodes once; decode again for the double-encoded
    // case, and tolerate a malformed escape rather than throwing.
    let candidate = raw;
    try {
      candidate = decodeURIComponent(raw);
    } catch {
      /* keep the once-decoded form */
    }
    if (!/^https?:\/\//i.test(candidate)) continue;
    try {
      return orgDomain(new URL(candidate).hostname);
    } catch {
      continue;
    }
  }
  return null;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

function isMixedScript(host: string): boolean {
  return /[a-z]/i.test(host) && /[^\x00-\x7F]/.test(host);
}

// Bare URLs in a text/plain part. Not redundant with the anchors below: a
// multipart message's two alternatives are written separately and do not
// always carry the same links. A LinkedIn notification put its app-store
// redirector in the plain part only -- and since extractBodyText prefers
// text/plain, that is the part the model reads, so evidence drawn from the
// HTML alone described a different message than the one being judged.
const BARE_URL = /https?:\/\/[^\s<>"'\]),]+/g;

function extractLinks(html: string, bodyText: string): LinkEvidence[] {
  const anchors: Array<{ href: string; text: string }> = [];
  let open: { href: string; text: string } | null = null;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "a" && attrs.href) open = { href: attrs.href, text: "" };
    },
    ontext(text) {
      if (open) open.text += text;
    },
    onclosetag(name) {
      if (name === "a" && open) {
        anchors.push(open);
        open = null;
      }
    },
  });
  parser.write(html);
  parser.end();

  for (const m of bodyText.matchAll(BARE_URL)) {
    anchors.push({ href: m[0], text: "" });
  }

  const byOrg = new Map<string, LinkEvidence>();
  for (const a of anchors) {
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const host = url.hostname.toLowerCase();
    const org = orgDomain(host) ?? host;
    const target = redirectTarget(url);
    const redirectsTo = target && target !== org ? target : null;
    // Keyed on both ends, so one tracker fronting several destinations does
    // not collapse into a single reassuring row.
    const key = redirectsTo ? `${org}>${redirectsTo}` : org;
    if (byOrg.has(key)) continue;

    const anchorText = a.text.replace(PADDING_CHARS, "").trim().slice(0, 60);
    const flags: string[] = [];
    // A domain named in the visible text that isn't where the link goes.
    const named = anchorText.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i)?.[1];
    if (named && orgDomain(named) && orgDomain(named) !== org) flags.push("text-target-mismatch");
    if (SHORTENERS.has(org)) flags.push("shortener");
    if (isIpLiteral(host)) flags.push("ip-literal");
    if (host.includes("xn--")) flags.push("punycode");
    if (isMixedScript(host)) flags.push("mixed-script");
    // Deliberately no "off-domain" flag: nearly all legitimate marketing
    // routes clicks through an ESP's tracking domain, so flagging every link
    // that isn't the sender's own domain marks the whole clean sample. The
    // org domains are listed, and the sender's own is stated above; that
    // comparison is the model's to make.

    byOrg.set(key, { org, anchorText, redirectsTo, flags });
    if (byOrg.size >= MAX_LINKS) break;
  }
  return [...byOrg.values()];
}

function countHiddenText(html: string): number {
  let hidden = 0;
  let depth = 0;
  const parser = new Parser({
    onopentag(_name, attrs) {
      if (depth > 0) depth++;
      else if (attrs.style && HIDDEN_STYLE.test(attrs.style)) depth = 1;
    },
    ontext(text) {
      if (depth > 0) hidden += text.trim().length;
    },
    onclosetag() {
      if (depth > 0) depth--;
    },
  });
  parser.write(html);
  parser.end();
  return hidden;
}

// Tracking URLs carry hundreds of characters of opaque token, and a bulk
// sender's plain-text part can be almost nothing else. Left intact they cost
// tokens and, worse, reasoning: one LinkedIn digest drove the model past
// 3000 completion tokens and then past the provider's 180s gateway timeout,
// so it could not be judged at any budget. The host and the start of the
// path stay -- that is the part a reader or a classifier could act on -- and
// the query payload goes. Nothing is lost that evidence does not already
// state: extractLinks reports every link's org domain and redirect target.
const LONG_URL = /https?:\/\/[^\s<>"'\])]{100,}/g;
const URL_KEEP_PATH = 40;

function collapseTrackingUrls(text: string): string {
  return text.replace(LONG_URL, (raw) => {
    try {
      const u = new URL(raw);
      const path = u.pathname.slice(0, URL_KEEP_PATH);
      return `${u.origin}${path}[...tracking link, ${raw.length} chars]`;
    } catch {
      return `${raw.slice(0, 60)}[...truncated]`;
    }
  });
}

// Strips what the message used to hide content from analysis, and reports how
// much there was. Microsoft's guidance is to remove tag characters before any
// content analysis, including an LLM's.
export function sanitizeText(text: string): { text: string; tagChars: number; paddingChars: number } {
  const tagChars = text.match(TAG_CHARS)?.length ?? 0;
  const paddingChars = text.match(PADDING_CHARS)?.length ?? 0;
  const cleaned = collapseTrackingUrls(text.replace(TAG_CHARS, "").replace(PADDING_CHARS, ""));
  return { text: cleaned, tagChars, paddingChars };
}

export function buildEvidence(email: { from: string; subject: string; body: string; raw?: EmailRaw }): Evidence {
  const raw = email.raw;
  const fromAddress = email.from.split(",")[0].trim();
  if (!raw) {
    return {
      fromName: "", fromAddress, authOrg: orgDomain(fromAddress), dmarc: null, publishedPolicy: null,
      dkimAligned: false, spfAligned: false, relay: null, replyToOrg: null, links: [],
      tagCharsRemoved: 0, hiddenTextChars: 0, paddingCharsRemoved: 0,
      spamScore: null, knownSender: false, senderReputation: null, languages: null,
    };
  }

  const blob = mergeFastmailAuth(raw.authResults);
  const headerFrom = first(blob, /header\.from=([^\s;]+)/);
  const authOrg = orgDomain(headerFrom) ?? orgDomain(fromAddress);

  const dkimPass = [...blob.matchAll(/dkim=pass[^;]*?header\.d=([^\s;]+)/g)].map((m) => orgDomain(m[1]));
  const spfMailfrom = first(blob, /spf=pass[^;]*?smtp\.mailfrom=\s*"?([^\s;"]+)/);

  const relay = buildRelay(raw, blob, authOrg, fromAddress);
  const replyToOrg = orgDomain(raw.replyTo.split(",")[0]);
  const sanitized = sanitizeText(`${email.subject}\n${email.body}`);

  return {
    fromName: raw.fromName,
    fromAddress,
    authOrg,
    dmarc: first(blob, /dmarc=(\w+)/),
    publishedPolicy: first(blob, /policy\.published-domain-policy=(\w+)/),
    dkimAligned: authOrg !== null && dkimPass.includes(authOrg),
    spfAligned: authOrg !== null && orgDomain(spfMailfrom) === authOrg,
    relay,
    replyToOrg: replyToOrg && replyToOrg !== authOrg ? replyToOrg : null,
    // Both parts: the HTML for anchor text, the body text for whatever the
    // model will actually read.
    links: extractLinks(raw.rawHtml, email.body),
    tagCharsRemoved: sanitized.tagChars,
    hiddenTextChars: countHiddenText(raw.rawHtml),
    paddingCharsRemoved: sanitized.paddingChars,
    spamScore: raw.spamScore,
    knownSender: /^yes/i.test(raw.spamKnownSender ?? ""),
    senderReputation: raw.spamReputation?.split(" ")[0] ?? null,
    languages: first(raw.spamHits ?? "", /LANGUAGES ([a-z]{2}(?: [a-z]{2})*)/),
  };
}

// The block the model sees ahead of the message. Facts only, phrased so
// nothing reads as a verdict.
export function formatEvidenceBlock(ev: Evidence): string {
  const lines: string[] = ["EVIDENCE (computed by the mail system; reliable)"];
  lines.push(`from: ${ev.fromName ? `"${ev.fromName}" ` : ""}<${ev.fromAddress}>`);

  const auth = [
    `dmarc=${ev.dmarc ?? "absent"}`,
    ev.publishedPolicy ? `(p=${ev.publishedPolicy})` : "(no policy published)",
    ev.dkimAligned ? "dkim aligned" : "dkim not aligned",
    ev.spfAligned ? "spf aligned" : "spf not aligned",
  ].join(", ");
  lines.push(`authenticated org domain: ${ev.authOrg ?? "none"} - ${auth}`);

  if (!ev.relay) {
    lines.push("relay: none");
  } else if (!ev.relay.verified) {
    lines.push(
      `relay: looks like an iCloud Hide My Email alias but the relay hop is unverified; original org domain ${ev.relay.originalOrg ?? "unknown"}`
    );
  } else {
    lines.push(
      `relay: iCloud Hide My Email, verified. This alias was created for ${ev.relay.aliasSite ?? "an unknown site"}; ` +
        `this message came from ${ev.relay.originalSender ?? "unknown"} (${ev.relay.originalOrg ?? "unknown"}) - ` +
        `alias binding ${ev.relay.aliasBinding}`
    );
  }

  lines.push(`reply-to: ${ev.replyToOrg ? `${ev.replyToOrg} (different org domain)` : "same org domain or absent"}`);
  lines.push(
    `history: sender ${ev.knownSender ? "is in the address book" : "is not in the address book"}, ` +
      `reputation ${ev.senderReputation ?? "unknown"}/1000 (500 = no history)`
  );

  if (ev.links.length === 0) {
    lines.push("links: none");
  } else {
    for (const l of ev.links) {
      const via = l.redirectsTo ? ` -> redirects to ${l.redirectsTo}` : "";
      lines.push(`link: "${l.anchorText}" -> ${l.org}${via}${l.flags.length ? ` (${l.flags.join(", ")})` : ""}`);
    }
  }

  if (ev.hiddenTextChars > 0) lines.push(`hidden content in the HTML: ${ev.hiddenTextChars} chars`);
  if (ev.tagCharsRemoved > 0) lines.push(`invisible Unicode tag characters removed: ${ev.tagCharsRemoved}`);
  lines.push(`fastmail spam score: ${ev.spamScore ?? "unknown"}`);
  if (ev.languages) lines.push(`language: ${ev.languages}`);
  return lines.join("\n");
}
