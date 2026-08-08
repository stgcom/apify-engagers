#!/usr/bin/env node
// Deploys the web command center to Surge.sh non-interactively.
// Requires SURGE_LOGIN (email) and SURGE_TOKEN (from `surge tokens add`).
// Cross-platform (Node) — no bash dependency.
//
// Surge improvements per https://surge.sh/docs/getting-started:
//   - Writes a CNAME in web/ so `surge publish` ships to the remembered domain.
//   - Supports --preview: uploads a revision with its own URL, no prod cutover.
//   - Ships 200.html for SPA deep links.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOMAIN = process.env.SURGE_DOMAIN ?? "apify-engagers.surge.sh";
const PREVIEW = process.argv.includes("--preview");

if (!process.env.SURGE_LOGIN || !process.env.SURGE_TOKEN) {
  console.error("ERROR: SURGE_LOGIN and SURGE_TOKEN must be set.");
  console.error("Get a token with: npm i -g surge && surge login && surge tokens add");
  console.error("Then run: set SURGE_LOGIN=<email> && set SURGE_TOKEN=<token> && npm run web:deploy");
  process.exit(1);
}

// 1. Regenerate with fresh data.
const gen = spawnSync(process.execPath, [join(ROOT, "scripts", "generate-web.js")], { cwd: ROOT, stdio: "inherit" });
if (gen.status !== 0) process.exit(gen.status ?? 1);

// 2. Locate the surge CLI. If missing, try npx (may prompt to install once).
function findSurge() {
  const which = spawnSync("where", ["surge"], { shell: true });
  if (which.status === 0) return "surge";
  return "npx"; // npx surge will fetch it if not cached
}

const surgeBin = findSurge();
// Build args. Preview gets its own URL; production uses the CNAME-remembered domain.
const baseArgs = [join(ROOT, "web")];
if (PREVIEW) {
  baseArgs.push("--domain", `${DOMAIN.replace(".surge.sh", "")}-preview.surge.sh`);
} else {
  baseArgs.push("--domain", DOMAIN);
}
const args = surgeBin === "npx" ? ["surge", ...baseArgs] : baseArgs;

const mode = PREVIEW ? `preview ${DOMAIN.replace(".surge.sh", "")}-preview.surge.sh` : `production ${DOMAIN}`;
console.log(`Deploying web/ to ${mode} (via ${surgeBin})...`);
const deploy = spawnSync(surgeBin, args, {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, SURGE_LOGIN: process.env.SURGE_LOGIN, SURGE_TOKEN: process.env.SURGE_TOKEN },
});

if (deploy.status !== 0) {
  console.error(`Deploy failed with status ${deploy.status}`);
  process.exit(deploy.status ?? 1);
}
console.log(PREVIEW ? `Preview live (does NOT affect production)` : `Live at: https://${DOMAIN}`);
