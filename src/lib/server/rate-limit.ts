import "server-only";
import { headers } from "next/headers";

/**
 * Fixed-window limiter for public endpoints (share pages, invite previews). In-memory per server
 * instance: it blunts token guessing and scraping from one client. For multi-region deployments,
 * put the same limits in front of the app (e.g. Vercel firewall or an Upstash-backed limiter).
 */
const buckets = new Map<string, { count: number; reset: number }>();

export async function clientKey(scope: string) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  return `${scope}:${ip}`;
}

export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    }
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
