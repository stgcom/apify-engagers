import { config } from "./config.js";
import type { VerificationResult } from "./types.js";

interface MillionVerifierResponse {
  email?: string;
  /** "good" | "risky" | "bad" (also "unknown") */
  quality?: string;
  /** ok, invalid, catch_all, disposable, unknown, ... */
  result?: string;
  subresult?: string;
  error?: string;
  resultcode?: number;
}

/**
 * Stage 5: verify a single email via MillionVerifier real-time API.
 * Returns a normalized VerificationResult; never throws for API-level errors
 * (an errored lookup is surfaced as quality "error").
 */
export async function verifyEmail(email: string): Promise<VerificationResult> {
  const apiKey = config.millionVerifierApiKey;
  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;

  let data: MillionVerifierResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        email,
        quality: "error",
        result: `http_${res.status}`,
        subresult: null,
        error: `HTTP ${res.status}`,
      };
    }
    data = (await res.json()) as MillionVerifierResponse;
  } catch (err) {
    return {
      email,
      quality: "error",
      result: "network_error",
      subresult: null,
      error: (err as Error).message,
    };
  }

  if (data.error) {
    return {
      email,
      quality: "error",
      result: "api_error",
      subresult: null,
      error: data.error,
    };
  }

  const quality = data.quality ?? "unknown";
  const mapped = quality === "good" || quality === "risky" || quality === "bad"
    ? quality
    : quality === "unknown"
      ? "risky"
      : "error";

  return {
    email,
    quality: mapped,
    result: data.result ?? "unknown",
    subresult: data.subresult ?? null,
    error: null,
  };
}
