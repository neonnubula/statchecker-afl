/**
 * SgmGameLog
 *
 * Game-by-game log for SGM (Same Game Multi) searches.  Each game is shown as
 * a header row (date, round, opponent, flags) followed by one sub-row per
 * player in the multi.  Each player row highlights their targeted stat
 * green/red relative to their individual threshold.
 *
 * Collapsed by default — data is fetched lazily on first expand.
 */

'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ChevronDown, ChevronUp, Loader2, AlertCircle, TableIcon, Check, X } from 'lucide-react';
import { getSgmGameLog } from '@/lib/api/client';
import type { SgmGameLogGame, SgmGameLogPlayerEntry, StatType } from '@/lib/api/types';
import type { SgmRequest } from '@/lib/api/types';
import { FlagBadge, StatCell, STAT_LABELS } from '@/components/PlayerGameLog';
import {
  formatGameDate,
  getGameStatValue,
  computeGameFlags,
  compareStatToThreshold,
  getActiveGameLogStats,
  LAST_SEASON_YEAR,
  LAST_30_DAYS,
} from '@/lib/search-utils.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SgmGameLogSelection = {
  playerName: string;
  playerId?: number;
  stat: string;
  threshold: number;
  strictOver?: boolean;
};

export type SgmGameLogProps = {
  receipt?: string;
  receiptExpiresAt?: number;
  selections: SgmGameLogSelection[];
  seasonFrom?: number;
  seasonTo?: number;
  dateFrom?: string;
  dateTo?: string;
  location?: string;
  opponent?: string;
  venue?: string;
  gameType?: string;
  todayDate: string;
  withoutPlayerIds?: number[];
};

// ─── Stat columns to show ───────────────────────────────────────────────────

const CORE_STATS = ['disposals', 'goals', 'marks', 'tackles'];
const EXTENDED_STATS = ['kicks', 'handballs', 'clearances', 'hit_outs'];

