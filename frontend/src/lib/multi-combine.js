/**
 * Pure combination math for the Multi analysis tool.
 *
 * A "multi" combines several INDEPENDENT single-search legs (different players
 * and/or games) using standard parlay math: the combined probability of all
 * legs hitting is the product of each leg's probability. This is intentionally
 * distinct from SGM, which models a joint same-game outcome.
 *
 * Authored as plain JS (like weight-sliders.js) so it can be unit-tested with
 * `node --test`. TypeScript shapes live in `multi-types.ts`.
 *
 * A "leg" is expected to look like:
 *   { weightedOverPct: number, categories: { [key]: { over, under } | null } }
 */

import { computeEffectiveWeight } from './weight-sliders.js';

/** @type {string[]} Display order for combined category cards. */
export const CATEGORY_KEYS = [
  'base',
  'thisSeason',
  'lastSeason',
  'last30Days',
  'opponent',
  'location',
  'venue',
  'daysRest',
];

/**
 * Combined "all legs hit" prediction as a percentage (0–100):
 * 100 * Π(leg.weightedOverPct / 100). Returns 0 for an empty list.
 */
export const combineWeightedPrediction = (legs) => {
  if (!Array.isArray(legs) || legs.length === 0) {
    return 0;
  }
  const product = legs.reduce((acc, leg) => {
    const p = Number.isFinite(leg?.weightedOverPct) ? leg.weightedOverPct : 0;
    return acc * (p / 100);
  }, 1);
  return product * 100;
};

/**
 * Combined hit rate for a single category across all legs:
 * 100 * Π(over / (over + under)).
 *
 * Returns null unless EVERY leg has usable data for that category
 * (present, non-null, and over + under > 0) — a multi is only meaningful
 * for a category when all legs contribute to it.
 */
export const combineCategory = (legs, cat) => {
  if (!Array.isArray(legs) || legs.length === 0) {
    return null;
  }
  let product = 1;
  for (const leg of legs) {
    const counts = leg?.categories?.[cat];
    if (!counts) {
      return null;
    }
    const total = counts.over + counts.under;
    if (!(total > 0)) {
      return null;
    }
    product *= counts.over / total;
  }
  return { pct: product * 100, complete: true };
};

/** Break-even decimal odds for a probability percentage (0–100). */
export const breakEvenOdds = (pct) => (pct > 0 ? (100 / pct).toFixed(2) : '0.00');

// ─── Adjustable weighting ────────────────────────────────────────────────────
// Mirrors the single-search weighting model: each category's effective weight is
// (sample games × multiplier / 100), and a leg's prediction is the sample-weighted
// average of its category hit rates. Because each LegSnapshot already stores the
// per-category {over, under} counts, we can recompute predictions live as the
// user moves the sliders — no API calls.

/** Default multipliers, matching single search (last season starts at 0). */
export const DEFAULT_MULTIPLIERS = {
  base: 100,
  thisSeason: 100,
  lastSeason: 0,
  last30Days: 100,
  opponent: 100,
  location: 100,
  venue: 100,
  daysRest: 100,
};

const categoryTotal = (counts) => (counts ? counts.over + counts.under : 0);

/**
 * Weighted over/win % for a single leg given category multipliers.
 * Returns null when no category has usable data + weight.
 */
export const weightedLegPct = (categories, multipliers) => {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const key of CATEGORY_KEYS) {
    const counts = categories?.[key];
    const total = categoryTotal(counts);
    if (total <= 0) {
      continue;
    }
    const overPct = (counts.over / total) * 100;
    const effWeight = computeEffectiveWeight(total, multipliers?.[key] ?? 0);
    if (effWeight <= 0) {
      continue;
    }
    totalWeight += effWeight;
    weightedSum += effWeight * overPct;
  }
  if (totalWeight <= 0) {
    return null;
  }
  return weightedSum / totalWeight;
};

/**
 * Combined "all legs hit" % using adjustable multipliers:
 * 100 * Π(weightedLegPct / 100). Falls back to a leg's stored weightedOverPct
 * if its categories can't be re-weighted. Returns 0 for an empty list.
 */
export const combineWeightedWithMultipliers = (legs, multipliers) => {
  if (!Array.isArray(legs) || legs.length === 0) {
    return 0;
  }
  let product = 1;
  for (const leg of legs) {
    let pct = weightedLegPct(leg?.categories, multipliers);
    if (pct == null) {
      pct = Number.isFinite(leg?.weightedOverPct) ? leg.weightedOverPct : 0;
    }
    product *= pct / 100;
  }
  return product * 100;
};

/**
 * Aggregate per-category data depth (total games across all legs) and the
 * weight "share" each category contributes to the overall blend — used to label
 * the Multi weight sliders.
 */
export const categoryAggregates = (legs, multipliers) => {
  const games = {};
  const effWeight = {};
  for (const key of CATEGORY_KEYS) {
    games[key] = 0;
    effWeight[key] = 0;
  }
  for (const leg of legs || []) {
    for (const key of CATEGORY_KEYS) {
      const total = categoryTotal(leg?.categories?.[key]);
      if (total <= 0) {
        continue;
      }
      games[key] += total;
      effWeight[key] += computeEffectiveWeight(total, multipliers?.[key] ?? 0);
    }
  }
  const grandTotal = CATEGORY_KEYS.reduce((sum, key) => sum + effWeight[key], 0);
  const share = {};
  for (const key of CATEGORY_KEYS) {
    share[key] = grandTotal > 0 ? (effWeight[key] / grandTotal) * 100 : 0;
  }
  return { games, share };
};
