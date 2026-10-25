/**
 * PlayerGameLog
 *
 * Game-by-game stat table shown after a player search.  Each row represents one
 * game in the selected season/date range and shows:
 *   - Date, round, opponent, venue
 *   - All available stats (core + extended when data is present)
 *   - Contextual flags: Home · Finals · Last Season · Last 30 Days
 *   - Over/Under colouring relative to the searched threshold
 *
 * Always shows "all games" — no home/away split applied here.
 * Extended stats (kicks, handballs, clearances, hit_outs) are included
 * automatically once any row contains a non-null value.
 */

'use client';

import React, { useEffect, useState, useRef } from 'react';
import { ChevronDown, ChevronUp, Loader2, AlertCircle, TableIcon } from 'lucide-react';
import { getPlayerGameLog } from '@/lib/api/client';
import type { GameLogEntry, GameLogParams } from '@/lib/api/types';
import type { StatType } from '@/lib/api/types';
import {
  formatGameDate,
  getGameStatValue,
  computeGameFlags,
  compareStatToThreshold,
  getActiveGameLogStats,
  LAST_SEASON_YEAR,
  LAST_30_DAYS,
} from '@/lib/search-utils.js';

// ─── Stat display labels ────────────────────────────────────────────────────

export const STAT_LABELS: Record<string, string> = {
  disposals: 'Disp',
  goals: 'Goals',
  marks: 'Marks',
  tackles: 'Tkl',
  kicks: 'Kicks',
  handballs: 'HBs',
  clearances: 'Clr',
  hit_outs: 'HO',
};

// ─── Flag badge ─────────────────────────────────────────────────────────────

type FlagBadgeProps = {
  label: string;
  color: 'green' | 'blue' | 'amber' | 'purple';
};

