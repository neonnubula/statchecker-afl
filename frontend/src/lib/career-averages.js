/**
 * Utility functions for player career averages display.
 *
 * Extensibility: when feature/data-increase adds new stat columns (kicks, handballs,
 * clearances, hit_outs), add them to STAT_LABELS — no other change needed.
 * The display table derives its columns from the `averages` keys returned by the API.
 */

/** Human-readable labels for known stat column keys */
export const STAT_LABELS = {
  disposals: "Disposals",
  goals: "Goals",
  marks: "Marks",
  tackles: "Tackles",
  // Coming from feature/data-increase:
  kicks: "Kicks",
  handballs: "Handballs",
  clearances: "Clearances",
  hit_outs: "Hit Outs",
};

/**
 * Return the display label for a stat column key.
 * Falls back to capitalising the key when not found in STAT_LABELS.
 * @param {string} key
 * @returns {string}
 */
export function statLabel(key) {
  return (
    STAT_LABELS[key] ??
    key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ")
  );
}

/**
 * Format an average value for display.
 * Returns "—" for null/undefined, otherwise one decimal place.
 * @param {number | null | undefined} value
 * @returns {string}
 */
export function fmtAvg(value) {
  if (value === null || value === undefined) return "—";
  return value.toFixed(1);
}

/**
 * Extract the ordered list of stat column keys from an API seasons array.
 * Uses the first season that has an averages object.
 * @param {Array<{averages: Record<string, number|null>}>} seasons
 * @returns {string[]}
 */
export function extractStatKeys(seasons) {
  if (!seasons || seasons.length === 0) return [];
  const first = seasons.find((s) => s.averages && typeof s.averages === "object");
  if (!first) return [];
  return Object.keys(first.averages);
}

/**
 * Returns true if all seasons are ordered newest-first by season_year.
 * (Used in tests and defensive assertions.)
 * @param {Array<{season_year: number}>} seasons
 * @returns {boolean}
 */
export function isNewestFirst(seasons) {
  if (seasons.length < 2) return true;
  for (let i = 0; i < seasons.length - 1; i++) {
    if (seasons[i].season_year < seasons[i + 1].season_year) return false;
  }
  return true;
}
