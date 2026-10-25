/**
 * In-memory request throttles for a single server process.
 *
 * Good enough for personal or small deployments. If you run several server
 * instances, replace this with a shared store (Redis, Postgres, etc.).
 */
export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  reason?: "burst_1m" | "burst_10m";
};

const WINDOW_MS = 60_000;
const SEARCH_LIMIT = Number(process.env.SEARCH_RATE_LIMIT_PER_MINUTE || 60);
const DETAIL_LIMIT = Number(process.env.DETAIL_RATE_LIMIT_PER_MINUTE || 120);
const buckets = new Map<string, { count: number; resetAt: number }>();

function consume(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const allowed = bucket.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
    ...(allowed ? {} : { reason: "burst_1m" as const }),
  };
}

export const consumeRateLimit = async (input: { userId: string; plan: unknown; bucket: "single" | "sgm" }) =>
  consume(`search:${input.bucket}:${input.userId}`, SEARCH_LIMIT);

export const consumeDetailRateLimit = async (input: { userId: string }) =>
  consume(`detail:${input.userId}`, DETAIL_LIMIT);

export const getPlanDisplayName = (_plan: unknown): string => "Free";
