"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUpRight, RefreshCw, MapPin } from "lucide-react";
import { contextIsStale, contextTeams, visibleContextGames } from "@/lib/afl-context";

type TeamContext = {
  previous_venue: string | null;
  start_gap_hours: number | null;
  calendar_gap_days: number | null;
  venue_distance_km: number | null;
  venue_clock_shift_hours: number | null;
  games_previous_14_days: number | null;
  games_previous_28_days: number | null;
};
type Game = {
  game_id: string; season: number; round_name: string; starts_at: string;
  source_local_time: string; venue: string; state: string;
  schedule_verified?: boolean; confirmation_source?: string | null;
  home_team_id: string | null; away_team_id: string | null;
  home_team: string | null; away_team: string | null;
  teams: Record<string, TeamContext>;
};
export type AflContextData = {
  schema_version: number; source: string; retrieved_at: string; stale?: boolean;
  coverage: { games: number; completed: number; unresolved_team_games: number };
  games: Game[];
};

function timestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Melbourne" }).format(new Date(value));
}

function localStart(value: string) {
  // Source wall-clock time is intentionally NOT converted into the viewer's zone.
  const [day, time] = value.split("T");
  const [year, month, date] = day.split("-");
  return `${month}/${date}/${year} · ${time.slice(0, 5)} local`;
}

function TeamPanel({ name, context }: { name: string; context?: TeamContext }) {
  const c = context;
  const metric = (value: number | null | undefined, suffix = "") => value == null ? "Unavailable" : `${value}${suffix}`;
  return (
    <div className="min-w-0 rounded-xl bg-muted p-4 sm:p-5">
      <h3 className="text-base font-semibold text-foreground">{name}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">Previous ground: {c?.previous_venue ?? "Unavailable"}</p>
      <dl className="mt-5 grid grid-cols-2 gap-x-3 gap-y-5">
        <div><dt className="text-xs text-muted-foreground">Between match starts</dt><dd className="mt-1 text-lg font-medium text-foreground">{metric(c?.start_gap_hours, " hrs")}</dd><dd className="mt-1 text-xs text-muted-foreground">{c?.calendar_gap_days == null ? "No resolved previous match" : `${c.calendar_gap_days} calendar days (Melbourne)`}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Ground-to-ground estimate</dt><dd className="mt-1 text-lg font-medium text-foreground">{c?.venue_distance_km == null ? "Unavailable" : `≈ ${Math.round(c.venue_distance_km).toLocaleString("en-US")} km`}</dd><dd className="mt-1 text-xs text-muted-foreground">Straight-line distance</dd></div>
        <div><dt className="text-xs text-muted-foreground">Clock difference</dt><dd className="mt-1 text-base text-foreground">{c?.venue_clock_shift_hours == null ? "Unavailable" : `${c.venue_clock_shift_hours > 0 ? "+" : ""}${c.venue_clock_shift_hours} hrs`}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Prior 14 / 28 days</dt><dd className="mt-1 text-base text-foreground">{c?.games_previous_14_days == null || c?.games_previous_28_days == null ? "Unavailable" : `${c.games_previous_14_days} / ${c.games_previous_28_days} games`}</dd></div>
      </dl>
    </div>
  );
}

