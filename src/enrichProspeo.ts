import { config } from "./config.js";
import type { Engager } from "./types.js";
import type { EnrichmentHit } from "./enrichGetLeads.js";

interface ProspeoResponse {
  email?: string | null;
  emails?: Array<{ email?: string; status?: string }> | null;
  phone?: string | null;
  mobile?: string | null;
  status?: string;
  error?: string | null;
}

/**
 * Stage 4 tier 3: Prospeo — only for leads Apollo missed.
 * REST enrichment by LinkedIn URL → verified email/phone or null.
 * Prospeo endpoints accept POST only (per their API docs).
 */
export async function enrichProspeo(engager: Engager): Promise<EnrichmentHit | null> {
  const key = config.prospeoApiKey;
  const linkedinUrl = engager.resolvedSlug
    ? `https://www.linkedin.com/in/${engager.resolvedSlug}`
    : engager.profileUrl;
  if (!linkedinUrl) return null;

  const res = await fetch("https://api.prospeo.io/email-finder", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({ linkedin_url: linkedinUrl }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`  Prospeo HTTP ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }

  const data = (await res.json()) as ProspeoResponse;
  if (data.error || data.status === "error") return null;

  const email = data.email ?? data.emails?.[0]?.email ?? null;
  const phone = data.phone ?? data.mobile ?? null;
  return email || phone ? { email, phone } : null;
}
