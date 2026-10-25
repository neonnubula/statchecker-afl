export const FREE_PLAN_SUMMARY = "Unlimited use";
export const SEARCH_DEFINITION_COPY = "Research has no daily or weekly allowance. Short request throttles protect your server from automated abuse.";
export const TRUST_GUARANTEES = ["Open source", "Your data", "Your server"] as const;
export type RateLimitMeta = { limit?: number; remaining?: number; resetAt?: number };
