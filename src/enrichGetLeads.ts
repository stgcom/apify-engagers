import { config } from "./config.js";
import type { Engager } from "./types.js";

export interface EnrichmentHit {
  email: string | null;
  phone: string | null;
}

/**
 * Stage 4 tier 1: GetLeads.io — cheapest, run first.
 * Enrich a lead by LinkedIn URL/slug. Returns { email, phone } or null on miss.
 */
export async function enrichGetLeads(engager: Engager): Promise<EnrichmentHit | null> {
  const key = config.getLeadsApiKey;
  const target = engager.resolvedSlug
    ? `https://www.linkedin.com/in/${engager.resolvedSlug}`
    : engager.profileUrl;
  if (!target) return null;

  // GetLeads MCP endpoint is a JSON-RPC-style MCP server. We POST a
  // tools/call request for its email-enrichment tool. Tool names may vary by
  // account; this uses the documented enrichment call for linkedin lookups.
  const res = await fetch("https://app.getleads.io/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "getleads_enrich_person",
        arguments: { linkedin_url: target },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`  GetLeads HTTP ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }

  const data = (await res.json()) as {
    result?: { content?: Array<{ type?: string; text?: string }> };
  };

  const text = data.result?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as {
      email?: string | null;
      phone?: string | null;
      phone_number?: string | null;
      found?: boolean;
      success?: boolean;
    };
    const email = parsed.email ?? null;
    const phone = parsed.phone ?? parsed.phone_number ?? null;
    return email || phone ? { email, phone } : null;
  } catch {
    // Non-JSON text content — treat as miss.
    return null;
  }
}
