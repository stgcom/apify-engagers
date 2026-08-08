import type { Engager } from "./types.js";

/** Extract a normalized LinkedIn profile URL from a raw string, or null. */
export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Accept plain URNs like urn:li:person:ACoAA... by wrapping into a pseudo-URL
  // so downstream dedupe/keying still works.
  if (/^urn:li:person:/i.test(trimmed)) {
    return trimmed;
  }

  // Parse a URL; tolerate LinkedIn URL-encoded or trailing-garbage variants.
  try {
    const url = new URL(trimmed);
    if (!/linkedin\.com$/i.test(url.hostname) && !url.hostname.endsWith(".linkedin.com")) {
      return null; // not a LinkedIn URL
    }
    const path = url.pathname.replace(/\/+$/, ""); // strip trailing slashes
    return `https://www.linkedin.com${path}`;
  } catch {
    return null;
  }
}

/** True when the profile reference is an obfuscated ACoAA... URN, not a public /in/ slug. */
export function isObfuscatedUrn(url: string | null | undefined): boolean {
  if (!url) return false;
  return /urn:li:person:|ACoAA/i.test(url);
}

/** Pull a stable raw URL field from an actor row, defensively. */
function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickStringNested(row: Record<string, unknown>, path: string[]): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = row;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : null;
}

/**
 * Map one raw actor row into a normalized Engager. Field names differ between
 * the reactions and comments actors, so we probe several common keys.
 */
export function extractEngager(row: Record<string, unknown>, source: "reactor" | "commenter"): Engager {
  const profileUrlRaw =
    pickString(row, [
      "profileUrl",
      "profile_url",
      "profileURL",
      "authorUrl",
      "author_url",
      "authorProfileUrl",
      "profileLink",
      "linkedinUrl",
      "linkedin_url",
      "url",
      "memberUrl",
    ]) ??
    pickStringNested(row, ["author", "url"]) ??
    pickStringNested(row, ["author", "profileUrl"]) ??
    pickStringNested(row, ["author", "profile_url"]) ??
    pickStringNested(row, ["profile", "url"]);

  const name =
    pickString(row, [
      "name",
      "fullName",
      "full_name",
      "profileName",
      "profile_name",
      "authorName",
      "author_name",
      "displayName",
      "memberName",
    ]) ??
    pickStringNested(row, ["author", "name"]) ??
    pickStringNested(row, ["profile", "name"]) ??
    pickStringNested(row, ["user", "name"]);

  const company =
    pickString(row, [
      "company",
      "companyName",
      "company_name",
      "currentCompany",
      "companyTitle",
      "companyHeadline",
    ]) ??
    pickStringNested(row, ["author", "company"]) ??
    pickStringNested(row, ["profile", "company"]) ??
    pickStringNested(row, ["currentCompany", "name"]);

  const profileUrl = normalizeLinkedInUrl(profileUrlRaw);

  return {
    profileUrl,
    resolvedSlug: null,
    name,
    company,
    source,
    obfuscatedUrn: isObfuscatedUrn(profileUrl),
    raw: row,
  };
}

/** Build the dedupe key for an engager (profile URL, else name as last resort). */
export function dedupeKey(e: Engager): string | null {
  if (e.profileUrl) return e.profileUrl.toLowerCase();
  if (e.name) return `name:${e.name.toLowerCase().trim()}`;
  return null;
}

/**
 * Flatten one profile-reactions actor row (which carries a `reactions[]`
 * array) into Engagers. Each reaction's `author` becomes an engager; the
 * post's `post_stats` engagement total is surfaced as `engagement`.
 *
 * Actor: apimaestro/linkedin-profile-reactions (FNhKFjeL8hWQtMeZI)
 * Output row shape:
 *   { reactions: [ { author: { profile_url, firstName, lastName, headline },
 *                    post_stats: { totalReactionCount, comments, reposts, ... } } ] }
 */
export function extractProfileReactionRow(row: Record<string, unknown>, source: "profile_reactor" = "profile_reactor"): Engager[] {
  const reactions = row.reactions;
  if (!Array.isArray(reactions)) return [];

  const engagers: Engager[] = [];
  for (const reaction of reactions) {
    if (reaction == null || typeof reaction !== "object") continue;
    const r = reaction as Record<string, unknown>;

    const profileUrlRaw =
      pickStringNested(r, ["author", "profile_url"]) ??
      pickStringNested(r, ["author", "url"]) ??
      pickStringNested(r, ["author", "profileUrl"]);
    const firstName = pickStringNested(r, ["author", "firstName"]);
    const lastName = pickStringNested(r, ["author", "lastName"]);
    const name = [firstName, lastName].filter(Boolean).join(" ") || null;
    const headline = pickStringNested(r, ["author", "headline"]);

    // Engagement: sum totalReactionCount + comments + reposts if present.
    let engagement: number | undefined;
    const stats = (r.post_stats ?? null) as Record<string, unknown> | null;
    if (stats && typeof stats === "object") {
      const nums = ["totalReactionCount", "comments", "reposts"].map((k) =>
        typeof stats[k] === "number" ? (stats[k] as number) : 0
      );
      engagement = nums.reduce((a, b) => a + b, 0) || undefined;
    }

    const profileUrl = normalizeLinkedInUrl(profileUrlRaw);
    engagers.push({
      profileUrl,
      resolvedSlug: null,
      name,
      company: headline,
      source,
      obfuscatedUrn: isObfuscatedUrn(profileUrl),
      engagement,
      raw: r,
    });
  }
  return engagers;
}
