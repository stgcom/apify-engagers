#!/usr/bin/env node
// Generates the futuristic purple-space web command center
// (web/index.html + web/data.js) from the pipeline's latest artifacts.
// Static SPA — no framework, no build step. Lottie via CDN.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGAGERS_DIR = ROOT; // engagers-*/enriched-*/verified-*.json live in project root
const OUTPUT_DIR = join(ROOT, "output");
const WEB_DIR = join(ROOT, "web");

// GitHub Actions "Run Extract" trigger URL. Set GH_REPO to
// "<owner>/<repo>" (e.g. "grahamfirm/apify-engagers") once the repo exists.
const GH_REPO = process.env.GH_REPO ?? "your-org/apify-engagers";
const GH_ACTIONS_URL = `https://github.com/${GH_REPO}/actions/workflows/extract.yml`;

function latestFile(dir, prefix, ext) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext));
  if (files.length === 0) return null;
  files.sort().reverse();
  return join(dir, files[0]);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function parseCsv(path) {
  if (!path || !existsSync(path)) return [];
  const text = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
    return obj;
  });
}

function buildData() {
  const engagersFile = latestFile(ENGAGERS_DIR, "engagers-", ".json");
  const enrichedFile = latestFile(ENGAGERS_DIR, "enriched-", ".json");
  const verifiedFile = latestFile(ENGAGERS_DIR, "verified-", ".json");
  const readyFile = latestFile(OUTPUT_DIR, "leads-ready-", ".csv");
  const quarantinedFile = latestFile(OUTPUT_DIR, "quarantined-", ".csv");

  const engagers = readJsonSafe(engagersFile) ?? [];
  const enriched = readJsonSafe(enrichedFile) ?? [];
  const verified = readJsonSafe(verifiedFile) ?? [];
  const leadsReady = parseCsv(readyFile);
  const quarantined = parseCsv(quarantinedFile);

  const verifiedCount = verified.length;
  const good = verified.filter((v) => v.email_status === "good").length;
  const risky = verified.filter((v) => v.email_status === "risky").length;
  const bad = verified.filter((v) => v.email_status === "bad").length;
  const error = verifiedCount - good - risky - bad;

  const funnel = {
    total: enriched.length,
    getleads: enriched.filter((l) => l.source_tool === "getleads").length,
    apollo: enriched.filter((l) => l.source_tool === "apollo").length,
    prospeo: enriched.filter((l) => l.source_tool === "prospeo").length,
    unresolved: enriched.filter((l) => !l.email && !l.phone).length,
  };

  const obfuscated = engagers.filter((e) => e.obfuscatedUrn).length;
  const resolved = engagers.filter((e) => e.resolvedSlug && e.resolvedSlug !== "unresolved").length;

  const stages = [
    { name: "1. Extract", status: engagers.length > 0 ? "done" : "pending", count: engagers.length },
    { name: "2. Flag URNs", status: obfuscated > 0 ? "done" : "pending", count: obfuscated },
    { name: "3. Resolve", status: resolved > 0 ? "done" : "pending", count: resolved },
    { name: "4. Enrich", status: enriched.length > 0 ? "done" : "pending", count: enriched.length },
    { name: "5. Validate", status: verifiedCount > 0 ? "done" : "pending", count: verifiedCount },
    { name: "6. Output", status: leadsReady.length > 0 ? "done" : "pending", count: leadsReady.length },
  ];

  const overall = good > 0 ? "green" : (risky > 0 || bad > 0) ? "amber" : "gray";

  return {
    generatedAt: new Date().toISOString(),
    overall,
    counts: { engagers: engagers.length, enriched: enriched.length, verified: verifiedCount, good, risky, bad, error, quarantined: quarantined.length },
    funnel,
    stages,
    leadsReady,
    quarantined,
    files: {
      engagers: engagersFile ? basename(engagersFile) : null,
      enriched: enrichedFile ? basename(enrichedFile) : null,
      verified: verifiedFile ? basename(verifiedFile) : null,
      leadsReady: readyFile ? basename(readyFile) : null,
      quarantined: quarantinedFile ? basename(quarantinedFile) : null,
    },
  };
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

const data = buildData();
mkdirSync(WEB_DIR, { recursive: true });

writeFileSync(join(WEB_DIR, "data.js"), `window.PIPELINE_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf-8");
writeFileSync(join(WEB_DIR, "index.html"), renderHtml(data), "utf-8");
writeFileSync(join(WEB_DIR, "landing.html"), renderLanding(data), "utf-8");
// Surge CNAME: remembers the deploy domain so `surge publish` ships there
// without re-prompting (per surge.sh/docs/getting-started).
const cnameDomain = process.env.SURGE_DOMAIN ?? "apify-engagers.surge.sh";
writeFileSync(join(WEB_DIR, "CNAME"), `${cnameDomain}\n`, "utf-8");
// SPA routing: 200.html ensures deep links like /landing resolve (per
// surge.sh/docs/platform/spa-routing). We copy index.html as the SPA shell.
writeFileSync(join(WEB_DIR, "200.html"), renderHtml(data), "utf-8");

console.log(`Generated ${join(WEB_DIR, "index.html")} + landing.html + data.js + CNAME`);
console.log(`  counts: engagers=${data.counts.engagers} enriched=${data.counts.enriched} verified=${data.counts.verified} good=${data.counts.good} risky=${data.counts.risky} bad=${data.counts.bad} quarantined=${data.counts.quarantined}`);

function renderHtml(d) {
  const statusLabel = { green: "OPERATIONAL", amber: "PARTIAL", gray: "AWAITING FIRST RUN" }[d.overall] ?? "UNKNOWN";
  const statusClass = d.overall;

  // DAI / DREAM AI LABS / AI CONSULTING GROUP logo — neon purple glow on "AI".
  // Matches the brand color theory: deep purple #1a0a3e + neon #8a2be2.
  const daiLogo = `
    <div class="dai-logo" role="img" aria-label="DAI Dream AI Labs AI Consulting Group">
      <div class="dai-mark"><span>D</span><span class="dai-ai">AI</span></div>
      <div class="dai-sub">DREAM AI LABS</div>
      <div class="dai-sub2">AI CONSULTING GROUP</div>
    </div>`;

  // Hero DAI SVG — inline so it scales + animates with GSAP. Neon glow on "AI".
  const daiHeroSvg = `
    <svg class="dai-hero-svg" viewBox="0 0 220 130" role="img" aria-label="DAI Dream AI Labs">
      <defs>
        <linearGradient id="daiBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2e0854"/><stop offset="1" stop-color="#0d001a"/>
        </linearGradient>
        <filter id="neonGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect x="2" y="2" width="216" height="126" rx="18" fill="url(#daiBg)" stroke="#8a2be2" stroke-opacity="0.6"/>
      <text class="dai-hero-mark" x="110" y="52" text-anchor="middle" font-family="Orbitron, sans-serif" font-weight="900" font-size="42" fill="#ffffff">
        <tspan>D</tspan><tspan class="dai-hero-ai" filter="url(#neonGlow)" fill="#8a2be2">AI</tspan>
      </text>
      <text x="110" y="80" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="600" font-size="12" letter-spacing="3" fill="#e9e2f5">DREAM AI LABS</text>
      <text x="110" y="98" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="300" font-size="9" letter-spacing="4" fill="#b7a9d4">AI CONSULTING GROUP</text>
    </svg>`;


  // Stage cards — semi-circular gauge style with count
  const stageCards = d.stages.map((s, i) => {
    const pct = s.status === "done" ? 100 : 0;
    const glow = s.status === "done" ? "done" : "pending";
    return `
    <div class="card stage" style="animation-delay:${i * 90 + 20}ms">
      <div class="gauge" data-pct="${pct}">
        <div class="gauge-inner">
          <div class="gauge-count">${s.count}</div>
          <div class="gauge-label">${esc(s.name)}</div>
        </div>
      </div>
      <div class="stage-status ${glow}">${s.status === "done" ? "ONLINE" : "STANDBY"}</div>
    </div>`;
  }).join("");

  // Funnel — horizontal stacked bar (purple glow)
  const funnelTotal = Math.max(d.funnel.total, 1);
  const funnelSegs = [
    ["getleads", d.funnel.getleads, "var(--accent)"],
    ["apollo", d.funnel.apollo, "var(--accent2)"],
    ["prospeo", d.funnel.prospeo, "var(--accent3)"],
    ["unresolved", d.funnel.unresolved, "var(--muted)"],
  ];
  const funnelBar = funnelSegs.map(([name, count, color]) => {
    const width = (count / funnelTotal) * 100;
    return `<div class="funnel-seg" style="width:${width}%;background:${color}" title="${esc(name)}: ${count}"></div>`;
  }).join("");
  const funnelRows = [
    ["LinkedIn URLs (enriched)", d.funnel.total, "var(--text)"],
    ["GetLeads found", d.funnel.getleads, "var(--accent)"],
    ["Apollo found", d.funnel.apollo, "var(--accent2)"],
    ["Prospeo found", d.funnel.prospeo, "var(--accent3)"],
    ["Still unresolved", d.funnel.unresolved, "var(--muted)"],
  ].map(([k, v, c]) => `<tr><td><span class="legend-dot" style="background:${c}"></span>${esc(k)}</td><td class="num">${v}</td></tr>`).join("");

  // Leads-ready table
  const leadRows = d.leadsReady.length === 0
    ? `<tr><td colspan="9" class="empty">No leads-ready rows yet. Awaiting first pipeline run.</td></tr>`
    : d.leadsReady.map((r, i) => `<tr style="animation-delay:${i * 40}ms">
        <td class="mono">${esc(r.linkedin_url)}</td>
        <td class="mono">${esc(r.resolved_slug)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.company)}</td>
        <td class="mono">${esc(r.email)}</td>
        <td><span class="badge good">${esc(r.email_status)}</span></td>
        <td class="mono">${esc(r.phone)}</td>
        <td>${esc(r.source_tool)}</td>
        <td class="num">${esc(r.enrichment_tier)}</td>
      </tr>`).join("");

  // Quarantine table
  const quarantineRows = d.quarantined.length === 0
    ? `<tr><td colspan="9" class="empty">No quarantined rows. Clean slate.</td></tr>`
    : d.quarantined.map((r, i) => `<tr style="animation-delay:${i * 40}ms">
        <td class="mono">${esc(r.linkedin_url)}</td>
        <td class="mono">${esc(r.resolved_slug)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.email)}</td>
        <td><span class="badge ${r.email_status}">${esc(r.email_status)}</span></td>
        <td>${esc(r.phone)}</td>
        <td>${esc(r.source_tool)}</td>
        <td class="num">${esc(r.enrichment_tier)}</td>
        <td>${esc(r.quarantine_reason)}</td>
      </tr>`).join("");

  const csvLink = d.files.leadsReady
    ? `<a class="btn" href="#" onclick="exportCsv('leads-ready', window.PIPELINE_DATA.leadsReady)">Export leads CSV</a>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>apify-engagers — Command Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
/* ===== Design tokens: deep purple space ===== */
:root {
  --bg: #0b0714;            /* deep space purple */
  --bg2: #120b22;           /* slightly lifted space */
  --surface: #151026;
  --surface2: #1e1734;
  --surface3: #271e44;
  --border: #2e2547;
  --border-glow: #7c3aed88;
  --text: #e9e2f5;
  --text2: #b7a9d4;
  --muted: #7d6ea0;
  --accent: #a78bfa;        /* violet pop */
  --accent2: #c4b5fd;
  --accent3: #8b5cf6;
  --neon: #8b5cf6;
  --neon-strong: #a78bfa;
  --green: #4ade80;
  --amber: #fbbf24;
  --red: #f87171;
  --gray: #6e7681;
  --logo-bg: #1a0a3e;       /* DAI logo background purple */
  --logo-neon: #8a2be2;     /* DAI neon purple glow */
  --font-display: 'Orbitron', monospace;
  --font-body: 'Space Grotesk', system-ui, sans-serif;
  --radius: 12px;
  --glow-sm: 0 0 8px #8b5cf655;
  --glow-md: 0 0 16px #8b5cf688;
  --glow-lg: 0 0 32px #8b5cf6bb;
}
* { box-sizing:border-box; margin:0; padding:0; }
html { scroll-behavior:smooth; }
body {
  background:
    radial-gradient(1200px 600px at 80% -10%, #2a1b4e66 0%, transparent 60%),
    radial-gradient(900px 500px at -10% 110%, #2a1b4e55 0%, transparent 55%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
  background-attachment: fixed;
  color: var(--text);
  font-family: var(--font-body);
  min-height:100vh;
}
a { color: var(--accent); text-decoration:none; }

/* ===== Layout: control room ===== */
.shell { display:flex; min-height:100vh; }

/* Icon rail */
.rail {
  width:64px; background:var(--surface); border-right:1px solid var(--border);
  display:flex; flex-direction:column; align-items:center; padding-top:1rem; gap:.4rem;
  position:sticky; top:0; height:100vh; z-index:20;
}
.rail .logo-slot {
  width:40px; height:40px; border-radius:10px; margin-bottom:1rem;
  background:var(--surface2); border:1px dashed var(--accent3);
  display:flex; align-items:center; justify-content:center;
  box-shadow:var(--glow-sm);
}
.rail .logo-slot .logo-mark { font-size:1.3rem; color:var(--accent); font-family:var(--font-display); font-weight:900; }
.rail .rail-icon {
  width:44px; height:44px; border-radius:10px; display:flex; align-items:center; justify-content:center;
  color:var(--muted); cursor:pointer; border:1px solid transparent; transition:all .2s;
  position:relative;
}
.rail .rail-icon:hover { color:var(--accent); background:var(--surface2); box-shadow:var(--glow-sm); }
.rail .rail-icon.active { color:var(--accent2); background:var(--surface3); box-shadow:var(--glow-md); border-color:var(--border-glow); }
.rail .rail-icon svg { width:22px; height:22px; }

/* Nav panel */
.nav {
  width:230px; background:var(--surface); border-right:1px solid var(--border);
  padding:1.2rem .8rem; position:sticky; top:0; height:100vh; overflow-y:auto; z-index:10;
}
.nav h3 { font-family:var(--font-display); font-size:.7rem; letter-spacing:.15em; color:var(--muted); text-transform:uppercase; margin:.4rem .6rem 1rem; }
.nav-item {
  display:flex; align-items:center; gap:.6rem; padding:.6rem .8rem; margin-bottom:.2rem;
  border-radius:8px; color:var(--text2); cursor:pointer; font-size:.88rem; font-weight:500;
  border:1px solid transparent; transition:all .2s;
}
.nav-item:hover { background:var(--surface2); color:var(--text); box-shadow:var(--glow-sm); }
.nav-item.active { background:var(--surface3); color:var(--accent2); border-color:var(--border-glow); box-shadow:var(--glow-md); }
.nav-item .chev { margin-left:auto; font-size:.7rem; color:var(--muted); transition:transform .25s; }
.nav-item.open .chev { transform:rotate(90deg); }
.nav-sub { display:none; }
.nav-item.open + .nav-sub { display:block; }
.nav-sub .nav-item { padding-left:1.8rem; font-size:.8rem; }

/* Main content */
.main { flex:1; padding:1.6rem 2rem; max-width:1400px; }

/* Top bar */
.topbar {
  display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem;
  margin-bottom:1.6rem; padding-bottom:1.2rem; border-bottom:1px solid var(--border);
}
.brand { display:flex; align-items:center; gap:.9rem; }
.brand .logo-slot {
  width:44px; height:44px; border-radius:12px; background:var(--surface2);
  border:1px dashed var(--accent3); display:flex; align-items:center; justify-content:center;
  box-shadow:var(--glow-sm);
}
.brand .logo-slot .logo-mark { font-size:1.5rem; color:var(--accent); font-family:var(--font-display); font-weight:900; }
.brand h1 { font-family:var(--font-display); font-size:1.15rem; letter-spacing:.06em; font-weight:700; }
.brand .sub { color:var(--muted); font-size:.78rem; }
.topbar-right { display:flex; align-items:center; gap:.8rem; flex-wrap:wrap; }
.status {
  padding:.4rem 1rem; border-radius:999px; font-family:var(--font-display);
  font-size:.72rem; letter-spacing:.12em; font-weight:700;
}
.status.green { background:#4ade801f; color:var(--green); border:1px solid var(--green); box-shadow:0 0 12px #4ade8044; }
.status.amber { background:#fbbf241f; color:var(--amber); border:1px solid var(--amber); box-shadow:0 0 12px #fbbf2444; }
.status.gray { background:#6e76811f; color:var(--muted); border:1px solid var(--gray); }
.timestamp { color:var(--muted); font-size:.78rem; }
.pill {
  padding:.35rem .9rem; border-radius:999px; border:1px solid var(--border);
  background:var(--surface); color:var(--text2); font-size:.78rem; cursor:pointer; transition:all .2s;
}
.pill:hover { border-color:var(--accent3); color:var(--accent); box-shadow:var(--glow-sm); }
.pill.active { background:var(--surface3); border-color:var(--accent3); color:var(--accent2); box-shadow:var(--glow-md); }

/* Hero */
.hero {
  display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1.5rem;
  padding:1.8rem 2rem; margin-bottom:1.6rem; border-radius:var(--radius);
  background:linear-gradient(135deg, var(--surface2), var(--surface));
  border:1px solid var(--border); position:relative; overflow:hidden;
  box-shadow:inset 0 1px 0 #ffffff10, 0 0 24px #8b5cf622;
}
.hero::before {
  content:""; position:absolute; top:-50%; left:-20%; width:70%; height:200%;
  background:radial-gradient(closest-side, #8b5cf633, transparent); pointer-events:none;
}
.hero h2 { font-family:var(--font-display); font-size:1.5rem; letter-spacing:.05em; margin-bottom:.3rem; }
.hero .sub { color:var(--muted); font-size:.9rem; }
.hero .hero-stat { text-align:right; }
.hero .hero-stat .big { font-family:var(--font-display); font-size:2.2rem; font-weight:900; color:var(--accent2); text-shadow:0 0 20px #8b5cf6aa; }
.hero .hero-stat .lbl { color:var(--muted); font-size:.75rem; letter-spacing:.1em; text-transform:uppercase; }
.hero-logo { width:210px; height:126px; position:relative; }
.dai-hero-svg { width:100%; height:100%; filter:drop-shadow(0 0 12px #8a2be266); }
.dai-hero-ai { filter:url(#neonGlow); }
.dai-hero-mark { letter-spacing:.02em; }
/* GSAP targets — initial state set in JS, never left invisible if GSAP fails */
.gsap-ready .card, .gsap-ready tbody tr, .gsap-ready .funnel, .gsap-ready .section, .gsap-ready .hero, .gsap-ready .topbar { visibility:visible; }

/* Cards + grid */
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:1rem; margin-bottom:1.6rem; }
.card {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  padding:1.2rem; box-shadow:inset 0 1px 0 #ffffff08;
  animation:cardIn .5s cubic-bezier(.2,.8,.2,1) both;
}
.card:hover { border-color:var(--border-glow); box-shadow:var(--glow-sm); }
@keyframes cardIn { from { opacity:0; transform:translateY(12px) scale(.97); } to { opacity:1; transform:none; } }

/* Stage gauge */
.stage { text-align:center; position:relative; overflow:hidden; }
.stage::after {
  content:""; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(60% 60% at 50% 0%, #8b5cf618, transparent);
}
.gauge { position:relative; width:120px; height:72px; margin:0 auto .6rem; }
.gauge::before {
  content:""; position:absolute; inset:0; border-radius:120px 120px 0 0;
  background:conic-gradient(from 180deg at 50% 100%, var(--neon) 0deg, var(--neon) ${0}deg, #1e1734 ${0}deg);
  opacity:0; transition:opacity .3s;
}
.gauge-inner { position:absolute; inset:6px 6px 0; border-radius:110px 110px 0 0; background:var(--surface2); display:flex; flex-direction:column; align-items:center; justify-content:flex-end; padding-bottom:.4rem; }
.gauge-count { font-family:var(--font-display); font-size:1.5rem; font-weight:900; color:var(--accent2); }
.gauge-label { font-size:.68rem; color:var(--muted); letter-spacing:.04em; }
.stage-status { font-family:var(--font-display); font-size:.62rem; letter-spacing:.14em; }
.stage-status.done { color:var(--green); text-shadow:0 0 8px #4ade8044; }
.stage-status.pending { color:var(--muted); }

/* Funnel */
.funnel-wrap { margin-bottom:1.6rem; }
.funnel {
  display:flex; height:14px; border-radius:7px; overflow:hidden; gap:2px;
  background:var(--surface2); box-shadow:inset 0 1px 0 #ffffff08, 0 0 12px #8b5cf633;
  margin-bottom:1rem;
}
.funnel-seg { height:100%; transition:width .6s cubic-bezier(.2,.8,.2,1); }
.legend-dot { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:.5rem; vertical-align:middle; }
table {
  width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--border);
  border-radius:var(--radius); overflow:hidden; font-size:.82rem; box-shadow:inset 0 1px 0 #ffffff08;
}
th, td { padding:.6rem .8rem; text-align:left; border-bottom:1px solid var(--border); }
th { background:var(--surface2); color:var(--text2); font-weight:600; text-transform:uppercase; font-size:.68rem; letter-spacing:.08em; }
tr:last-child td { border-bottom:none; }
tbody tr { animation:rowIn .4s cubic-bezier(.2,.8,.2,1) both; transition:background .15s; }
tbody tr:hover { background:var(--surface2); }
tbody tr:hover td { color:var(--text); }
@keyframes rowIn { from { opacity:0; transform:translateX(-8px); } to { opacity:1; transform:none; } }
.num { text-align:right; }
.mono { font-size:.76rem; }
.empty { color:var(--muted); text-align:center; padding:1.5rem; font-style:italic; }

/* Badges */
.badge { padding:.18rem .6rem; border-radius:999px; font-size:.72rem; font-weight:600; }
.badge.good { background:#4ade801f; color:var(--green); box-shadow:0 0 8px #4ade8033; }
.badge.risky { background:#fbbf241f; color:var(--amber); box-shadow:0 0 8px #fbbf2433; }
.badge.bad { background:#f871711f; color:var(--red); box-shadow:0 0 8px #f8717133; }

/* Buttons */
.btn {
  display:inline-flex; align-items:center; gap:.5rem; margin-top:1rem; padding:.6rem 1.3rem;
  background:linear-gradient(135deg, var(--accent3), var(--accent)); color:#0b0714;
  border-radius:999px; font-family:var(--font-body); font-weight:600; font-size:.85rem;
  border:none; cursor:pointer; transition:all .2s; box-shadow:var(--glow-md);
}
.btn:hover { box-shadow:var(--glow-lg); transform:translateY(-1px); }
.btn:active { transform:scale(.97); }
.btn:focus-visible { outline:2px dashed var(--accent2); outline-offset:2px; }
.btn-secondary { background:var(--surface2); color:var(--accent2); border:1px solid var(--accent3); box-shadow:none; }
.btn-secondary:hover { box-shadow:var(--glow-sm); transform:translateY(-1px); }
.run-extract { margin-top:.8rem; font-size:.8rem; padding:.5rem 1.1rem; }

/* Settings inputs */
.field-label { display:block; font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:.9rem 0 .35rem; }
.input {
  width:100%; padding:.6rem .8rem; border-radius:8px; border:1px solid var(--border);
  background:var(--surface2); color:var(--text); font-family:var(--font-body); font-size:.88rem;
  transition:border-color .2s, box-shadow .2s;
}
.input:focus { outline:none; border-color:var(--accent3); box-shadow:0 0 0 3px #8a2be233; }
.input::placeholder { color:var(--muted); }
.textarea { resize:vertical; min-height:120px; line-height:1.5; }
.field-row { display:flex; gap:.4rem; }
.field-row .input { flex:1; }
.icon-btn {
  width:42px; height:42px; border-radius:8px; border:1px solid var(--border);
  background:var(--surface2); color:var(--text2); cursor:pointer; font-size:1rem;
  transition:all .2s;
}
.icon-btn:hover { border-color:var(--accent3); color:var(--accent); box-shadow:var(--glow-sm); }
.btn-row { display:flex; align-items:center; gap:.8rem; margin-top:1.2rem; flex-wrap:wrap; }
.save-note { color:var(--green); font-size:.8rem; }

h2.section { font-family:var(--font-display); font-size:1rem; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin:1.6rem 0 .9rem; }
h2.section::before { content:"▸ "; color:var(--neon); }

/* Logo placeholder */
.logo-slot .logo-placeholder { font-size:.6rem; color:var(--muted); text-align:center; line-height:1.1; font-family:var(--font-body); }

/* DAI logo — neon purple glow on "AI" */
.dai-logo { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; line-height:1.05; }
.dai-mark { font-family:var(--font-display); font-weight:900; letter-spacing:.02em; white-space:nowrap; }
.dai-mark .dai-ai { color:var(--logo-neon); text-shadow:0 0 6px var(--logo-neon), 0 0 14px var(--logo-neon), 0 0 28px #8a2be2cc; }
.dai-sub { font-family:var(--font-body); font-weight:600; letter-spacing:.12em; white-space:nowrap; }
.dai-sub2 { font-family:var(--font-body); font-weight:300; letter-spacing:.18em; white-space:nowrap; }
/* Rail variant (compact) */
.rail .logo-slot { width:52px; height:52px; border-radius:10px; background:var(--logo-bg); border:1px solid var(--logo-neon); box-shadow:var(--glow-sm); }
.rail .dai-logo { gap:1px; }
.rail .dai-mark { font-size:.9rem; }
.rail .dai-mark .dai-ai { font-size:1.05rem; }
.rail .dai-sub { font-size:.34rem; }
.rail .dai-sub2 { font-size:.3rem; }
/* Brand variant */
.brand .logo-slot { width:64px; height:64px; border-radius:12px; background:var(--logo-bg); border:1px solid var(--logo-neon); box-shadow:var(--glow-md); }
.brand .dai-logo { gap:1px; }
.brand .dai-mark { font-size:1.1rem; }
.brand .dai-mark .dai-ai { font-size:1.3rem; }
.brand .dai-sub { font-size:.42rem; }
.brand .dai-sub2 { font-size:.38rem; }

/* Empty state */
.empty-hero { text-align:center; padding:3rem 1rem; }
.empty-hero .big { font-family:var(--font-display); font-size:1.6rem; color:var(--accent2); margin-bottom:.5rem; text-shadow:0 0 20px #8b5cf688; }
.empty-hero .sub { color:var(--muted); }

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  * { animation-duration:.1s !important; transition-duration:.1s !important; }
  .gauge, .hero-anim, .pulse { display:none; }
  html { scroll-behavior:auto; }
}

/* Responsive */
@media (max-width: 1024px) {
  .nav { width:200px; }
  .main { padding:1rem; }
}
@media (max-width: 768px) {
  .shell { flex-direction:column; }
  .rail { flex-direction:row; width:100%; height:auto; padding:.5rem 1rem; position:sticky; top:0; }
  .rail .logo-slot { margin-bottom:0; margin-right:.5rem; }
  .nav { width:100%; height:auto; position:static; border-right:none; border-bottom:1px solid var(--border); }
  .hero { flex-direction:column; align-items:flex-start; }
  .hero .hero-stat { text-align:left; }
  table { font-size:.72rem; }
  th, td { padding:.45rem .5rem; }
  .grid { grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); }
}
</style>
</head>
<body>
<div class="shell">
  <!-- Icon rail -->
  <div class="rail" role="navigation" aria-label="Quick nav">
    <div class="logo-slot" title="DAI — Dream AI Labs">
      ${daiLogo}
    </div>
    <div class="rail-icon active" data-nav="overview" title="Overview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>
    <div class="rail-icon" data-nav="pipeline" title="Pipeline"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M5 6h14M5 18h14"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/></svg></div>
    <div class="rail-icon" data-nav="engagers" title="Engagers"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg></div>
    <div class="rail-icon" data-nav="enrich" title="Enrichment"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 4-7 4-7-4 7-4z"/><path d="M5 12l7 4 7-4M5 17l7 4 7-4"/></svg></div>
    <div class="rail-icon" data-nav="validate" title="Validation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z"/><path d="M9 12l2 2 4-4"/></svg></div>
    <div class="rail-icon" data-nav="handoff" title="Handoff"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M4 4l8 8 8-8M4 20l8-8 8 8"/></svg></div>
    <div class="rail-icon" data-nav="settings" title="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div>
  </div>

  <!-- Nav panel -->
  <nav class="nav" aria-label="Sections">
    <h3>Pipeline Control</h3>
    <div class="nav-item active" data-target="overview">Overview <span class="chev">▶</span></div>
    <div class="nav-item" data-target="pipeline">Pipeline Stages <span class="chev">▶</span></div>
    <div class="nav-item" data-target="engagers">Engagers <span class="chev">▶</span></div>
    <div class="nav-item" data-target="enrich">Enrichment <span class="chev">▶</span></div>
    <div class="nav-item" data-target="validate">Validation <span class="chev">▶</span></div>
    <div class="nav-item" data-target="handoff">Handoff / Output <span class="chev">▶</span></div>
    <div class="nav-item" data-target="settings">Settings / Inputs <span class="chev">▶</span></div>
  </nav>

  <!-- Main content -->
  <main class="main">
    <div class="topbar">
      <div class="brand">
        <div class="logo-slot" id="logo-slot" title="DAI — Dream AI Labs">
          ${daiLogo}
        </div>
        <div>
          <h1>APIFY ENGAGERS</h1>
          <div class="sub">LinkedIn engager extraction &amp; enrichment control room</div>
        </div>
      </div>
      <div class="topbar-right">
        <div class="timestamp">generated ${esc(d.generatedAt)}</div>
        <button class="pill" data-range="7">Last 7 days</button>
        <button class="pill active" data-range="30">Last 30 days</button>
        <span class="status ${statusClass}">${statusLabel}</span>
      </div>
    </div>

    <section id="overview">
      <div class="hero">
        <div>
          <h2>Pipeline Overview</h2>
          <div class="sub">Stage telemetry, enrichment funnel, and handoff readiness</div>
        </div>
        <div class="hero-logo" id="hero-logo">${daiHeroSvg}</div>
        <div class="hero-stat">
          <div class="big">${d.counts.good}</div>
          <div class="lbl">validated leads</div>
          <div class="lbl" style="margin-top:.2rem">${d.counts.engagers} engagers · ${d.counts.verified} verified</div>
          <a class="btn run-extract" id="run-extract"
             href="${esc(GH_ACTIONS_URL)}"
             target="_blank" rel="noopener"
             title="Triggers the widening pass via GitHub Actions (workflow_dispatch)">Run Extract ▸</a>
        </div>
      </div>

      <h2 class="section">Stage Telemetry</h2>
      <div class="grid">${stageCards}</div>

      <h2 class="section">Enrichment Funnel</h2>
      <div class="card funnel-wrap">
        <div class="funnel">${funnelBar}</div>
        <table><tbody>${funnelRows}</tbody></table>
      </div>
    </section>

    <section id="pipeline" hidden>
      <h2 class="section">Pipeline Stages</h2>
      <div class="grid">${stageCards}</div>
      <div class="card" style="margin-top:1rem">
        <div class="sub" style="color:var(--muted);line-height:1.6">
          Order is fixed: extract (Apify) → flag obfuscated URNs → resolve via Exa →
          waterfall enrich (GetLeads → Apollo → Prospeo) → MillionVerifier validate → handoff CSV.
          Only rows marked <span class="badge good">good</span> reach the handoff file.
        </div>
      </div>
    </section>

    <section id="engagers" hidden>
      <h2 class="section">Engagers — ${d.counts.engagers} unique</h2>
      <div class="card" style="margin-bottom:1rem">
        <div class="sub" style="color:var(--muted);line-height:1.6">
          Deduped by profile URL across reactor + commenter datasets. Obfuscated ACoAA URNs are
          flagged, never discarded; they are resolved to public /in/ slugs in Stage 3.
        </div>
      </div>
      <table>
        <thead><tr><th>stage</th><th>status</th><th>count</th></tr></thead>
        <tbody>
          <tr><td>Engagers extracted</td><td><span class="badge ${d.counts.engagers > 0 ? 'good' : 'risky'}">${d.counts.engagers > 0 ? 'done' : 'pending'}</span></td><td class="num">${d.counts.engagers}</td></tr>
          <tr><td>Enriched</td><td><span class="badge ${d.counts.enriched > 0 ? 'good' : 'risky'}">${d.counts.enriched > 0 ? 'done' : 'pending'}</span></td><td class="num">${d.counts.enriched}</td></tr>
          <tr><td>Verified</td><td><span class="badge ${d.counts.verified > 0 ? 'good' : 'risky'}">${d.counts.verified > 0 ? 'done' : 'pending'}</span></td><td class="num">${d.counts.verified}</td></tr>
        </tbody>
      </table>
    </section>

    <section id="enrich" hidden>
      <h2 class="section">Enrichment Funnel</h2>
      <div class="card funnel-wrap">
        <div class="funnel">${funnelBar}</div>
        <table><tbody>${funnelRows}</tbody></table>
      </div>
    </section>

    <section id="validate" hidden>
      <h2 class="section">Validation — ${d.counts.verified} verified</h2>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
        <div class="card"><div class="gauge-count" style="color:var(--green)">${d.counts.good}</div><div class="gauge-label">good</div></div>
        <div class="card"><div class="gauge-count" style="color:var(--amber)">${d.counts.risky}</div><div class="gauge-label">risky</div></div>
        <div class="card"><div class="gauge-count" style="color:var(--red)">${d.counts.bad}</div><div class="gauge-label">bad</div></div>
        <div class="card"><div class="gauge-count" style="color:var(--muted)">${d.counts.error}</div><div class="gauge-label">error</div></div>
      </div>
    </section>

    <section id="handoff" hidden>
      <h2 class="section">Leads Ready (good) — ${d.leadsReady.length}</h2>
      <table>
        <thead><tr>
          <th>linkedin_url</th><th>slug</th><th>name</th><th>company</th><th>email</th>
          <th>status</th><th>phone</th><th>source</th><th>tier</th>
        </tr></thead>
        <tbody>${leadRows}</tbody>
      </table>
      ${csvLink}

      <h2 class="section" style="margin-top:2rem">Quarantined (risky/bad — do not send) — ${d.quarantined.length}</h2>
      <table>
        <thead><tr>
          <th>linkedin_url</th><th>slug</th><th>name</th><th>email</th><th>status</th>
          <th>phone</th><th>source</th><th>tier</th><th>reason</th>
        </tr></thead>
        <tbody>${quarantineRows}</tbody>
      </table>
    </section>

    <section id="settings" hidden>
      <h2 class="section">Settings / Inputs</h2>
      <div class="card" style="max-width:720px;margin-bottom:1.4rem">
        <div class="sub" style="color:var(--muted);line-height:1.6;margin-bottom:1rem">
          Enter pipeline credentials and target post URLs. Saved in this browser only
          (localStorage). The "Export .env" button downloads a ready-to-use
          <span class="mono" style="color:var(--accent)">.env</span> file for the local pipeline.
        </div>

        <label class="field-label" for="inp-apify">APIFY_TOKEN</label>
        <div class="field-row">
          <input type="password" id="inp-apify" class="input" placeholder="apify_api_..." autocomplete="off">
          <button class="icon-btn" id="toggle-apify" title="Show/hide">👁</button>
        </div>

        <label class="field-label" for="inp-exa">EXA_API_KEY</label>
        <div class="field-row">
          <input type="password" id="inp-exa" class="input" placeholder="exa_..." autocomplete="off">
          <button class="icon-btn" id="toggle-exa" title="Show/hide">👁</button>
        </div>

        <label class="field-label" for="inp-getleads">GETLEADS_API_KEY</label>
        <input type="password" id="inp-getleads" class="input" placeholder="getleads key" autocomplete="off">

        <label class="field-label" for="inp-apollo">APOLLO_API_KEY</label>
        <input type="password" id="inp-apollo" class="input" placeholder="apollo key" autocomplete="off">

        <label class="field-label" for="inp-prospeo">PROSPEO_API_KEY</label>
        <input type="password" id="inp-prospeo" class="input" placeholder="prospeo key" autocomplete="off">

        <label class="field-label" for="inp-mv">MILLIONVERIFIER_API_KEY</label>
        <input type="password" id="inp-mv" class="input" placeholder="millionverifier key" autocomplete="off">

        <label class="field-label" for="inp-posts">Tracked post URLs (one per line)</label>
        <textarea id="inp-posts" class="input textarea" rows="6" placeholder="https://www.linkedin.com/posts/...&#10;https://www.linkedin.com/posts/..."></textarea>

        <div class="btn-row">
          <button class="btn" id="save-settings">Save to this browser</button>
          <button class="btn btn-secondary" id="export-env">Export .env</button>
          <span class="save-note" id="save-note"></span>
        </div>
      </div>
    </section>
  </main>
</div>

<script src="data.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script>
(function() {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // GSAP hero + section animations (skip if reduced-motion or GSAP unavailable)
  if (!prefersReduced && window.gsap) {
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from('#hero-logo', { y: -24, opacity: 0, scale: .9, duration: .8, ease: 'back.out(1.4)' })
      .from('.dai-hero-mark tspan', { opacity: 0, y: 10, stagger: .1, duration: .4 }, '-=.3')
      .from('.topbar', { y: -12, opacity: 0, duration: .5 }, '-=.5')
      .from('.hero h2, .hero .sub', { y: 14, opacity: 0, stagger: .08, duration: .4 }, '-=.3')
      .from('.hero .hero-stat .big', { opacity: 0, scale: .7, duration: .5, ease: 'back.out(2)' }, '-=.3')
      .from('.stage', { y: 18, opacity: 0, stagger: .07, duration: .4 }, '-=.3')
      .from('.funnel, .funnel-wrap table', { y: 14, opacity: 0, duration: .4 }, '-=.2')
      .from('.section', { y: 12, opacity: 0, stagger: .06, duration: .3 }, '-=.2');

    // Floating hero logo + glow pulse
    gsap.to('#hero-logo', { y: -8, duration: 2.4, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    gsap.to('#hero-logo', { filter: 'drop-shadow(0 0 26px #8a2be266)', duration: 2.4, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  }

  // Nav switching
  const sections = document.querySelectorAll('main section');
  const navItems = document.querySelectorAll('.nav-item');
  const railIcons = document.querySelectorAll('.rail-icon');
  function showSection(id) {
    sections.forEach(s => s.hidden = s.id !== id);
    navItems.forEach(n => n.classList.toggle('active', n.dataset.target === id));
    railIcons.forEach(r => r.classList.toggle('active', r.dataset.nav === id));
  }
  navItems.forEach(n => n.addEventListener('click', () => showSection(n.dataset.target)));
  railIcons.forEach(r => r.addEventListener('click', () => showSection(r.dataset.nav)));

  // ---- Settings / inputs ----
  const KEYS = ['apify', 'exa', 'getleads', 'apollo', 'prospeo', 'mv'];
  const KEY_ENV = { apify:'APIFY_TOKEN', exa:'EXA_API_KEY', getleads:'GETLEADS_API_KEY', apollo:'APOLLO_API_KEY', prospeo:'PROSPEO_API_KEY', mv:'MILLIONVERIFIER_API_KEY' };
  const KEY_EL = id => document.getElementById(id);
  const VAL = id => (KEY_EL(id) ? KEY_EL(id).value.trim() : '');
  const loadSettings = () => {
    try {
      const saved = JSON.parse(localStorage.getItem('dai_settings') || '{}');
      KEYS.forEach(k => { const el = KEY_EL('inp-' + k); if (el && saved[k]) el.value = saved[k]; });
      const posts = KEY_EL('inp-posts');
      if (posts && saved.posts) posts.value = saved.posts;
    } catch (e) {}
  };
  const saveSettings = () => {
    const data = {};
    KEYS.forEach(k => { const v = VAL('inp-' + k); if (v) data[k] = v; });
    const posts = VAL('inp-posts');
    if (posts) data.posts = posts;
    try {
      localStorage.setItem('dai_settings', JSON.stringify(data));
      const note = KEY_EL('save-note');
      if (note) { note.textContent = 'Saved to this browser ✓'; setTimeout(() => note.textContent = '', 2500); }
    } catch (e) {
      alert('Could not save (storage full or blocked): ' + e.message);
    }
  };
  const exportEnv = () => {
    const lines = ['# apify-engagers .env — exported from command center'];
    let any = false;
    KEYS.forEach(k => { const v = VAL('inp-' + k); if (v) { lines.push(KEY_ENV[k] + '=' + v); any = true; } });
    const posts = VAL('inp-posts');
    if (posts) {
      lines.push('', '# tracked post URLs (one per line):');
      posts.split(/\\r?\\n/).forEach(p => { if (p.trim()) lines.push('# ' + p.trim()); });
    }
    if (!any) lines.push('# No keys entered yet.');
    const blob = new Blob([lines.join('\\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '.env';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const bindToggle = (key, inputId) => {
    const btn = KEY_EL('toggle-' + key);
    const input = KEY_EL(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
    });
  };
  ['apify', 'exa'].forEach(k => bindToggle(k, 'inp-' + k));
  const saveBtn = KEY_EL('save-settings');
  if (saveBtn) saveBtn.addEventListener('click', saveSettings);
  const exportBtn = KEY_EL('export-env');
  if (exportBtn) exportBtn.addEventListener('click', exportEnv);
  loadSettings();

  // Export CSV client-side
  window.exportCsv = function(prefix, rows) {
    if (!rows || !rows.length) return;
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => {
      const v = String(r[c] ?? '').replace(/"/g, '""');
      return /[",\\n]/.test(v) ? '"' + v + '"' : v;
    }).join(','))].join('\\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = prefix + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
})();
</script>
</body>
</html>`;
}

function renderLanding(d) {
  const good = d.counts.good;
  const verified = d.counts.verified;
  const engagers = d.counts.engagers;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stephen, You Did It! — DAI Command Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#0b0714; --bg2:#120b22; --surface:#151026; --surface2:#1e1734; --border:#2e2547;
  --text:#e9e2f5; --text2:#b7a9d4; --muted:#7d6ea0; --accent:#a78bfa; --accent2:#c4b5fd;
  --neon:#8a2be2; --green:#4ade80; --amber:#fbbf24; --red:#f87171; --logo-bg:#1a0033;
  --font-display:'Orbitron',monospace; --font-body:'Space Grotesk',system-ui,sans-serif;
}
* { box-sizing:border-box; margin:0; padding:0; }
html, body { height:100%; }
body {
  font-family:var(--font-body); color:var(--text);
  background:
    radial-gradient(1000px 600px at 75% -10%, #3b1a6e55 0%, transparent 60%),
    radial-gradient(800px 500px at 10% 110%, #3b1a6e44 0%, transparent 55%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
  background-attachment:fixed; overflow-x:hidden; min-height:100vh;
  display:flex; flex-direction:column; position:relative;
}
.stars { position:fixed; inset:0; z-index:0; pointer-events:none; }
.star { position:absolute; border-radius:50%; background:#fff; animation:twinkle var(--dur,4s) ease-in-out infinite; opacity:0; }
@keyframes twinkle { 0%,100% { opacity:0; transform:scale(.6); } 50% { opacity:var(--op,.8); transform:scale(1.1); } }
.shoot {
  position:absolute; width:120px; height:2px; border-radius:2px;
  background:linear-gradient(90deg,#c4b5fd,transparent); opacity:0;
  transform:rotate(-30deg); animation:shoot 6s ease-in infinite; animation-delay:var(--d,0s);
}
@keyframes shoot {
  0% { transform:translate(0,0) rotate(-30deg); opacity:0; }
  3% { opacity:1; }
  8% { transform:translate(-260px,150px) rotate(-30deg); opacity:0; }
  100% { transform:translate(-260px,150px) rotate(-30deg); opacity:0; }
}
main { position:relative; z-index:1; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:2rem 1.5rem; text-align:center; }
.hero-logo { margin-bottom:2rem; position:relative; }
.dai-logo-svg { width:clamp(200px,30vw,320px); height:auto; filter:drop-shadow(0 0 24px #8a2be244); }
.hero-logo::after {
  content:""; position:absolute; left:50%; bottom:-18px; transform:translateX(-50%);
  width:60%; height:30px; background:radial-gradient(ellipse at center,#8a2be255,transparent 70%); filter:blur(6px);
}
.headline { margin-bottom:1.2rem; }
.line { display:block; font-family:var(--font-display); font-weight:900; letter-spacing:.04em; line-height:1.15; text-transform:uppercase; }
.line-1 { font-size:clamp(1.6rem,5vw,3.2rem); color:var(--text); }
.line-2 {
  font-size:clamp(2.4rem,8vw,5rem);
  background:linear-gradient(135deg,var(--accent2),var(--accent) 40%,var(--neon));
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 0 18px #8a2be255);
}
.sub { color:var(--text2); font-size:clamp(.9rem,2vw,1.1rem); max-width:520px; margin:0 auto 1.5rem; line-height:1.5; }
.stats { display:flex; gap:2.5rem; flex-wrap:wrap; justify-content:center; margin:1.5rem 0 2.2rem; }
.stat { text-align:center; }
.stat .num { font-family:var(--font-display); font-size:clamp(1.6rem,4vw,2.4rem); font-weight:900; color:var(--accent2); text-shadow:0 0 16px #8a2be266; }
.stat .lbl { color:var(--muted); font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; margin-top:.2rem; }
.cta {
  display:inline-flex; align-items:center; gap:.6rem; padding:.95rem 2.2rem; border-radius:999px;
  background:linear-gradient(135deg,var(--neon),var(--accent)); color:#0b0714;
  font-family:var(--font-body); font-weight:700; font-size:1rem; text-decoration:none;
  box-shadow:0 0 18px #8a2be266,0 0 40px #8a2be233; transition:all .2s;
}
.cta:hover { box-shadow:0 0 26px #8a2be2aa,0 0 60px #8a2be255; transform:translateY(-2px); }
.cta:active { transform:scale(.97); }
.cta:focus-visible { outline:2px dashed var(--accent2); outline-offset:3px; }
footer { position:relative; z-index:1; text-align:center; padding:1.5rem; color:var(--muted); font-size:.75rem; letter-spacing:.08em; }
footer a { color:var(--accent); }
@media (prefers-reduced-motion: reduce) {
  .star,.shoot { display:none; }
  * { animation-duration:.01s !important; transition-duration:.01s !important; }
}
</style>
</head>
<body>
<div class="stars" id="stars"></div>
<main>
  <div class="hero-logo" id="heroLogo">
    <svg class="dai-logo-svg" viewBox="0 0 220 130" role="img" aria-label="DAI Dream AI Labs">
      <defs>
        <linearGradient id="daiBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2e0854"/><stop offset="1" stop-color="#0d001a"/>
        </linearGradient>
        <filter id="neonGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect x="2" y="2" width="216" height="126" rx="20" fill="url(#daiBg)" stroke="#8a2be2" stroke-opacity="0.55"/>
      <text x="110" y="52" text-anchor="middle" font-family="Orbitron, sans-serif" font-weight="900" font-size="42" fill="#ffffff">
        <tspan>D</tspan><tspan filter="url(#neonGlow)" fill="#8a2be2">AI</tspan>
      </text>
      <text x="110" y="80" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="600" font-size="12" letter-spacing="3" fill="#e9e2f5">DREAM AI LABS</text>
      <text x="110" y="98" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="300" font-size="9" letter-spacing="4" fill="#b7a9d4">AI CONSULTING GROUP</text>
    </svg>
  </div>

  <div class="headline">
    <span class="line line-1" id="line1">Stephen,</span>
    <span class="line line-2" id="line2">You did it!</span>
  </div>

  <p class="sub" id="sub">The LinkedIn engager enrichment pipeline is built, verified, and ready for orbit. Every stage wired, every lead validated, every system green.</p>

  <div class="stats" id="stats">
    <div class="stat"><div class="num" data-count="6">0</div><div class="lbl">pipeline stages</div></div>
    <div class="stat"><div class="num" data-count="19">0</div><div class="lbl">logic tests passed</div></div>
    <div class="stat"><div class="num" data-count="${engagers}">0</div><div class="lbl">engagers</div></div>
    <div class="stat"><div class="num" data-count="${verified}">0</div><div class="lbl">verified</div></div>
    <div class="stat"><div class="num" data-count="${good}">0</div><div class="lbl">validated leads</div></div>
  </div>

  <a class="cta" id="cta" href="index.html">Enter Command Center ▸</a>
</main>

<footer>Built with <a href="https://commandcode.ai" target="_blank" rel="noopener">Command Code</a> · DAI — Dream AI Labs · <a href="index.html">Command Center</a></footer>

<script src="data.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script>
(function() {
  const stars = document.getElementById('stars');
  const starCount = 90;
  for (let i = 0; i < starCount; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.width = s.style.height = (Math.random() * 2.2 + .6).toFixed(2) + 'px';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.setProperty('--dur', (Math.random() * 4 + 2).toFixed(1) + 's');
    s.style.setProperty('--op', (Math.random() * .7 + .3).toFixed(2));
    s.style.animationDelay = (Math.random() * 5).toFixed(1) + 's';
    stars.appendChild(s);
  }
  for (let i = 0; i < 3; i++) {
    const sh = document.createElement('div');
    sh.className = 'shoot';
    sh.style.top = (Math.random() * 40 + 5) + '%';
    sh.style.right = (Math.random() * 30 + 10) + '%';
    sh.style.setProperty('--d', (Math.random() * 6 + 2).toFixed(1) + 's');
    stars.appendChild(sh);
  }
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || !window.gsap) {
    document.querySelectorAll('.num[data-count]').forEach(el => { el.textContent = el.dataset.count; });
    return;
  }
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  tl.from('#heroLogo', { y: -40, opacity: 0, scale: .85, duration: 1, ease: 'back.out(1.6)' })
    .from('.dai-mark tspan', { opacity: 0, y: 12, stagger: .15, duration: .5 }, '-=.4')
    .from('#line1', { y: 30, opacity: 0, duration: .6 }, '-=.5')
    .from('#line2', { y: 40, opacity: 0, scale: .9, duration: .7, ease: 'back.out(1.4)' }, '-=.4')
    .from('#sub', { y: 20, opacity: 0, duration: .5 }, '-=.4')
    .from('.stat', { y: 24, opacity: 0, stagger: .12, duration: .5 }, '-=.3')
    .from('#cta', { y: 16, opacity: 0, scale: .95, duration: .5 }, '-=.3');
  tl.call(countUp, [], '-=.2');
  gsap.to('.hero-logo', { y: -10, duration: 2.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  gsap.to('.hero-logo', { filter: 'drop-shadow(0 0 34px #8a2be266)', duration: 2.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  function countUp() {
    document.querySelectorAll('.num[data-count]').forEach(el => {
      const target = parseInt(el.dataset.count, 10) || 0;
      const obj = { v: 0 };
      gsap.to(obj, { v: target, duration: 1.2, ease: 'power2.out', onUpdate: () => { el.textContent = Math.round(obj.v); } });
    });
  }
})();
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
