/** A single engager row, normalized across the reactions + comments actors. */
export interface Engager {
  /** Raw profile URL as returned by the actor (may be an obfuscated ACoAA URN). */
  profileUrl: string | null;
  /** Public /in/ slug resolved in Stage 3, or "unresolved" if it could not be resolved. */
  resolvedSlug: string | null;
  name: string | null;
  company: string | null;
  /**
   * Which actor discovered this engager:
   * - "reactor" = reacted to a tracked post (post reactions actor)
   * - "commenter" = commented on a tracked post (post comments actor)
   * - "profile_reactor" = discovered via a tracked profile's reaction feed
   */
  source: "reactor" | "commenter" | "profile_reactor";
  /** True when profileUrl is an obfuscated ACoAA... URN instead of a public /in/ slug. */
  obfuscatedUrn: boolean;
  /** Total engagement (reactions+comments+reposts) on the post this engager reacted to, when known. */
  engagement?: number;
  /** Raw actor row payload, preserved for audit. */
  raw: Record<string, unknown>;
}

/** Enrichment result attached to an engager after Stage 4. */
export interface EnrichedLead extends Engager {
  email: string | null;
  phone: string | null;
  /** Which tool found the contact: getleads | apollo | prospeo | null. */
  source_tool: string | null;
  /** 1 = GetLeads, 2 = Apollo, 3 = Prospeo; null if no contact found. */
  enrichment_tier: number | null;
}

/** Result of MillionVerifier validation in Stage 5. */
export interface VerificationResult {
  email: string;
  /** "good" | "risky" | "bad" | "error" — mapped from MillionVerifier quality. */
  quality: string;
  /** Raw MillionVerifier result string (ok, invalid, catch_all, ...). */
  result: string;
  /** Raw subresult, when present. */
  subresult: string | null;
  error: string | null;
}