export function FlagBadge({ label, color }: FlagBadgeProps) {
  const colorClasses = {
    green: 'bg-green-100 text-green-700 border-green-200',
    blue: 'bg-blue-100 text-blue-700 border-blue-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    purple: 'bg-purple-100 text-purple-700 border-purple-200',
  };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border ${colorClasses[color]}`}
    >
      {label}
    </span>
  );
}

// ─── Stat cell ───────────────────────────────────────────────────────────────

type StatCellProps = {
  value: number | null;
  isActive: boolean;     // this is the searched stat
  result: 'over' | 'under' | null;
};

export function StatCell({ value, isActive, result }: StatCellProps) {
  if (value == null) {
    return (
      <td className="px-2 py-2 text-center text-xs text-gray-500 tabular-nums">—</td>
    );
  }

  let cellClass = 'px-2 py-2 text-center text-xs tabular-nums font-medium ';

  if (isActive && result === 'over') {
    cellClass += 'text-emerald-700 bg-emerald-50 font-bold';
  } else if (isActive && result === 'under') {
    cellClass += 'text-red-600 bg-red-50/60 font-bold';
  } else if (isActive) {
    cellClass += 'text-gray-900 font-semibold';
  } else {
    cellClass += 'text-gray-600';
  }

  return <td className={cellClass}>{value}</td>;
}

// ─── Skeleton row ────────────────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-gray-100">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-2 py-2.5">
          <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${40 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export type PlayerGameLogProps = {
  receipt?: string;
  receiptExpiresAt?: number;
  /** Exactly one of player_id or player_name must be provided */
  player_id?: number;
  player_name?: string;
  /** Season range from the parent search */
  season_from?: number;
  season_to?: number;
  /** The stat currently being analysed — used to highlight the matching column */
  activeStat: StatType;
  /** The threshold value from the parent search — used for over/under colouring */
  threshold: number;
  /** Today's date as YYYY-MM-DD; injected so it's testable and consistent */
  todayDate: string;
  /** Exclude games where this player appeared */
  without_player_id?: number;
};

export function PlayerGameLog({
  receipt,
  receiptExpiresAt,
  player_id,
  player_name,
  season_from,
  season_to,
  activeStat,
  threshold,
  todayDate,
  without_player_id,
}: PlayerGameLogProps) {
  const [games, setGames] = useState<GameLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Track the params identity so we only refetch when player/season actually changes
  const lastFetchKey = useRef<string>('');

  useEffect(() => {
    const hasId = player_id !== undefined;
    const hasName = player_name !== undefined && player_name.trim() !== '';
    if (!hasId && !hasName) return;

    const key = JSON.stringify({ player_id, player_name, season_from, season_to, without_player_id, receipt, receiptExpiresAt });
    if (key === lastFetchKey.current) return;
    lastFetchKey.current = key;

    let cancelled = false;

    const params: GameLogParams = {};
    if (hasId) {
      params.player_id = player_id;
    } else {
      params.player_name = player_name!.trim();
    }
    if (season_from !== undefined) params.season_from = season_from;
    if (season_to !== undefined) params.season_to = season_to;
    if (without_player_id !== undefined) params.without_player_id = without_player_id;
    // Always fetch all game types — flags are computed client-side
    params.game_type = 'all';

    setLoading(true);
    setError(null);
    setGames([]);

    getPlayerGameLog(params, { purpose: 'context', receipt, receiptExpiresAt })
      .then((res) => {
        if (!cancelled) {
          setGames(res.games);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load game log');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (lastFetchKey.current === key) lastFetchKey.current = '';
    };
  }, [player_id, player_name, season_from, season_to, without_player_id, receipt, receiptExpiresAt]);

  // Active stat columns — derived once from the data
  const statCols = games.length > 0 ? getActiveGameLogStats(games) : [...['disposals', 'goals', 'marks', 'tackles']];

  const totalCols = 5 + statCols.length; // date + round + rest + opponent + flags + stats

  const displayName = player_name?.trim() ?? `Player #${player_id}`;

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header / toggle */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <TableIcon className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-semibold text-gray-800" title="See game-by-game stats to spot patterns and trends">Game Log</span>
          {!loading && games.length > 0 && (
            <span className="text-xs text-gray-500 font-normal">
              {games.length} {games.length === 1 ? 'game' : 'games'}
            </span>
          )}
          {loading && (
            <Loader2 className="w-3.5 h-3.5 text-gray-400 animate-spin" />
          )}
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
        <div className="border-t border-gray-100">
          {error ? (
            <div className="flex items-center gap-2 px-5 py-4 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse min-w-[640px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2.5 text-left font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Date</th>
                    <th className="px-2 py-2.5 text-left font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Rd</th>
                    <th
                      className="px-2 py-2.5 text-center font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap"
                      title="Days rest since this player's previous game"
                    >
                      Rest
                    </th>
                    <th className="px-3 py-2.5 text-left font-semibold text-gray-500 uppercase tracking-wide">Opponent</th>
                    <th className="px-2 py-2.5 text-left font-semibold text-gray-500 uppercase tracking-wide">Flags</th>
                    {statCols.map((stat) => (
                      <th
                        key={stat}
                        className={`px-2 py-2.5 text-center font-semibold uppercase tracking-wide whitespace-nowrap ${
                          stat === activeStat
                            ? 'text-green-700 bg-green-50/70'
                            : 'text-gray-500'
                        }`}
                      >
                        {STAT_LABELS[stat] ?? stat}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <SkeletonRow key={i} cols={totalCols} />
                    ))
                  ) : games.length === 0 ? (
                    <tr>
                      <td colSpan={totalCols} className="px-5 py-6 text-center text-sm text-gray-400">
                        No game data found for {displayName} in this range.
                      </td>
                    </tr>
                  ) : (
                    games.map((game, idx) => {
                      const flags = computeGameFlags(game, {
                        todayDate,
                        lastSeasonYear: LAST_SEASON_YEAR,
                        last30Days: LAST_30_DAYS,
                      });

                      return (
                        <tr
                          key={`${game.game_date}-${idx}`}
                          className="border-b border-gray-100 hover:bg-gray-50/60 transition-colors"
                        >
                          {/* Date */}
                          <td className="px-3 py-2 text-gray-700 whitespace-nowrap font-medium">
                            {formatGameDate(game.game_date)}
                          </td>

                          {/* Round */}
                          <td className="px-2 py-2 text-gray-500 whitespace-nowrap">
                            {game.round_number != null ? `R${game.round_number}` : '—'}
                          </td>

                          {/* Days Rest */}
                          <td className="px-2 py-2 text-center text-gray-600 tabular-nums whitespace-nowrap">
                            {game.days_since_last_game != null ? `${game.days_since_last_game}d` : '—'}
                          </td>

                          {/* Opponent */}
                          <td className="px-3 py-2 text-gray-700 max-w-[140px] truncate">
                            {game.opponent_name}
                          </td>

                          {/* Flags */}
                          <td className="px-2 py-2">
                            <div className="flex flex-wrap gap-1">
                              {flags.isHome && <FlagBadge label="Home" color="green" />}
                              {flags.isFinals && <FlagBadge label="Finals" color="purple" />}
                              {flags.isLastSeason && <FlagBadge label="'25" color="blue" />}
                              {flags.isLast30Days && <FlagBadge label="30d" color="amber" />}
                            </div>
                          </td>

                          {/* Stat columns */}
                          {statCols.map((stat) => {
                            const value = getGameStatValue(game, stat);
                            const isActive = stat === activeStat;
                            const result = isActive
                              ? compareStatToThreshold(value, threshold)
                              : null;
                            return (
                              <StatCell
                                key={stat}
                                value={value}
                                isActive={isActive}
                                result={result}
                              />
                            );
                          })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Legend */}
          {!loading && games.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-gray-500">
              <span className="font-semibold text-gray-600 uppercase tracking-wide">Flags:</span>
              <span className="flex items-center gap-1"><FlagBadge label="Home" color="green" /> Home game</span>
              <span className="flex items-center gap-1"><FlagBadge label="Finals" color="purple" /> Finals game</span>
              <span className="flex items-center gap-1"><FlagBadge label="'25" color="blue" /> Last season (2025)</span>
              <span className="flex items-center gap-1"><FlagBadge label="30d" color="amber" /> Last 30 days</span>
              <span className="ml-auto italic">Highlighted column = searched stat · green = over · red = under threshold</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
