"use client";

import { analyticsHeaders } from '@/lib/analytics-client';
import { useEffect, useState } from 'react';
import { Clock3, MapPin, Trophy, Info } from 'lucide-react';
import { automaticImpactComparisons, isUpcomingImpactFinal, travelTransitionLabels } from '@/lib/player-impact-context.js';
import type { OverUnderParams } from '@/lib/api/types';

type Comparison = {
  available: boolean; target_games: number; baseline_games: number;
  target_mean: number | null; baseline_mean: number | null; delta: number | null;
  percent_change: number | null; small_sample: boolean; excluded_target_games: number;
  without_unverified_participation?: Comparison;
};
type SeasonComparison = Comparison & { season_year: number; game_type?: string; reason?: string | null };
type Band = Comparison & { key: string; label: string; min_inclusive: number; max_exclusive: number | null; strata: SeasonComparison[] };
type ContextComparison = { coverage: { matched_context_rows: number; eligible_stat_rows: number }; buckets: Band[]; transitions?: (ContextComparison & { key: string; label: string })[] };
export type PlayerImpactData = {
  schema_version: number; stat: string; player_name: string;
  history_scope: { seasons: number[]; local_player_rows: number; matched_player_rows: number; ambiguous_seasons: number[]; excluded: Record<string, number>; source_supplied_venue_rows?: number; supplemental_player_rows?: number };
  coverage: { eligible_stat_rows: number; excluded_rows: number };
  data_quality?: { unverified_participation_rows: number };
  supplement?: { rows_added: number; sources: { api_game_id: number; source_url: string; retrieved_at: string }[] };
  finals: { aggregate: Comparison; per_season: SeasonComparison[] };
  rest: ContextComparison; travel: ContextComparison;
  upcoming: { available: boolean; game_type?: string; is_final?: boolean; reason?: string; home_team?: string; away_team?: string; team?: string;
    starts_at?: string | null; venue?: string; source?: string; valid_until?: string; date_window_start?: string; date_window_end?: string; start_gap_hours?: number | null; venue_distance_km?: number | null; venue_clock_shift_hours?: number | null;
    rest_bucket?: string | null; travel_bucket?: string | null; travel_transition?: string | null;
    previous_designation?: 'home' | 'away' | null; current_designation?: 'home' | 'away' | null; source_url?: string; retrieved_at?: string };
  sources: { season: number; retrieved_at: string; source_url: string }[];
};

