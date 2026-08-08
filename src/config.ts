import "dotenv/config";

export type RequiredKey =
  | "APIFY_TOKEN"
  | "EXA_API_KEY"
  | "GETLEADS_API_KEY"
  | "APOLLO_API_KEY"
  | "PROSPEO_API_KEY"
  | "MILLIONVERIFIER_API_KEY";

const KEYS: Record<RequiredKey, boolean> = {
  APIFY_TOKEN: true,
  EXA_API_KEY: true,
  GETLEADS_API_KEY: true,
  APOLLO_API_KEY: true,
  PROSPEO_API_KEY: true,
  MILLIONVERIFIER_API_KEY: true,
};

export function requireKey(key: RequiredKey): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required env var ${key}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export function hasKey(key: RequiredKey): boolean {
  return Boolean(process.env[key]);
}

export const config = {
  get apifyToken() {
    return requireKey("APIFY_TOKEN");
  },
  get exaApiKey() {
    return requireKey("EXA_API_KEY");
  },
  get getLeadsApiKey() {
    return requireKey("GETLEADS_API_KEY");
  },
  get apolloApiKey() {
    return requireKey("APOLLO_API_KEY");
  },
  get prospeoApiKey() {
    return requireKey("PROSPEO_API_KEY");
  },
  get millionVerifierApiKey() {
    return requireKey("MILLIONVERIFIER_API_KEY");
  },
};

export { KEYS };
