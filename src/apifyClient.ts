import { config } from "./config.js";

export const REACTIONS_ACTOR_ID = "J9UfswnR3Kae4O6vm"; // apimaestro~linkedin-post-reactions
export const COMMENTS_ACTOR_ID =
  "2XnpwxfhSW1fAWElp"; // apimaestro~linkedin-post-comments-replies-engagements-scraper-no-cookies
export const PROFILE_REACTIONS_ACTOR_ID =
  "FNhKFjeL8hWQtMeZI"; // apimaestro~linkedin-profile-reactions

// Recommended run options (https://docs.apify.com/integrations/api, run-sync endpoint).
export interface ActorRunOptions {
  /** Memory in MB (actor-specific; defaults to actor default). */
  memory?: number;
  /** Build tag to run, e.g. "latest". */
  build?: string;
  /** Max seconds the run may take; the API aborts past this. */
  timeout?: number;
  /** Max seconds to wait for the run to finish (run-sync). */
  waitForFinish?: number;
}

export interface ApifyRunOptions {
  /** Run options passed through to the actor run. */
  actor?: ActorRunOptions;
  /** Max retries for rate-limit (429) and transient (5xx) errors. */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff. */
  retryBaseMs?: number;
  /** Hard timeout (ms) for the whole request, incl. retries. */
  requestTimeoutMs?: number;
}

const DEFAULT_OPTS: Required<Pick<ApifyRunOptions, "maxRetries" | "retryBaseMs" | "requestTimeoutMs">> = {
  maxRetries: 3,
  retryBaseMs: 1000,
  requestTimeoutMs: 5 * 60 * 1000,
};

/** Sleep helper for backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an Apify actor synchronously and return its dataset items.
 *
 * Implements the Apify API best practices from
 * https://docs.apify.com/integrations/api:
 *  - Auth ONLY via `Authorization: Bearer` header (the docs recommend the
 *    header over the `token` query param; the URL token is not used).
 *  - Exponential backoff with jitter for 429 (rate limit) and 5xx retries.
 *  - Hard timeout via AbortController so a hung run cannot stall the pipeline.
 *  - Pass-through of run options (memory, build, timeout, waitForFinish).
 */
export async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  options: ApifyRunOptions = {}
): Promise<Record<string, unknown>[]> {
  const token = config.apifyToken;
  const { maxRetries, retryBaseMs, requestTimeoutMs } = { ...DEFAULT_OPTS, ...options };

  const qs = new URLSearchParams();
  if (options.actor?.memory) qs.set("memory", String(options.actor.memory));
  if (options.actor?.build) qs.set("build", options.actor.build);
  if (options.actor?.timeout) qs.set("timeout", String(options.actor.timeout));
  if (options.actor?.waitForFinish) qs.set("waitForFinish", String(options.actor.waitForFinish));
  const q = qs.toString();

  const url = `https://api.apify.com/v2/actors/${actorId}/run-sync-get-dataset-items${q ? `?${q}` : ""}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const body = await res.text().catch(() => "");
        lastError = new Error(`Apify actor ${actorId} HTTP ${res.status}: ${body.slice(0, 300)}`);
        if (attempt < maxRetries) {
          const jitter = Math.random() * 300;
          const delay = retryBaseMs * 2 ** attempt + jitter;
          console.warn(`  Apify HTTP ${res.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Apify actor ${actorId} failed with HTTP ${res.status}: ${body.slice(0, 500)}`);
      }

      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        throw new Error(
          `Apify actor ${actorId} returned unexpected shape (expected array): ${JSON.stringify(data).slice(0, 500)}`
        );
      }
      return data as Record<string, unknown>[];
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Apify actor ${actorId} request timed out after ${requestTimeoutMs}ms`);
      }
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = retryBaseMs * 2 ** attempt + Math.random() * 300;
        console.warn(`  Apify error (attempt ${attempt + 1}/${maxRetries}): ${(err as Error).message} — retrying in ${Math.round(delay)}ms`);
        await sleep(delay);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable (loop always returns or throws), but TS needs a return path.
  throw lastError ?? new Error(`Apify actor ${actorId} failed after retries`);
}