const names: Record<string, string> = { disposals: 'disposals', goals: 'goals', marks: 'marks', tackles: 'tackles', kicks: 'kicks', handballs: 'handballs', clearances: 'clearances', hit_outs: 'hit-outs' };
const number = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1);
const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`;

function ParticipationSensitivity({ comparison, stat }: { comparison: Comparison; stat?: string }) {
  const alternate = comparison.without_unverified_participation;
  if (!alternate) return null;
  return <p className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-2 text-xs leading-5 text-amber-950">
    <span className="font-semibold">Participation sensitivity: </span>
    {alternate.available ? <>excluding all-zero records gives {signed(alternate.delta!)} {stat || ''} per game ({alternate.target_games} target / {alternate.baseline_games} baseline records){alternate.small_sample ? ' · small sample' : ''}.</> : 'Without the all-zero records, no matched comparison remains.'}
    <span className="block">Their participation is unverified; this is not a confirmed correction.</span>
  </p>;
}

function Difference({ comparison, stat }: { comparison?: Comparison; stat: string }) {
  if (!comparison?.available) return <p className="mt-4 text-sm leading-6 text-slate-600">Not enough matched history for a comparison.</p>;
  const color = comparison.delta! > 0 ? 'text-emerald-800' : comparison.delta! < 0 ? 'text-rose-800' : 'text-slate-800';
  return <div className="mt-4">
    <p className={`text-2xl font-semibold tracking-tight ${color}`}>{signed(comparison.delta!)} <span className="text-sm font-normal">{stat} / game</span></p>
    <p className="mt-1 text-xs text-slate-600">{comparison.percent_change == null ? 'Percentage unavailable for this baseline' : `${signed(comparison.percent_change)}% versus matched baseline`}</p>
    <dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-slate-500">In these games</dt><dd className="mt-1 text-base font-semibold text-slate-900">{number(comparison.target_mean)}</dd><dd className="text-slate-500">{comparison.target_games} games</dd></div><div><dt className="text-slate-500">Matched baseline</dt><dd className="mt-1 text-base font-semibold text-slate-900">{number(comparison.baseline_mean)}</dd><dd className="text-slate-500">{comparison.baseline_games} games</dd></div></dl>
    {comparison.small_sample ? <p className="mt-3 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">Small sample in one or more seasonal comparisons.</p> : null}
    <ParticipationSensitivity comparison={comparison} stat={stat} />
    {comparison.excluded_target_games > 0 ? <p className="mt-2 text-xs text-slate-500">{comparison.excluded_target_games} target games excluded because their season had no matched baseline.</p> : null}
  </div>;
}

function SeasonRows({ rows, targetLabel }: { rows: SeasonComparison[]; targetLabel: string }) {
  return <div className="mt-3 space-y-3">{rows.map(row => <div key={`${row.season_year}-${row.game_type || ''}`} className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
    <p className="font-semibold text-slate-800">{row.season_year}{row.game_type ? ` · ${row.game_type}` : ''}</p>
    <p className="mt-1 leading-5 text-slate-600">{targetLabel}: {number(row.target_mean)} ({row.target_games} games) · Baseline: {number(row.baseline_mean)} ({row.baseline_games} games)</p>
    <p className="mt-1 text-slate-700">{row.available ? `${signed(row.delta!)} per game${row.percent_change == null ? '' : ` · ${signed(row.percent_change)}%`}${row.small_sample ? ' · small sample' : ''}` : row.target_games === 0 ? 'No matched target games in this season.' : 'No matched baseline; excluded from the combined difference.'}</p>
    <ParticipationSensitivity comparison={row} />
  </div>)}</div>;
}

function ContextCard({ kind, context, stat, selected, transition, currentValue, fixtureAvailable, clockShift }: {
  kind: 'rest' | 'travel'; context: ContextComparison; stat: string; selected?: Band | null;
  transition?: string | null; currentValue?: number | null; fixtureAvailable: boolean; clockShift?: number | null;
}) {
  const title = kind === 'rest' ? 'Team turnaround' : 'Travel direction & distance';
  const Icon = kind === 'rest' ? Clock3 : MapPin;
  const clockLabel = kind === 'travel' && fixtureAvailable && typeof clockShift === 'number' && Number.isFinite(clockShift)
    ? clockShift === 0 ? 'unchanged' : `${Math.abs(clockShift)} ${Math.abs(clockShift) === 1 ? 'hour' : 'hours'} ${clockShift > 0 ? 'ahead' : 'behind'}`
    : null;
  return <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
    <h3 className="flex items-start gap-2 text-sm font-semibold text-slate-900"><Icon className="mt-0.5 shrink-0 text-slate-500" size={16} />{title}</h3>
    {selected ? <>
      <p className="mt-3 text-xs font-medium text-slate-500">Automatically matched to the next fixture</p>
      {kind === 'travel' && transition ? <p className="mt-2 text-sm font-semibold text-slate-900">{travelTransitionLabels[transition]}</p> : null}
      <p className="mt-1 text-sm font-semibold text-slate-900">{selected.label}</p>
      <p className="mt-2 text-xs text-emerald-800">{kind === 'rest' ? `${number(currentValue)} hours between club match starts` : `≈ ${Math.round(currentValue!).toLocaleString('en-US')} km between grounds`}</p>
      <Difference comparison={selected} stat={stat} />
    </> : <p className="mt-4 text-sm leading-6 text-slate-600">{!fixtureAvailable
      ? 'Next fixture details are pending. The comparison will appear automatically once the match and prior club schedule are verified.'
      : kind === 'rest'
        ? 'The exact next start time or previous club match is not verified yet. Turnaround comparison is pending.'
        : 'The previous ground, distance or home/away direction is not verified yet. Travel comparison is pending.'}</p>}
    {clockLabel ? <p className="mt-3 text-xs text-slate-600">Venue clock: {clockLabel}</p> : null}
    <p className="mt-4 text-xs leading-5 text-slate-500">Context available for {context.coverage.matched_context_rows} of {context.coverage.eligible_stat_rows} eligible appearances.</p>
    {selected ? <details className="mt-3 text-xs"><summary className="cursor-pointer font-medium text-slate-700">Season and game-type breakdown</summary><SeasonRows rows={selected.strata} targetLabel={kind === 'travel' ? 'This direction and distance' : 'This turnaround'} /></details> : null}
  </article>;
}

export function PlayerImpactPanel({ data }: { data: PlayerImpactData }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const expiry = data.upcoming.source === 'official_fixture_review' ? Date.parse(data.upcoming.valid_until || '') : Math.min(Date.parse(data.upcoming.starts_at || ''), Date.parse(data.upcoming.retrieved_at || '') + 6 * 60 * 60 * 1000);
    refresh();
    const timer = Number.isFinite(expiry) && expiry > Date.now() ? setTimeout(refresh, Math.min(expiry - Date.now() + 1, 2147483647)) : undefined;
    document.addEventListener('visibilitychange', refresh);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [data.upcoming]);
  const { upcoming, rest, travel, transition } = automaticImpactComparisons(data, now);
  const showFinals = isUpcomingImpactFinal(upcoming, now);
  const panelTitle = showFinals ? 'Finals, turnaround & travel impact' : 'Turnaround & travel impact';
  const stat = names[data.stat] || data.stat;
  const years = data.history_scope.seasons;
  const excluded = data.history_scope.local_player_rows + (data.history_scope.supplemental_player_rows || 0) - data.history_scope.matched_player_rows + data.coverage.excluded_rows;
  return <section aria-label={panelTitle} className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 sm:p-5">
    <header><p className="text-[10px] font-bold uppercase tracking-[0.15em] text-emerald-800">Player research · {years[0]}–{years[years.length - 1]}</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{panelTitle}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{data.player_name}’s {stat} versus a baseline from the same season. This history is independent of your search filters.</p></header>
    {upcoming.available ? <div className="mt-4 rounded-lg border border-emerald-200 bg-white p-3 text-xs leading-5 text-slate-700"><p className="font-semibold">{upcoming.team}’s next verified fixture: {upcoming.home_team} v {upcoming.away_team}</p><p>{upcoming.venue} · {upcoming.starts_at ? <>{new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Melbourne' }).format(new Date(upcoming.starts_at))} Melbourne time</> : <>{upcoming.date_window_start && upcoming.date_window_end ? `${upcoming.date_window_start} to ${upcoming.date_window_end} · ` : ''}Date and time TBC</>}</p><p className="text-slate-500">Club fixture only; player selection and actual travel are not confirmed.</p>{upcoming.source_url ? <a href={upcoming.source_url} target="_blank" rel="noreferrer" className="text-emerald-800 underline underline-offset-2">Official fixture source</a> : null}</div> : <p className="mt-3 text-xs leading-5 text-slate-500">{upcoming.reason}</p>}
    {data.history_scope.ambiguous_seasons.length ? <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Excluded {data.history_scope.ambiguous_seasons.join(', ')}: this player’s records contain multiple clubs in the same season and need identity verification.</p> : null}
    {(data.supplement?.rows_added || 0) > 0 ? <p className="mt-3 text-xs leading-5 text-emerald-800">Includes {data.supplement!.rows_added} sourced 2013 stat records recovered for these comparisons.</p> : null}
    {(data.data_quality?.unverified_participation_rows || 0) > 0 ? <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">{data.data_quality!.unverified_participation_rows} records have all eight stats recorded as zero, with participation unverified. The main figures retain them; affected comparisons also show the result if those records are excluded. A genuine zero-stat game may be among them.</p> : null}
    <div className={`mt-4 grid gap-3 ${showFinals ? 'lg:grid-cols-3' : 'md:grid-cols-2'}`}>
      {showFinals ? <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4"><h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Trophy size={16} className="text-amber-700" />Finals uplift / downlift</h3><p className="mt-3 text-xs leading-5 text-slate-500">Each year’s finals against that year’s regular-season average.</p><Difference comparison={data.finals.aggregate} stat={stat} /><details className="mt-4 text-xs"><summary className="cursor-pointer font-medium text-slate-700">Finals by season</summary><SeasonRows rows={data.finals.per_season} targetLabel="Finals" /></details></article> : null}
      <ContextCard kind="rest" context={data.rest} stat={stat} selected={rest} currentValue={upcoming.start_gap_hours} fixtureAvailable={upcoming.available} />
      <ContextCard kind="travel" context={transition || data.travel} stat={stat} selected={travel} transition={transition?.key} currentValue={upcoming.venue_distance_km} fixtureAvailable={upcoming.available} clockShift={upcoming.venue_clock_shift_hours} />
    </div>
    <details className="mt-4 text-xs leading-5 text-slate-600"><summary className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-700"><Info size={14} />Method, coverage and sources</summary>
      {showFinals ? <p className="mt-3">Finals differences combine the seasonal comparisons in proportion to finals appearances. For example, 2025 finals use the 2025 regular-season baseline; 2024 finals use 2024. The baseline shown above uses the same weighting.</p> : null}
      <p className="mt-2">Turnaround compares against other known turnaround bands within the same season and game type. Travel first matches the club’s home/away direction, then compares the next match’s distance band against other distance bands within that direction, season and game type. Each comparison is weighted by appearances in its target band. These are separate comparisons, not a combined travel-and-rest effect. Opponents, role, injuries and other factors can still explain differences.</p>
      <p className="mt-2">Turnaround is between the club’s match starts, not measured player recovery. Home and away refer to the club’s fixture designation, including neutral grounds. Distance is approximate and straight-line between the club’s consecutive grounds; the player may not have appeared in the previous match. Venue clock shifts compare ground clocks at kickoff; they do not measure observed jet lag. The figures are descriptive and are not added to the algorithm.</p>
      <p className="mt-2">{data.coverage.eligible_stat_rows} eligible stat appearances; {excluded} source, identity, duplicate or missing-stat rows excluded. Null values are excluded; recorded zeroes count. Older ingestion sometimes stored missing source values as zero, so that distinction cannot always be recovered. Only sourced {years.join(', ')} seasons are included. Missing finals/player rows are not filled with zeroes.</p>
      {(data.history_scope.source_supplied_venue_rows || 0) > 0 ? <p className="mt-2">Recovered the ground for {data.history_scope.source_supplied_venue_rows} older records by uniquely matching the exact date and home/away clubs to the sourced schedule.</p> : null}
      <ul className="mt-2 space-y-1">{data.sources.map(source => <li key={source.season}><a className="underline underline-offset-2" href={source.source_url} target="_blank" rel="noreferrer">{source.season} Squiggle schedule</a> · snapshot {source.retrieved_at.slice(0, 10)}</li>)}</ul>
      {data.supplement?.sources.length ? <ul className="mt-2 space-y-1">{data.supplement.sources.map(source => <li key={source.api_game_id}><a href={source.source_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">API-Sports recovered stats · game {source.api_game_id}</a> · retrieved {source.retrieved_at.slice(0, 10)}</li>)}</ul> : null}
      <p className="mt-2"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">© OpenStreetMap contributors · ODbL</a> · <a href="/afl-venues.json" target="_blank" rel="noreferrer" className="underline">Venue data and sources</a></p>
    </details>
  </section>;
}

export default function PlayerImpactResearch({ params, receipt }: { params: OverUnderParams; receipt?: string }) {
  const [data, setData] = useState<PlayerImpactData | null>(null);
  const [message, setMessage] = useState('Loading turnaround and travel comparisons…');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null);
    setMessage('Loading turnaround and travel comparisons…');
    const dev = process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DEV_MODE === 'true';
    if (!dev && !receipt) {
      setMessage('Run this search again to load turnaround and travel comparisons.');
      return () => { active = false; controller.abort(); };
    }
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null) query.set(key, String(value)); });
    const timer = setTimeout(() => controller.abort(), 40000);
    fetch(`${dev ? '/dev/api' : '/api'}/search/player-impact?${query}`, {
      cache: 'no-store', signal: controller.signal,
      headers: { ...analyticsHeaders(undefined), 'x-search-purpose': 'context', ...(receipt ? { 'x-search-receipt': receipt } : {}) },
    }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? 'Run this search again to load these comparisons.' : 'Turnaround and travel comparisons are temporarily unavailable.');
      const result = await response.json();
      if (result.schema_version !== 1 || result.stat !== params.stat || !result.finals || !result.history_scope) throw new Error('Comparison data is unavailable.');
      if (active) setData(result);
    }).catch(error => { if (active) setMessage(error.name === 'AbortError' ? 'Comparison data took too long to load. Run the search again to retry.' : error.message); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [params, receipt]);
  return data ? <PlayerImpactPanel data={data} /> : <section aria-label="Turnaround and travel impact" aria-live="polite" className="rounded-xl border border-slate-200 bg-slate-50 p-5"><h2 className="text-base font-semibold text-slate-900">Turnaround &amp; travel impact</h2><p className="mt-2 text-sm text-slate-600">{message}</p></section>;
}
