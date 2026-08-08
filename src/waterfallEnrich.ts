import { enrichGetLeads } from "./enrichGetLeads.js";
import { enrichApollo } from "./enrichApollo.js";
import { enrichProspeo } from "./enrichProspeo.js";
import { requireKey } from "./config.js";
import type { EnrichedLead, Engager } from "./types.js";

export const SPEND_GUARD_THRESHOLD = 500;

interface Funnel {
  total: number;
  getleadsFound: number;
  apolloFound: number;
  prospeoFound: number;
  passedToApollo: number;
  passedToProspeo: number;
}

function hasContact(lead: EnrichedLead): boolean {
  return Boolean(lead.email || lead.phone);
}

/**
 * Stage 4: waterfall enrichment — GetLeads, then Apollo (misses only),
 * then Prospeo (misses only). Marks each lead with source_tool + enrichment_tier.
 * Requires explicit confirmation before spending on Apollo/Prospeo when the
 * list exceeds SPEND_GUARD_THRESHOLD profiles in a single run.
 */
export async function waterfallEnrich(
  engagers: Engager[],
  options: { confirmSpend?: () => Promise<boolean> } = {}
): Promise<EnrichedLead[]> {
  const leads: EnrichedLead[] = engagers.map((e) => ({
    ...e,
    email: null,
    phone: null,
    source_tool: null,
    enrichment_tier: null,
  }));

  const funnel: Funnel = {
    total: leads.length,
    getleadsFound: 0,
    apolloFound: 0,
    prospeoFound: 0,
    passedToApollo: 0,
    passedToProspeo: 0,
  };

  // --- Tier 1: GetLeads (cheapest; always allowed) ---
  for (const lead of leads) {
    try {
      const hit = await enrichGetLeads(lead);
      if (hit && (hit.email || hit.phone)) {
        lead.email = hit.email;
        lead.phone = hit.phone;
        lead.source_tool = "getleads";
        lead.enrichment_tier = 1;
        funnel.getleadsFound++;
      }
    } catch (err) {
      console.warn(`  GetLeads error for ${lead.resolvedSlug ?? lead.profileUrl}: ${(err as Error).message}`);
    }
  }
  funnel.passedToApollo = leads.filter((l) => !hasContact(l)).length;

  // --- Tier 2: Apollo (only if spend allowed or list small) ---
  const apolloQueue = leads.filter((l) => !hasContact(l));
  if (apolloQueue.length > 0) {
    if (leads.length > SPEND_GUARD_THRESHOLD) {
      const confirm = options.confirmSpend ?? (async () => false);
      const ok = await confirm();
      if (!ok) {
        console.log(
          `Spend guard: ${leads.length} profiles exceeds ${SPEND_GUARD_THRESHOLD}; skipping Apollo + Prospeo (${apolloQueue.length} leads left unenriched).`
        );
        return leads;
      }
    }
    for (const lead of apolloQueue) {
      try {
        const hit = await enrichApollo(lead);
        if (hit && (hit.email || hit.phone)) {
          lead.email = hit.email;
          lead.phone = hit.phone;
          lead.source_tool = "apollo";
          lead.enrichment_tier = 2;
          funnel.apolloFound++;
        }
      } catch (err) {
        console.warn(`  Apollo error for ${lead.resolvedSlug ?? lead.profileUrl}: ${(err as Error).message}`);
      }
    }
  }
  funnel.passedToProspeo = leads.filter((l) => !hasContact(l)).length;

  // --- Tier 3: Prospeo (only for Apollo misses) ---
  const prospeoQueue = leads.filter((l) => !hasContact(l));
  for (const lead of prospeoQueue) {
    try {
      const hit = await enrichProspeo(lead);
      if (hit && (hit.email || hit.phone)) {
        lead.email = hit.email;
        lead.phone = hit.phone;
        lead.source_tool = "prospeo";
        lead.enrichment_tier = 3;
        funnel.prospeoFound++;
      }
    } catch (err) {
      console.warn(`  Prospeo error for ${lead.resolvedSlug ?? lead.profileUrl}: ${(err as Error).message}`);
    }
  }

  const totalFound = leads.filter((l) => hasContact(l)).length;
  const findRatePct = funnel.total > 0 ? Math.round((totalFound / funnel.total) * 100) : 0;
  const remainingAfterProspeo = leads.filter((l) => !hasContact(l)).length;

  console.log(
    `${funnel.total} LinkedIn URLs → GetLeads: ${funnel.getleadsFound} found, ${funnel.passedToApollo} passed down → Apollo: ${funnel.apolloFound} found, ${funnel.passedToProspeo} passed down → Origami/Prospeo: ${funnel.prospeoFound} resolved (${remainingAfterProspeo} still missing) → ~${findRatePct}% overall find rate`
  );

  return leads;
}

/** Guard helper for the orchestrator: confirm before spending on Apollo/Prospeo. */
export async function confirmSpendPrompt(listSize: number): Promise<boolean> {
  const rl = (await import("node:readline/promises")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      `List size ${listSize} exceeds ${SPEND_GUARD_THRESHOLD} — Apollo + Prospeo will cost money. Continue? (y/N) `
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/** Ensure the tier-2/3 keys exist before enrichment runs; fail fast if missing. */
export function assertEnrichmentKeys(): void {
  requireKey("GETLEADS_API_KEY");
  requireKey("APOLLO_API_KEY");
  requireKey("PROSPEO_API_KEY");
}
