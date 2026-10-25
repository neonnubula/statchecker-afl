/**
 * Shared TypeScript types for the Multi analysis tool.
 *
 * The combination math lives in `multi-combine.js` (plain JS so it can be
 * unit-tested with `node --test`, matching the repo convention used by
 * `weight-sliders.js` etc.). These types describe the shapes those functions
 * and the UI operate on.
 */

import type { OverUnderParams } from '@/lib/api/types';

export type CategoryKey =
  | 'base'
  | 'opponent'
  | 'location'
  | 'venue'
  | 'lastSeason'
  | 'last30Days'
  | 'thisSeason'
  | 'daysRest';

export type CategoryCounts = { over: number; under: number };

export type LegSnapshot = {
  /** Stable id (crypto.randomUUID()) used for removal. */
  id: string;
  /** Display label, e.g. "Player Name • disposals • 25.5". */
  label: string;
  /** Original single-search params, kept for display / future re-run. */
  params: OverUnderParams;
  betMode: 'over_under' | 'win_loss';
  /** Weight-slider blended over/win % for this leg (0–100). */
  weightedOverPct: number;
  /** Per-category {over, under} snapshot captured at add time. */
  categories: Partial<Record<CategoryKey, CategoryCounts | null>>;
};
