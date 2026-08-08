import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedLead } from "./types.js";

export const OUTPUT_DIR = "output";

export const FINAL_COLUMNS = [
  "linkedin_url",
  "resolved_slug",
  "name",
  "company",
  "email",
  "email_status",
  "phone",
  "source_tool",
  "enrichment_tier",
] as const;

export interface VerifiedLead extends EnrichedLead {
  email_status: string;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Record<string, unknown>>, columns: readonly string[]): string {
  const header = columns.join(",");
  const lines = rows.map((r) =>
    columns
      .map((c) => csvEscape(r[c]))
      .join(",")
  );
  return [header, ...lines].join("\n");
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Stage 6: write output/leads-ready-{date}.csv (only rows marked good)
 * and output/quarantined-{date}.csv (risky/bad/error rows for review).
 * The leads-ready file is the ONLY handoff artifact to Hermes / sending platform.
 */
export function buildFinalOutput(verified: VerifiedLead[]): { readyPath: string; quarantinedPath: string } {
  const stamp = dateStamp();
  const good = verified.filter((l) => l.email_status === "good");
  const quarantined = verified.filter((l) => l.email_status !== "good");

  const readyRows = good.map((l) => ({
    linkedin_url: l.profileUrl,
    resolved_slug: l.resolvedSlug,
    name: l.name,
    company: l.company,
    email: l.email,
    email_status: l.email_status,
    phone: l.phone,
    source_tool: l.source_tool,
    enrichment_tier: l.enrichment_tier,
  }));

  const quarantineRows = quarantined.map((l) => ({
    linkedin_url: l.profileUrl,
    resolved_slug: l.resolvedSlug,
    name: l.name,
    company: l.company,
    email: l.email,
    email_status: l.email_status,
    phone: l.phone,
    source_tool: l.source_tool,
    enrichment_tier: l.enrichment_tier,
    quarantine_reason: l.email_status === "error"
      ? "verification_error"
      : `millionverifier_${l.email_status}`,
  }));

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const readyPath = join(OUTPUT_DIR, `leads-ready-${stamp}.csv`);
  const quarantinedPath = join(OUTPUT_DIR, `quarantined-${stamp}.csv`);

  writeFileSync(readyPath, toCsv(readyRows, FINAL_COLUMNS), "utf-8");
  writeFileSync(
    quarantinedPath,
    toCsv(quarantineRows, [...FINAL_COLUMNS, "quarantine_reason"] as const),
    "utf-8"
  );

  console.log(`Wrote ${readyPath} (${good.length} good leads — ready for outreach)`);
  console.log(`Wrote ${quarantinedPath} (${quarantined.length} risky/bad/error rows — do not send)`);

  return { readyPath, quarantinedPath };
}