function getVisibleStats(games: SgmGameLogGame[]): string[] {
  const stats = [...CORE_STATS];
  // Add extended stats if any player in any game has non-null data
  for (const ext of EXTENDED_STATS) {
    const hasData = games.some((game) =>
      game.players.some((p) => (p as unknown as Record<string, unknown>)[ext] != null)
    );
    if (hasData) stats.push(ext);
  }
  return stats;
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function SkeletonBlock() {
  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="h-4 bg-gray-200 rounded animate-pulse w-2/3 mb-2" />
      <div className="h-3 bg-gray-100 rounded animate-pulse w-1/2 mb-1" />
      <div className="h-3 bg-gray-100 rounded animate-pulse w-1/2" />
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function SgmGameLog({
  receipt,
  receiptExpiresAt,
  selections,
  seasonFrom,
  seasonTo,
  dateFrom,
  dateTo,
  location,
  opponent,
  venue,
  gameType,
  todayDate,
  withoutPlayerIds,
}: SgmGameLogProps) {
  const [games, setGames] = useState<SgmGameLogGame[]>([]);
  const [total, setTotal] = useState(0);
  const [allHitCount, setAllHitCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const hasFetched = useRef(false);
  const lastFetchKey = useRef<string>('');

  // Build the request payload from props
  const buildPayload = useCallback((): SgmRequest | null => {
    const validSelections = selections.filter((s) => s.playerName.trim() && s.stat);
    if (validSelections.length < 2) return null;

    return {
      selections: validSelections.map((s) => ({
        player_id: s.playerId,
        player_name: s.playerId ? undefined : s.playerName.trim(),
        stat: s.stat as StatType,
        threshold: s.threshold,
        strict_over: s.strictOver ?? false,
      })),
      bet_mode: 'over_under' as const,
      season_from: seasonFrom,
      season_to: seasonTo,
      date_from: dateFrom,
      date_to: dateTo,
      location: location as SgmRequest['location'],
      opponent,
      venue,
      game_type: gameType as SgmRequest['game_type'],
    };
  }, [selections, seasonFrom, seasonTo, dateFrom, dateTo, location, opponent, venue, gameType, withoutPlayerIds]);

  // Fetch on expand (lazy load)
  useEffect(() => {
    if (!expanded) return;

    const payload = buildPayload();
    if (!payload) return;

    const key = JSON.stringify({ payload, receipt, receiptExpiresAt });
    if (key === lastFetchKey.current) return;
    lastFetchKey.current = key;

    let cancelled = false;
    let settled = false;
    setLoading(true);
    setError(null);
    setGames([]);

    getSgmGameLog(payload, { purpose: 'context', receipt, receiptExpiresAt })
      .then((res) => {
        settled = true;
        if (!cancelled) {
          setGames(res.games);
          setTotal(res.total);
          setAllHitCount(res.all_hit_count);
          setLoading(false);
          hasFetched.current = true;
        }
      })
      .catch((err: unknown) => {
        settled = true;
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load SGM game log');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (!settled && lastFetchKey.current === key) lastFetchKey.current = '';
    };
  }, [expanded, buildPayload, receipt, receiptExpiresAt]);

  // Reset fetch state when selections change significantly
  useEffect(() => {
    const payload = buildPayload();
    const key = payload ? JSON.stringify({ payload, receipt, receiptExpiresAt }) : '';
    if (key !== lastFetchKey.current) {
      hasFetched.current = false;
    }
  }, [buildPayload, receipt, receiptExpiresAt]);

  // Don't render if fewer than 2 valid selections
  const validCount = selections.filter((s) => s.playerName.trim() && s.stat).length;
  if (validCount < 2) return null;

  const statCols = games.length > 0 ? getVisibleStats(games) : [...CORE_STATS];
  const allHitPct = total > 0 ? ((allHitCount / total) * 100).toFixed(0) : '0';

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header / toggle — sticky at top of scroll container */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors sticky top-0 z-20 bg-white border-b border-gray-100"
      >
        <div className="flex items-center gap-2.5">
          <TableIcon className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-semibold text-gray-800">SGM Game Log</span>
          {!loading && total > 0 && (
            <span className="text-xs text-gray-500 font-normal">
              {total} {total === 1 ? 'game' : 'games'} · {allHitCount} all hit ({allHitPct}%)
            </span>
          )}
          {loading && <Loader2 className="w-3.5 h-3.5 text-gray-400 animate-spin" />}
        </div>
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="max-h-[70vh] overflow-y-auto overflow-x-auto">
          {error ? (
            <div className="flex items-center gap-2 px-5 py-4 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          ) : loading ? (
            <div>
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonBlock key={i} />
              ))}
            </div>
          ) : games.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-gray-400">
              No shared games found for these players in this range.
            </div>
          ) : (
            <div>
              <table className="w-full text-xs border-collapse min-w-[700px]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2.5 text-left font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap bg-gray-50">
                      Player
                    </th>
                    <th className="px-2 py-2.5 text-left font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap bg-gray-50">
                      Target
                    </th>
                    <th className="px-2 py-2.5 text-center font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap bg-gray-50">
                      Hit?
                    </th>
                    {statCols.map((stat) => (
                      <th
                        key={stat}
                        className="px-2 py-2.5 text-center font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap bg-gray-50"
                      >
                        {STAT_LABELS[stat] ?? stat}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {games.map((game, gameIdx) => {
                    const flags = computeGameFlags(game, {
                      todayDate,
                      lastSeasonYear: LAST_SEASON_YEAR,
                      last30Days: LAST_30_DAYS,
                    });

                    return (
                      <React.Fragment key={`${game.game_date}-${gameIdx}`}>
                        {/* Game header row */}
                        <tr className={`border-t-2 ${game.all_hit ? 'border-emerald-200' : 'border-gray-200'} ${gameIdx === 0 ? 'border-t-0' : ''}`}>
                          <td
                            colSpan={3 + statCols.length}
                            className={`px-3 py-2.5 ${game.all_hit ? 'bg-emerald-50/50' : 'bg-gray-50/80'}`}
                          >
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-semibold text-gray-800 text-xs">
                                {formatGameDate(game.game_date)}
                              </span>
                              {game.round_number != null && (
                                <span className="text-gray-500 text-xs">R{game.round_number}</span>
                              )}
                              <span className="text-gray-700 text-xs">
                                vs {game.opponent_name}
                              </span>

                              {/* Flags */}
                              <div className="flex gap-1">
                                {flags.isHome && <FlagBadge label="Home" color="green" />}
                                {flags.isFinals && <FlagBadge label="Finals" color="purple" />}
                                {flags.isLastSeason && <FlagBadge label="'25" color="blue" />}
                                {flags.isLast30Days && <FlagBadge label="30d" color="amber" />}
                              </div>

                              {/* All-hit badge */}
                              <span className="ml-auto flex items-center gap-1">
                                {game.all_hit ? (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-700 border border-emerald-200">
                                    <Check className="w-3 h-3" /> All Hit
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-red-50 text-red-500 border border-red-200">
                                    <X className="w-3 h-3" /> Miss
                                  </span>
                                )}
                              </span>
                            </div>
                          </td>
                        </tr>

                        {/* Player sub-rows — group by player name to consolidate multi-leg entries */}
                        {(() => {
                          const grouped = game.players.reduce<Record<string, SgmGameLogPlayerEntry[]>>((acc, player) => {
                            const key = player.player_name;
                            if (!acc[key]) acc[key] = [];
                            acc[key].push(player);
                            return acc;
                          }, {});
                          return Object.values(grouped).map((group, groupIdx) => {
                            const lead = group[0];
                            const activeStats = new Set(group.map((leg) => leg.stat));
                            return (
                              <tr
                                key={`${game.game_date}-${groupIdx}`}
                                className="border-b border-gray-100 hover:bg-gray-50/60 transition-colors"
                              >
                                {/* Player name */}
                                <td className="px-3 py-2 text-gray-800 whitespace-nowrap font-medium align-top">
                                  {lead.player_name}
                                </td>

                                {/* Target(s) — stacked when multiple legs */}
                                <td className="px-2 py-2 text-gray-500 whitespace-nowrap text-[10px] align-top">
                                  {group.map((leg, i) => (
                                    <div key={i}>
                                      {leg.threshold}+ {STAT_LABELS[leg.stat] ?? leg.stat}
                                    </div>
                                  ))}
                                </td>

                                {/* Hit indicator(s) — one per leg */}
                                <td className="px-2 py-2 text-center align-top">
                                  <div className="flex flex-col items-center gap-0.5">
                                    {group.map((leg, i) => (
                                      <span key={i}>
                                        {leg.hit ? (
                                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100">
                                            <Check className="w-3 h-3 text-emerald-600" />
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-50">
                                            <X className="w-3 h-3 text-red-400" />
                                          </span>
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                </td>

                                {/* Stat columns — use lead entry for values, highlight all active stats */}
                                {statCols.map((stat) => {
                                  const value = (lead as unknown as Record<string, unknown>)[stat];
                                  const numValue = typeof value === 'number' ? value : null;
                                  const isActive = activeStats.has(stat);
                                  const matchingLeg = group.find((leg) => leg.stat === stat);
                                  const result = isActive && matchingLeg
                                    ? compareStatToThreshold(numValue, matchingLeg.threshold)
                                    : null;
                                  return (
                                    <StatCell
                                      key={stat}
                                      value={numValue}
                                      isActive={isActive}
                                      result={result}
                                    />
                                  );
                                })}
                              </tr>
                            );
                          });
                        })()}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Legend */}
          {!loading && games.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-gray-500">
              <span className="font-semibold text-gray-600 uppercase tracking-wide">Key:</span>
              <span className="flex items-center gap-1">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-100">
                  <Check className="w-2.5 h-2.5 text-emerald-600" />
                </span>
                Hit threshold
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-50">
                  <X className="w-2.5 h-2.5 text-red-400" />
                </span>
                Missed threshold
              </span>
              <span className="flex items-center gap-1"><FlagBadge label="Home" color="green" /> Home game</span>
              <span className="flex items-center gap-1"><FlagBadge label="Finals" color="purple" /> Finals</span>
              <span className="ml-auto italic">Green/red stat cells = each player&apos;s targeted stat vs their threshold</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
