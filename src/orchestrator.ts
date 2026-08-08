import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { extractEngagers, ENGAGERS_DIR } from "./extractEngagers.js";
import { resolveLinkedinUrlsExa } from "./resolveLinkedinUrlsExa.js";
import { waterfallEnrich, assertEnrichmentKeys, confirmSpendPrompt } from "./waterfallEnrich.js";
import { verifyEmail } from "./validateMillionVerifier.js";
import { buildFinalOutput } from "./buildFinalOutput.js";
import type { EnrichedLead, Engager } from "./types.js";
import { requireKey } from "./config.js";

const STAGES = ["extract", "resolve", "enrich", "validate", "output"] as const;
type Stage = (typeof STAGES)[number];

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function latestEngagersPath(): string {
  return join(ENGAGERS_DIR, `engagers-${dateStamp()}.json`);
}

function loadEngagers(filePath?: string): Engager[] {
  const path = filePath ?? latestEngagersPath();
  const abs = resolve(process.cwd(), path);
  return JSON.parse(readFileSync(abs, "utf-8")) as Engager[];
}

function saveEnriched(leads: EnrichedLead[]): void {
  const path = join(ENGAGERS_DIR, `enriched-${dateStamp()}.json`);
  writeFileSync(path, JSON.stringify(leads, null, 2), "utf-8");
  console.log(`Wrote ${path}`);
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} (y/N) `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function runStage(stage: Stage): Promise<void> {
  switch (stage) {
    case "extract": {
      const { engagers } = await extractEngagers();
      console.log(`Stage 1 complete — ${engagers.length} engagers written.`);
      break;
    }
    case "resolve": {
      const engagers = loadEngagers();
      await resolveLinkedinUrlsExa(engagers);
      writeFileSync(latestEngagersPath(), JSON.stringify(engagers, null, 2), "utf-8");
      console.log(`Stage 3 complete — resolved slugs written back.`);
      break;
    }
    case "enrich": {
      assertEnrichmentKeys();
      const engagers = loadEngagers();
      const leads = await waterfallEnrich(engagers, { confirmSpend: () => confirmSpendPrompt(engagers.length) });
      saveEnriched(leads);
      console.log(`Stage 4 complete — ${leads.filter((l) => l.email || l.phone).length} leads enriched.`);
      break;
    }
    case "validate": {
      requireKey("MILLIONVERIFIER_API_KEY");
      const leads = loadEngagers(join(ENGAGERS_DIR, `enriched-${dateStamp()}.json`)) as EnrichedLead[];
      const verified = [];
      for (const lead of leads) {
        if (!lead.email) continue;
        const v = await verifyEmail(lead.email);
        verified.push({ ...lead, email_status: v.quality });
      }
      const counts = verified.reduce<Record<string, number>>((acc, l) => {
        acc[l.email_status] = (acc[l.email_status] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `${verified.length} of ${leads.filter((l) => l.email).length} emails verified: good ${counts.good ?? 0}, risky ${counts.risky ?? 0}, bad ${counts.bad ?? 0}, error ${counts.error ?? 0}`
      );
      writeFileSync(join(ENGAGERS_DIR, `verified-${dateStamp()}.json`), JSON.stringify(verified, null, 2), "utf-8");
      console.log(`Stage 5 complete — verification results written.`);
      break;
    }
    case "output": {
      const verified = JSON.parse(
        readFileSync(join(ENGAGERS_DIR, `verified-${dateStamp()}.json`), "utf-8")
      ) as Array<EnrichedLead & { email_status: string }>;
      buildFinalOutput(verified);
      console.log(`Stage 6 complete — handoff artifacts written to output/.`);
      break;
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stageIdx = args.indexOf("--stage");
  const requested: Stage | null = stageIdx !== -1 ? (args[stageIdx + 1] as Stage) : null;

  if (requested && !STAGES.includes(requested)) {
    console.error(`Unknown stage "${requested}". Valid stages: ${STAGES.join(", ")}`);
    process.exit(1);
  }

  if (requested) {
    await runStage(requested);
    return;
  }

  // Full pipeline: run all stages in order, confirming counts between stages.
  for (const stage of STAGES) {
    console.log(`\n=== Stage ${STAGES.indexOf(stage) + 1}: ${stage} ===`);
    await runStage(stage);
    if (stage !== "output") {
      const ok = await confirm("Confirm output count and continue to the next stage?");
      if (!ok) {
        console.log("Stopped after this stage. Rerun with --stage to continue.");
        break;
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
