// Ground truth for round 1 (phishing vs. clean).
//
// Folder position is NOT the label (DESIGN-v8 SS1.4): nobody reviews
// Inbox/Suspicious, so mail sitting there confirms nothing. These labels were
// set by hand from sender, authentication and relay evidence.
//
// The 19 messages under "was in Inbox/Suspicious" are v10's suspicious
// verdicts as of 2026-09-21. Five of them were moved back out to Inbox by
// hand while this set was being built, which is a direct human confirmation
// that they were false positives.
//
// Ids are stable across mailbox moves, so these keep resolving wherever the
// messages end up. They are meaningless without this account's token.
//
// Notes describe the *shape* of each case, not who sent it: this is a public
// repo, and a list of one person's real correspondents is exactly the kind of
// detail the prompts are kept in S3 to avoid committing. Senders are referred
// to by role ("a retailer", "a bank") and relay aliases by letter. Resolve an
// id against the mailbox when a specific miss needs investigating.

export interface Ph1Case {
  id: string;
  expected: "phishing" | "clean";
  note: string;
}

export const PH1_CASES: Ph1Case[] = [
  // --- was in Inbox/Suspicious: v10 called all 19 suspicious ---

  // Confirmed false positives: moved back to Inbox by hand.
  { id: "StmYeBJPzlAJ", expected: "clean", note: "streaming service via Hide My Email, alias A; alias site and origin are the same org domain" },
  { id: "StmYj-XGLzKR", expected: "clean", note: "SaaS vendor via Hide My Email, alias B; binding matches" },
  { id: "StmYp_bOlkXc", expected: "clean", note: "same vendor, verification code via Hide My Email; binding matches" },
  { id: "StmYpd6TbNL3", expected: "clean", note: "same vendor, verification code direct from its own domain, dmarc=pass p=reject" },
  { id: "StmYpyhFU43o", expected: "clean", note: "same vendor, verification code direct from its own domain, dmarc=pass p=reject" },

  // Still in Suspicious, but legitimate on the evidence. The two judgement
  // calls in this set -- both are brand mail that authenticates to the
  // brand's own domain.
  { id: "StnGSCWTBA8J", expected: "clean", note: "airline via Hide My Email, alias C; alias was created for the loyalty programme and the mail comes from the airline -- binding mismatches but they are the same programme. The hard case." },
  { id: "StnJbKyGk6ik", expected: "clean", note: "developer marketing from a large vendor's own subdomain, dmarc=pass p=reject" },

  // Brand display name on an unrelated SaaS/ESP tenant. All authenticate
  // cleanly for the platform, so only the identity comparison catches them.
  { id: "Stma43SCxCOF", expected: "phishing", note: "wallet brand name on a school-admin SaaS tenant; credential lure, reply-to on a third unrelated domain" },
  { id: "StmxDHzqkG1V", expected: "phishing", note: "music-streaming brand name on a helpdesk SaaS tenant; subscription payment lure (DE)" },
  { id: "StnKEfzsJL-c", expected: "phishing", note: "transit-card brand name on a marketing-platform tenant; card-expiry payment lure" },
  { id: "Stn7sGDXs2-B", expected: "phishing", note: "generic 'contact centre' via a bulk ESP, dmarc=none; unusual-transaction lure (FR)" },

  // One leaked Hide My Email alias (alias D, created for a retailer)
  // receiving mail from three unrelated origins.
  { id: "StmbQXH9fypg", expected: "phishing", note: "alias leak: alias D, origin an unrelated public-sector domain (DE)" },
  { id: "StmcQyNAarTs", expected: "phishing", note: "alias leak: alias D, origin an unrelated business domain; transit-card payment lure (DE)" },
  { id: "StnG3dXHSwh3", expected: "phishing", note: "alias leak: alias D, origin an unrelated foreign domain; probate advance-fee" },

  // Throwaway or compromised domains, unsolicited approaches.
  { id: "Stmi8NLKX_Jk", expected: "phishing", note: "unfamiliar domain, unsolicited business-opportunity approach" },
  { id: "Stn8zqbCcT5g", expected: "phishing", note: "unfamiliar domain, dmarc=none, no dkim; unsolicited business proposal, reply-to on a privacy mail host (DE)" },
  { id: "Stn9CTvyy3Tg", expected: "phishing", note: "unfamiliar domain, dmarc=none; payment-method update lure (DE)" },
  { id: "StnLCoTerzdk", expected: "phishing", note: "throwaway domain, unsolicited offer. The case that regresses if the prompt stops asking for a named signal." },
  { id: "StnL0vcEw6Cw", expected: "phishing", note: "freemail sender, 'order confirmation' with no real body -- callback phishing" },

  // --- clean sample: Inbox, Orders, Newsletters ---
  // The false-positive counterweight. Several are deliberately the shapes
  // that tripped v5: security notices, payment reminders, expiry warnings.

  { id: "StmXd2vH6D2w", expected: "clean", note: "reply from a small business, arc=pass forwarded" },
  { id: "StmZ5pwE0VxV", expected: "clean", note: "telecom subscription notice from its own subdomain" },
  { id: "Stm_xXHp3WlN", expected: "clean", note: "telecom subscription notice" },
  { id: "StmbgmbCwCTV", expected: "clean", note: "telecom subscription notice" },
  { id: "StmaMhZLqvZJ", expected: "clean", note: "personal mail, sender in address book" },
  { id: "StmbWEU01YWF", expected: "clean", note: "personal mail forwarded from a freemail sender" },
  { id: "StmbctwC7XPN", expected: "clean", note: "bank account-security notice -- security topic, own domain, must stay clean" },
  { id: "StmdMv0curVg", expected: "clean", note: "cloud-storage expiry warning via a bulk ESP, aligned to its own subdomain -- expiry pressure, must stay clean" },
  { id: "Stmdo3yMxC8c", expected: "clean", note: "retailer invoice via a marketing platform, aligned to its own subdomain" },
  { id: "StmeDoE5swzc", expected: "clean", note: "financial service asks for a tax ID -- a data request from the brand's own domain" },
  { id: "StmeLfAcyoJ3", expected: "clean", note: "postal delivery notice, signature required" },
  { id: "StmeweyMRjzZ", expected: "clean", note: "credit provider document notice, arc=pass" },
  { id: "StmXs0YxrGJZ", expected: "clean", note: "booking-platform reservation thread, sender reputation 1000. DESIGN-v8 SS2.2 flags this thread shape as a possible compromised-partner case; labelled clean on the evidence." },
  { id: "StmZoURjLLoF", expected: "clean", note: "booking-platform reservation thread" },
  { id: "StmbmWUXHx6F", expected: "clean", note: "booking-platform reservation thread" },
  { id: "Stmdix48i9IB", expected: "clean", note: "booking-platform reservation thread" },
  { id: "Stme6L1KJkus", expected: "clean", note: "booking-platform reservation thread" },
  { id: "Stme6vOxaooB", expected: "clean", note: "booking-platform reservation thread" },

  { id: "StmXqYTIeEj-", expected: "clean", note: "large vendor invoice" },
  { id: "StmXslbTi5WV", expected: "clean", note: "shipping confirmation from a supplier, no display name (FR)" },
  { id: "StmbQrFiWJjN", expected: "clean", note: "postal parcel information" },
  { id: "Stmbr-Kukutk", expected: "clean", note: "retailer receipt" },
  { id: "StmeA1jlCPqo", expected: "clean", note: "postal delivery confirmation" },
  { id: "StmeA1qvnlSo", expected: "clean", note: "postal delivery confirmation" },
  { id: "StmeA1q_is5V", expected: "clean", note: "postal delivery confirmation" },
  { id: "StmeLcKUYfPZ", expected: "clean", note: "postal delivery notice" },
  { id: "StmeLjxjEzDs", expected: "clean", note: "postal delivery notice" },
  { id: "StmeblIixc2o", expected: "clean", note: "postal delivery notice" },

  { id: "StmXmDtQozVc", expected: "clean", note: "consumer-goods marketing, urgency and scarcity but legitimate" },
  { id: "StmZD3laWKjs", expected: "clean", note: "same sender, scarcity framing" },
  { id: "StmaZK-1O-DV", expected: "clean", note: "same sender, scarcity framing" },
  { id: "Stme8IlxMxco", expected: "clean", note: "same sender, marketing" },
  { id: "StmfAq0-39jJ", expected: "clean", note: "same sender, scarcity framing" },
  { id: "Stma6TnQcKMc", expected: "clean", note: "tech newsletter -- editorial about surveillance and security" },
  { id: "StmbpSbIPIo7", expected: "clean", note: "cloud-vendor event marketing" },
  { id: "StmbwkW-Fn-Z", expected: "clean", note: "sports-venue newsletter (DE)" },
  { id: "StmdpnQcElPB", expected: "clean", note: "professional-association newsletter via an off-domain ESP" },
  { id: "Stmf6vJt-Kvo", expected: "clean", note: "same association, event mail from its own domain" },
];
