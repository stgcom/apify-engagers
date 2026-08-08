import { config } from "./config.js";
import type { Engager } from "./types.js";
import type { EnrichmentHit } from "./enrichGetLeads.js";

interface ApolloPerson {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  organization_name?: string | null;
}

/**
 * Stage 4 tier 2: Apollo — only for leads GetLeads missed.
 * People enrichment by LinkedIn URL. Requests reveal_phone_number to get phones.
 */
export async function enrichApollo(engager: Engager): Promise<EnrichmentHit | null> {
  const key = config.apolloApiKey;
  const linkedinUrl = engager.resolvedSlug
    ? `https://www.linkedin.com/in/${engager.resolvedSlug}`
    : engager.profileUrl;
  if (!linkedinUrl) return null;

  const res = await fetch("https://api.apollo.io/v1/people/match", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": key,
    },
    body: JSON.stringify({
      linkedin_url: linkedinUrl,
      reveal_phone_number: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`  Apollo HTTP ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }

  const data = (await res.json()) as { person?: ApolloPerson | null };
  const person = data.person;
  if (!person) return null;

  return {
    email: person.email ?? null,
    phone: person.phone ?? null,
  };
}
