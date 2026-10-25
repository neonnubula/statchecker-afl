export const CURRENT_SEASON = '2026';
export const LAST_SEASON_YEAR = 2025;
export const LAST_30_DAYS = 30;
export const DEFAULT_DISPOSAL_LINE = '23.5';
export const DEFAULT_GOAL_LINE_THRESHOLD = '0.5';

export const BASE_SEASON_OPTIONS = [
  '2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017',
];

export const SEASON_OPTIONS = [
  'any',
  CURRENT_SEASON,
  ...BASE_SEASON_OPTIONS.filter((s) => s !== CURRENT_SEASON),
];

export const isYearInRange = (year, seasonFrom, seasonTo) => {
  const from = seasonFrom === 'any' ? -Infinity : Number(seasonFrom);
  const to = seasonTo === 'any' ? Infinity : Number(seasonTo);
  return year >= from && year <= to;
};

export const isLastSeasonInRange = (seasonFrom, seasonTo) =>
  isYearInRange(LAST_SEASON_YEAR, seasonFrom, seasonTo);

export const isLast30DaysInRange = (seasonFrom, seasonTo) =>
  isYearInRange(Number(CURRENT_SEASON), seasonFrom, seasonTo);

export const normalizeThresholdValue = (value) => Math.round(value * 2) / 2;

export const applyThresholdFormat = (value) => {
  const numValue = parseFloat(value);
  if (!Number.isNaN(numValue) && numValue > 0) {
    const rounded = Math.round(numValue * 2) / 2;
    return rounded.toFixed(1);
  }
  return value;
};

export const formatHalfLineLabel = (value) => {
  if (!value) return '--';
  const num = parseFloat(value);
  if (Number.isNaN(num)) return value;
  return Number.isInteger(num) ? num.toString() : num.toFixed(1);
};

export const buildQuickSearchKey = (option) =>
  `${option.stat}-${option.threshold}-${option.betMode}`;

export const createOverUnderParamsKey = (params) => {
  return JSON.stringify({
    player_name: params.player_name?.trim().toLowerCase() ?? null,
    player_id: params.player_id ?? null,
    stat: params.stat,
    threshold: normalizeThresholdValue(params.threshold),
    strict_over: params.strict_over ?? false,
    season_from: params.season_from ?? null,
    season_to: params.season_to ?? null,
    date_from: params.date_from ?? null,
    date_to: params.date_to ?? null,
    location: params.location ?? null,
    opponent: params.opponent?.trim().toLowerCase() ?? null,
    venue: params.venue?.trim().toLowerCase() ?? null,
    game_type: params.game_type ?? null,
    days_rest_min: params.days_rest_min ?? null,
    days_rest_max: params.days_rest_max ?? null,
  });
};

export const computeOverUnderStats = (over, under) => {
  const total = over + under;
  if (total === 0) {
    return { total: 0, overPct: 0, underPct: 0, overBreakEven: '0.00', underBreakEven: '0.00' };
  }
  const overPct = (over / total) * 100;
  const underPct = (under / total) * 100;
  const overBreakEven = overPct > 0 ? (100 / overPct).toFixed(2) : '0.00';
  const underBreakEven = underPct > 0 ? (100 / underPct).toFixed(2) : '0.00';
  return { total, overPct, underPct, overBreakEven, underBreakEven };
};

export const computeWeightedOverPct = (candidates) => {
  const active = candidates.filter((c) => c.overPct !== null && c.weight > 0);
  if (!active.length) return null;
  const totalWeight = active.reduce((sum, c) => sum + c.weight, 0);
  const weightedOverPct =
    active.reduce((sum, c) => sum + c.weight * (c.overPct ?? 0), 0) / totalWeight;
  const weightedUnderPct = 100 - weightedOverPct;
  return {
    weightedOverPct,
    weightedUnderPct,
    weightedOverBreakEven: weightedOverPct > 0 ? (100 / weightedOverPct).toFixed(2) : '0.00',
    weightedUnderBreakEven: weightedUnderPct > 0 ? (100 / weightedUnderPct).toFixed(2) : '0.00',
    totalWeight,
  };
};

export const computeSgmWeightedOutcomes = (sources, outcomeKeys) => {
  const active = sources.filter((s) => s.outcomes && s.weight > 0);
  if (!active.length) return null;
  const totalWeight = active.reduce((sum, s) => sum + s.weight, 0);
  const outcomes = outcomeKeys.map((key) => {
    const pct =
      active.reduce((sum, s) => sum + (s.outcomes?.[key] ?? 0) * s.weight, 0) / totalWeight;
    return {
      key,
      percent: pct,
      breakEven: pct > 0 ? (100 / pct).toFixed(2) : '0.00',
    };
  });
  return { totalWeight, outcomes };
};

