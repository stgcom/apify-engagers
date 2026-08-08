import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import type { Engager } from "./types.js";

/** Extract the /in/<slug> from a LinkedIn URL, or null. */
export function slugFromUrl(url: string): string | null {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1] : null;
}

interface ExaResult {
  url?: string;
  title?: string;
  entities?: Array<{
    type?: string;
    properties?: {
      name?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      workHistory?: Array<{ company?: { name?: string | null } | null }>;
    };
  }>;
}

interface ExaSearchResponse {
  results?: ExaResult[];
  error?: string;
}

async function exaPeopleSearch(query: string): Promise<ExaResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.exaApiKey}`,
    },
    body: JSON.stringify({
      query,
      category: "people",
      numResults: 5,
      contents: { text: false },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Exa search failed with HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as ExaSearchResponse;
  if (data.error) throw new Error(`Exa search error: ${data.error}`);
  return data.results ?? [];
}

function normalizedName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function namesOverlap(a: string, b: string): boolean {
  const na = normalizedName(a);
  const nb = normalizedName(b);
  if (!na || !nb) return false;
  const aParts = na.split(" ");
  const bParts = nb.split(" ");
  // Match on first+last tokens or a substantial token overlap.
  const firstA = aParts[0];
  const lastA = aParts[aParts.length - 1];
  const firstB = bParts[0];
  const lastB = bParts[bParts.length - 1];
  if (firstA === firstB && lastA === lastB) return true;
  const intersection = aParts.filter((t) => bParts.includes(t) && t.length > 2).length;
  return intersection >= Math.min(2, Math.min(aParts.length, bParts.length));
}

/**
 * Stage 3: for each engager with an obfuscated ACoAA URN, query Exa people search
 * for a public /in/ slug. Overwrites `resolvedSlug` in place; unresolved rows get
 * "unresolved" (never dropped). Also fills resolvedSlug for non-obfuscated rows.
 */
export async function resolveLinkedinUrlsExa(engagers: Engager[]): Promise<void> {
  const obfuscated = engagers.filter((e) => e.obfuscatedUrn);
  let resolved = 0;

  for (const engager of obfuscated) {
    const queryParts = [engager.name, engager.company].filter(Boolean);
    if (queryParts.length === 0) {
      engager.resolvedSlug = "unresolved";
      continue;
    }
    const query = queryParts.join(" ");

    let results: ExaResult[];
    try {
      results = await exaPeopleSearch(query);
    } catch (err) {
      console.warn(`  Exa search failed for "${query}": ${(err as Error).message}`);
      engager.resolvedSlug = "unresolved";
      continue;
    }

    // Prefer a result with a LinkedIn /in/ URL whose name matches the URN metadata.
    let match: string | null = null;
    for (const r of results) {
      const url = r.url ?? "";
      const slug = slugFromUrl(url);
      if (!slug) continue;
      const props = r.entities?.[0]?.properties;
      const personName = props?.name ?? [props?.firstName, props?.lastName].filter(Boolean).join(" ");
      if (personName && engager.name && namesOverlap(engager.name, personName)) {
        match = slug;
        break;
      }
    }

    if (match) {
      engager.resolvedSlug = match;
      resolved++;
      console.log(`  resolved ${engager.name ?? "(no name)"} -> /in/${match}`);
    } else {
      engager.resolvedSlug = "unresolved";
    }
  }

  // Also stamp resolvedSlug from any already-public URLs.
  for (const engager of engagers) {
    if (!engager.obfuscatedUrn && engager.profileUrl) {
      engager.resolvedSlug = slugFromUrl(engager.profileUrl) ?? "unresolved";
    }
  }

  console.log(
    `${resolved} of ${obfuscated.length} obfuscated URNs resolved to public /in/ slugs via Exa; ${obfuscated.length - resolved} remain unresolved.`
  );
}

/** CLI entry: reads an engagers JSON file, resolves, writes back in place. */
export function runCli(argv: string[]): void {
  const inputPath = argv[0];
  if (!inputPath) {
    console.error("Usage: tsx src/resolve-linkedin-urls-exa.ts <engagers-{date}.json>");
    process.exit(1);
  }
  const abs = resolve(process.cwd(), inputPath);
  const engagers = JSON.parse(readFileSync(abs, "utf-8")) as Engager[];
  resolveLinkedinUrlsExa(engagers)
    .then(() => {
      writeFileSync(abs, JSON.stringify(engagers, null, 2), "utf-8");
      console.log(`Wrote resolved slugs back to ${abs}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
