export const STAT_PRIORITY_ORDER = ['disposals', 'goals', 'marks', 'tackles'];

/**
 * Returns the first stat in STAT_PRIORITY_ORDER that hasn't been used for
 * this player yet. For a new player (no prior selections), defaults to
 * 'disposals' so the user doesn't have to hit the stat dropdown for every
 * pick — the common case. Only returns null when all 4 priority stats are
 * already occupied for that player (edge case: 5+ selections of the same
 * player, unusual in practice).
 *
 * @param {number|null} playerId
 * @param {string} playerName
 * @param {Array<{playerId: number|null, playerName: string, stat: string|null}>} existingSelections
 * @param {number} excludeIndex - index of the selection being filled (skip it)
 */
export function getSmartDefaultStat(playerId, playerName, existingSelections, excludeIndex) {
  const normalizedName = playerName.trim().toLowerCase();

  const usedStats = existingSelections
    .filter((s, idx) => {
      if (idx === excludeIndex) return false;
      if (!s.stat) return false;
      if (playerId && s.playerId) return s.playerId === playerId;
      return s.playerName.trim().toLowerCase() === normalizedName;
    })
    .map((s) => s.stat);

  // Player is new (no prior entries for them) → default to disposals.
  if (usedStats.length === 0) return 'disposals';
  // Player already has stats → pick the next unused priority stat.
  return STAT_PRIORITY_ORDER.find((stat) => !usedStats.includes(stat)) ?? null;
}

export function isBlankSelection(s) {
  return !s.playerName.trim() && !s.stat;
}

export function isCompleteSelection(s) {
  return Boolean(s.playerName.trim() && s.stat);
}

export function isPartialSelection(s) {
  return !isBlankSelection(s) && !isCompleteSelection(s);
}

/**
 * Returns true when the last selection just became complete (player + stat both
 * chosen) and a new blank selection should be appended automatically.
 */
export function shouldAutoAdvance(selections, max) {
  if (selections.length >= max) return false;
  const last = selections[selections.length - 1];
  return Boolean(last?.playerName.trim() && last?.stat);
}