export const SINGLE_SEARCH_DEFAULTS = {
  playerName: '',
  stat: 'disposals',
  threshold: DEFAULT_DISPOSAL_LINE,
  seasonFrom: '2021',
  seasonTo: CURRENT_SEASON,
  opposition: '',
  location: 'any',
  venue: 'any',
  gameType: 'regular',
  betMode: 'over_under',
  nextGamePreloaded: true,
  resultsFormat: 'graphs',
  pickMode: 'top',
  weightsOpen: false,
  moreFiltersOpen: false,
};

export const SGM_SEARCH_DEFAULTS = {
  seasonFrom: '2021',
  seasonTo: CURRENT_SEASON,
  location: 'any',
  opponent: 'any',
  venue: 'any',
  gameType: 'regular',
  resultsFormat: 'graphs',
  nextGamePreloaded: true,
  pickMode: 'top',
  weightsOpen: false,
};

// ─── Game Log Utilities ───────────────────────────────────────────────────────

/**
 * Format a YYYY-MM-DD date string to a short readable label, e.g. "Mar 14, 2026".
 */
export const formatGameDate = (dateStr) => {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  if (!year || !month || !day) return dateStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[parseInt(month, 10) - 1] ?? month;
  return `${monthName} ${parseInt(day, 10)}, ${year}`;
};

/**
 * Get the numeric value of a stat from a GameLogEntry.
 * Returns null when the stat is not present in the game record.
 */
export const getGameStatValue = (game, stat) => {
  if (!game || stat == null) return null;
  const value = game[stat];
  return typeof value === 'number' ? value : null;
};

/**
 * Compute the ISO date string for N days before a reference date.
 * @param {string} referenceDate YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
export const subtractDays = (referenceDate, days) => {
  const d = new Date(referenceDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
};

/**
 * Compute contextual flags for a single GameLogEntry.
 *
 * @param {object} game         A GameLogEntry from the /search/game-log endpoint
 * @param {object} options
 * @param {string} options.todayDate         YYYY-MM-DD reference for "last 30 days"
 * @param {number} options.lastSeasonYear    Year considered "last season" (e.g. 2025)
 * @param {number} options.last30Days        Number of days considered "recent" (default 30)
 * @returns {{ isHome: boolean, isLast30Days: boolean, isLastSeason: boolean, isFinals: boolean }}
 */
export const computeGameFlags = (game, { todayDate, lastSeasonYear, last30Days = 30 } = {}) => {
  if (!game) return { isHome: false, isLast30Days: false, isLastSeason: false, isFinals: false };

  const isHome = game.location === 'Home';

  const isFinals =
    typeof game.game_type === 'string' &&
    game.game_type.toLowerCase().includes('final');

  const isLastSeason =
    lastSeasonYear != null &&
    typeof game.season_year === 'number' &&
    game.season_year === lastSeasonYear;

  let isLast30DaysFlag = false;
  if (todayDate && game.game_date) {
    const cutoff = subtractDays(todayDate, last30Days);
    isLast30DaysFlag = game.game_date >= cutoff && game.game_date <= todayDate;
  }

  return { isHome, isLast30Days: isLast30DaysFlag, isLastSeason, isFinals };
};

/**
 * Determine whether a stat value beats a threshold.
 * Returns 'over' | 'under' | null (null when value is null/undefined).
 * Uses strict inequality (value > threshold).
 */
export const compareStatToThreshold = (value, threshold) => {
  if (value == null || threshold == null) return null;
  return value > threshold ? 'over' : 'under';
};

/**
 * The ordered list of stats shown in the game log table.
 * Core stats always appear; extended stats appear only when any row has a non-null value.
 */
export const GAME_LOG_CORE_STATS = ['disposals', 'goals', 'marks', 'tackles'];
export const GAME_LOG_EXTENDED_STATS = ['kicks', 'handballs', 'clearances', 'hit_outs'];

/**
 * Returns the stat columns to display given the game rows.
 * Always includes core stats; includes extended stats only when present in data.
 */
export const getActiveGameLogStats = (games) => {
  const extended = GAME_LOG_EXTENDED_STATS.filter((stat) =>
    games.some((g) => g[stat] != null)
  );
  return [...GAME_LOG_CORE_STATS, ...extended];
};
