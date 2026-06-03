/**
 * Extract a user-facing rate-limit message from an axios error, or null
 * if the error wasn't a 429. Reads the server's `Retry-After` header so
 * we can tell the user when to try again.
 */
import { AxiosError } from "axios";

export interface RateLimitInfo {
  retryAfterSeconds: number;
  message: string;
}

export function parseRateLimit(err: unknown): RateLimitInfo | null {
  const e = err as AxiosError<{ detail?: string }>;
  if (!e?.response || e.response.status !== 429) return null;
  const headerVal = e.response.headers?.["retry-after"];
  const seconds = Number(headerVal) || 5;
  const detail = e.response.data?.detail;
  return {
    retryAfterSeconds: seconds,
    message: detail || `Слишком быстро. Попробуйте через ${seconds} с.`,
  };
}