export default function AflMatchContext({ data, renderedAt }: { data: AflContextData | null; renderedAt: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [team, setTeam] = useState("all");
  const [state, setState] = useState("upcoming");
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [renderedAt]);
  const games = data ? visibleContextGames(data.games, { team, state, now }) as Game[] : [];
  const stale = data ? contextIsStale(data, now) : false;
  const teams = data ? contextTeams(data.games) : [];
  const unconfirmed = data ? data.games.filter(g => g.state === "scheduled" && g.schedule_verified !== true && Date.parse(g.starts_at) > now).length : 0;
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <nav className="flex flex-wrap items-center justify-between gap-4 text-sm">
          <Link href="/" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"><ArrowLeft size={16} /> Dashboard</Link>
          <Link href="/single" className="inline-flex items-center gap-2 text-orange-700 hover:text-orange-800">Player research <ArrowUpRight size={16} /></Link>
        </nav>
        <header className="mt-10 border-t border-pulse-500/60 pt-6">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-orange-700">StatChecker / AFL</p>
          <h1 className="mt-4 text-4xl font-medium tracking-tight sm:text-5xl">Match context</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">Compare team turnaround, recent games and the distance between grounds before you research a player.</p>
        </header>
        <div className="my-7 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-muted p-4 text-sm">
          <div>
            <p className={stale ? "text-amber-800" : "text-muted-foreground"}>{!data ? "Context is temporarily unavailable" : stale ? "Older snapshot — refresh could not be confirmed" : "Schedule snapshot · not live scores"}</p>
            {data ? <p className="mt-1 text-xs leading-5 text-muted-foreground">Retrieved {timestamp(data.retrieved_at)} Melbourne time. Source refreshes on demand, at most once every six hours.</p> : <p className="mt-1 text-xs text-muted-foreground">Please try again later. Your player research is still available.</p>}
          </div>
          <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-white/5 disabled:opacity-50"><RefreshCw size={14} className={pending ? "animate-spin" : ""} /> {pending ? "Checking…" : "Check snapshot"}</button>
        </div>
        {data ? <>
          <div className="flex flex-wrap gap-4">
            <label className="grid min-w-0 flex-1 gap-2 text-xs text-muted-foreground">Team<select value={team} onChange={e => setTeam(e.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground"><option value="all">All teams</option>{teams.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
            <label className="grid min-w-[150px] flex-1 gap-2 text-xs text-muted-foreground">Matches<select value={state} onChange={e => setState(e.target.value)} className="min-h-11 rounded-lg border border-border bg-card px-3 text-sm text-foreground"><option value="upcoming">Upcoming</option><option value="completed">Completed</option></select></label>
          </div>
          <p aria-live="polite" className="my-4 text-xs text-muted-foreground">{games.length} {games.length === 1 ? "match" : "matches"} · {data.coverage.games} source fixtures · {unconfirmed} future fixtures awaiting confirmation excluded</p>
          {games.length === 0 ? <div className="rounded-xl border border-border p-7 text-sm leading-6 text-muted-foreground">No {state} matches {state === "upcoming" ? "with independently checked fixture details" : "with both teams named"} in this snapshot for your selection. Try another team or view completed matches.</div> : null}
          <div className="space-y-5">{games.map(game => <article key={game.game_id} className="overflow-hidden rounded-2xl border border-border bg-card p-4 sm:p-6">
            <div className="mb-5"><p className="text-xs text-orange-700">{game.season} · {game.round_name} · {game.state === "final" ? "Completed" : "Scheduled"}</p><h2 className="mt-2 text-xl font-medium tracking-tight">{game.home_team} <span className="text-muted-foreground">v</span> {game.away_team}</h2><p className="mt-2 flex items-start gap-2 text-sm text-muted-foreground"><MapPin size={15} className="mt-0.5 shrink-0" /><span>{game.venue} · {localStart(game.source_local_time)}</span></p>{game.schedule_verified && game.confirmation_source ? <a href={game.confirmation_source} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-orange-700 underline underline-offset-4">Official fixture cross-check</a> : null}</div>
            <div className="grid gap-3 sm:grid-cols-2"><TeamPanel name={game.home_team!} context={game.teams[game.home_team_id!]} /><TeamPanel name={game.away_team!} context={game.teams[game.away_team_id!]} /></div>
          </article>)}</div>
        </> : null}
        <aside className="mt-8 rounded-xl border border-border p-5 text-sm leading-6 text-muted-foreground">
          <h2 className="font-medium text-foreground">What these numbers mean</h2>
          <p className="mt-2">Turnaround is the interval between team match starts, not player recovery time. Distance is approximate and straight-line between consecutive grounds; it does not include flights, returns home or training bases. Clock difference compares venue time zones, not measured jet lag.</p>
          <p className="mt-3">Recent-game counts cover completed matches observed within this season. Missing games can affect these totals. Upcoming fixtures appear only when their teams, ground and start time match an independently checked official listing. Other future fixtures remain hidden until checked. Scheduled times can still change. These comparisons do not change player hit rates or predict a betting edge.</p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs underline underline-offset-4"><a href="https://api.squiggle.com.au/" target="_blank" rel="noreferrer">Schedule: Squiggle</a><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Coordinates: © OpenStreetMap contributors · ODbL</a><a href="/afl-venues.json" target="_blank" rel="noreferrer">Download venue data & sources (ODbL)</a><a href="https://www.afl.com.au/fixture" target="_blank" rel="noreferrer">Check official AFL fixture</a></div>
        </aside>
      </div>
    </main>
  );
}
