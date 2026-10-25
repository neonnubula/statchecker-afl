/**
 * PlayerCareerAverages
 *
 * Expandable section that shows a player's year-by-year career averages.
 * Fetches lazily on first expand. Renders a table of (season, team, games,
 * avg per tracked stat). Adding a new stat to the backend CAREER_STAT_COLUMNS
 * list will automatically surface it here via the `averages` record.
 */

'use client';

import React, { useState, useCallback } from 'react';
import { ChevronDown, ChevronUp, Loader2, BarChart3 } from 'lucide-react';
import { getPlayerCareerAverages } from '@/lib/api/client';
import type { CareerSeasonAverages } from '@/lib/api/types';
import { statLabel, fmtAvg, extractStatKeys } from '@/lib/career-averages';

// ─── Props ───────────────────────────────────────────────────────────────────

interface PlayerCareerAveragesProps {
  playerId: number;
  /** Optional: shown in the toggle label before data loads */
  playerName?: string;
  /** Controls the visual size — 'sm' for inline dropdowns, 'md' for form sections */
  size?: 'sm' | 'md';
  className?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PlayerCareerAverages({
  playerId,
  playerName,
  size = 'md',
  className = '',
}: PlayerCareerAveragesProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seasons, setSeasons] = useState<CareerSeasonAverages[] | null>(null);
  const [statKeys, setStatKeys] = useState<string[]>([]);

  const fetchAverages = useCallback(async () => {
    if (seasons !== null || loading) return; // already fetched / in-flight
    setLoading(true);
    setError(null);
    try {
      const data = await getPlayerCareerAverages(playerId);
      if (!data) {
        setError('Could not load career averages.');
        return;
      }
      setSeasons(data.seasons);
      setStatKeys(extractStatKeys(data.seasons));
    } catch {
      setError('Could not load career averages.');
    } finally {
      setLoading(false);
    }
  }, [playerId, seasons, loading]);

  const handleToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && seasons === null && !loading) {
      fetchAverages();
    }
  }, [open, seasons, loading, fetchAverages]);

  const isSmall = size === 'sm';

  return (
    <div className={`career-averages ${className}`}>
      {/* Toggle button */}
      <button
        type="button"
        onClick={handleToggle}
        className={`flex items-center gap-1.5 text-gray-500 hover:text-gray-700 transition-colors ${
          isSmall ? 'text-xs py-0.5' : 'text-sm py-1'
        }`}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} career averages${playerName ? ` for ${playerName}` : ''}`}
      >
        <BarChart3 className={isSmall ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
        <span>{open ? 'Hide' : 'Career averages'}</span>
        {open ? (
          <ChevronUp className={isSmall ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
        ) : (
          <ChevronDown className={isSmall ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
        )}
      </button>

      {/* Expanded panel */}
      {open && (
        <div className={`mt-2 ${isSmall ? 'text-xs' : 'text-sm'}`}>
          {loading && (
            <div className="flex items-center gap-2 text-gray-400 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Loading…</span>
            </div>
          )}

          {error && !loading && (
            <p className="text-red-500 py-1">{error}</p>
          )}

          {seasons !== null && !loading && seasons.length === 0 && (
            <p className="text-gray-400 py-1">No career data available.</p>
          )}

          {seasons !== null && !loading && seasons.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className={`pr-3 pb-1 font-medium ${isSmall ? 'text-[10px]' : 'text-xs'}`}>Year</th>
                    <th className={`pr-3 pb-1 font-medium ${isSmall ? 'text-[10px]' : 'text-xs'}`}>Team</th>
                    <th className={`pr-3 pb-1 font-medium text-right ${isSmall ? 'text-[10px]' : 'text-xs'}`}>GP</th>
                    {statKeys.map((key) => (
                      <th
                        key={key}
                        className={`pr-3 pb-1 font-medium text-right ${isSmall ? 'text-[10px]' : 'text-xs'}`}
                      >
                        {statLabel(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {seasons.map((row, i) => (
                    <tr
                      key={`${row.season_year}-${row.team_name}`}
                      className={`border-b border-gray-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}
                    >
                      <td className="pr-3 py-1 font-medium text-gray-800">{row.season_year}</td>
                      <td className="pr-3 py-1 text-gray-600 whitespace-nowrap">{row.team_name}</td>
                      <td className="pr-3 py-1 text-right text-gray-700 tabular-nums">{row.games}</td>
                      {statKeys.map((key) => (
                        <td
                          key={key}
                          className="pr-3 py-1 text-right text-gray-700 tabular-nums"
                        >
                          {fmtAvg(row.averages[key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
