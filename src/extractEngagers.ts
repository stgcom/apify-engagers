import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runActor, REACTIONS_ACTOR_ID, COMMENTS_ACTOR_ID, PROFILE_REACTIONS_ACTOR_ID } from "./apifyClient.js";
import { extractEngager, extractProfileReactionRow, dedupeKey } from "./normalize.js";
import type { Engager } from "./types.js";

// Resolve paths relative to THIS file (repo root), not cwd — so the pipeline
// works identically locally and in CI (GitHub Actions checks out to a fresh
// dir; cwd is the repo root there, but locally cwd may be the parent).
const REPO_ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
export const ENGAGERS_DIR = REPO_ROOT; // engagers-*.json + tracked-*.txt live in repo root
export const TRACKED_POSTS_FILE = join(ENGAGERS_DIR, "tracked-posts.txt");
export const TRACKED_PROFILES_FILE = join(ENGAGERS_DIR, "tracked-profiles.txt");

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path: string, rows: Engager[]): void {
  const cols: Array<keyof Engager> = ["profileUrl", "resolvedSlug", "name", "company", "source", "obfuscatedUrn", "engagement"];
  const header = cols.join(",");
  const lines = rows.map((r) =>
    cols
      .map((c) => csvEscape(r[c]))
      .join(",")
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [header, ...lines].join("\n"), "utf-8");
}

function readTrackedPosts(): string[] {
  let raw: string;
  try {
    raw = readFileSync(TRACKED_POSTS_FILE, "utf-8");
  } catch {
    throw new Error(
      `No ${TRACKED_POSTS_FILE} found. Create it with one LinkedIn post URL per line (the 10-20 tracked accounts' posts).`
    );
  }
  const urls = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (urls.length === 0) {
    throw new Error(`${TRACKED_POSTS_FILE} is empty. Add at least one LinkedIn post URL.`);
  }
  return urls;
}

/** Optional: tracked profile slugs/URLs for the profile-reactions widening pass. */
function readTrackedProfiles(): string[] {
  let raw: string;
  try {
    raw = readFileSync(TRACKED_PROFILES_FILE, "utf-8");
  } catch {
    return []; // no profiles file → skip the widening pass (opt-in)
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * Optional Stage 1b: harvest each tracked profile's recent reactions to
 * discover new posts + engagers. Runs only when tracked-profiles.txt exists
 * and is non-empty (paid actor — opt-in).
 */
async function extractProfileReactions(): Promise<Engager[]> {
  const profiles = readTrackedProfiles();
  if (profiles.length === 0) return [];

  const profileReactors: Engager[] = [];
  for (const profile of profiles) {
    console.log(`Running profile-reactions actor for ${profile} ...`);
    const rows = await runActor(
      PROFILE_REACTIONS_ACTOR_ID,
      { usernames: [profile] },
      { actor: { waitForFinish: 300 } }
    );
    for (const row of rows) {
      profileReactors.push(...extractProfileReactionRow(row));
    }
    console.log(`  profile-reactions: ${profileReactors.length} engagers so far`);
  }
  return profileReactors;
}

/** Stage 1+2: extract engagers from reactions + comments actors, dedupe, flag URNs. */
export async function extractEngagers(): Promise<{ engagers: Engager[]; filePath: string }> {
  const posts = readTrackedPosts();
  const reactors: Engager[] = [];
  const commenters: Engager[] = [];

  for (const postUrl of posts) {
    console.log(`Running reactions actor for ${postUrl} ...`);
    // Run options: waitForFinish caps how long the sync call waits; the
    // client's request timeout + backoff handles rate limits/hangs.
    const reactorRows = await runActor(REACTIONS_ACTOR_ID, { post_urls: [postUrl] }, { actor: { waitForFinish: 300 } });
    console.log(`  reactions: ${reactorRows.length} raw rows`);
    for (const row of reactorRows) reactors.push(extractEngager(row, "reactor"));

    console.log(`Running comments actor for ${postUrl} ...`);
    const commentRows = await runActor(COMMENTS_ACTOR_ID, { postIds: [postUrl] }, { actor: { waitForFinish: 300 } });
    console.log(`  comments: ${commentRows.length} raw rows`);
    for (const row of commentRows) commenters.push(extractEngager(row, "commenter"));
  }

  const rawTotal = reactors.length + commenters.length;
  const profileReactors = await extractProfileReactions();
  const rawTotalAll = rawTotal + profileReactors.length;

  // Dedupe by profile URL (fallback: normalized name) across ALL datasets.
  // Precedence on collision: reactor > commenter > profile_reactor
  // (post-level engagers are a stronger intent signal).
  const precedence = { reactor: 0, commenter: 1, profile_reactor: 2 } as const;
  const byKey = new Map<string, Engager>();
  for (const e of [...profileReactors, ...commenters, ...reactors]) {
    const key = dedupeKey(e);
    if (!key) continue; // row with neither URL nor name is unusable; drop silently
    const existing = byKey.get(key);
    if (!existing || precedence[e.source] < precedence[existing.source]) {
      byKey.set(key, e);
    }
  }
  const engagers = [...byKey.values()];

  // Count by source after dedupe.
  const reactorCount = engagers.filter((e) => e.source === "reactor").length;
  const commenterCount = engagers.filter((e) => e.source === "commenter").length;
  const profileReactorCount = engagers.filter((e) => e.source === "profile_reactor").length;

  console.log(
    `${engagers.length} unique engagers extracted — ${reactorCount} reactors, ${commenterCount} commenters, ${profileReactorCount} profile_reactors (deduped by profile URL from ${rawTotalAll} raw)`
  );

  // Stage 2: flag obfuscated URNs (already flagged in normalize; count + log).
  const obfuscatedCount = engagers.filter((e) => e.obfuscatedUrn).length;
  if (obfuscatedCount > 0) {
    console.log(
      `${obfuscatedCount} reactor rows have obfuscated ACoAA... URNs instead of public /in/ slugs — that's normal for the reactions actor.`
    );
  }

  const stamp = dateStamp();
  const jsonPath = join(ENGAGERS_DIR, `engagers-${stamp}.json`);
  const csvPath = join(ENGAGERS_DIR, `engagers-${stamp}.csv`);
  writeJson(jsonPath, engagers);
  writeCsv(csvPath, engagers);
  console.log(`Wrote ${jsonPath} (${engagers.length} rows) and ${csvPath}`);

  return { engagers, filePath: jsonPath };
}
