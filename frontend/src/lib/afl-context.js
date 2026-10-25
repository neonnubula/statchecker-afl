// Pure presentation rules: provider identities are never joined to player data.
export function visibleContextGames(games, { team = 'all', state = 'upcoming', now = Date.now() } = {}) {
  return games.filter(game => {
    if (!game.home_team_id || !game.away_team_id || !game.home_team || !game.away_team) return false;
    if (team !== 'all' && game.home_team_id !== team && game.away_team_id !== team) return false;
    const start = Date.parse(game.starts_at);
    if (!Number.isFinite(start)) return false;
    return state === 'upcoming' ? game.state === 'scheduled' && game.schedule_verified === true && start > now
      : state === 'completed' ? game.state === 'final' && start <= now : true;
  }).sort((a, b) => state === 'upcoming'
    ? Date.parse(a.starts_at) - Date.parse(b.starts_at)
    : Date.parse(b.starts_at) - Date.parse(a.starts_at));
}

export function contextTeams(games) {
  const teams = new Map();
  for (const game of games) {
    if (game.home_team_id && game.home_team) teams.set(game.home_team_id, game.home_team);
    if (game.away_team_id && game.away_team) teams.set(game.away_team_id, game.away_team);
  }
  return [...teams].sort((a, b) => a[1].localeCompare(b[1]));
}

export function contextIsStale(data, now = Date.now()) {
  const retrieved = Date.parse(data.retrieved_at);
  return data.stale === true || !Number.isFinite(retrieved)
    || retrieved > now + 300000 || now - retrieved >= 6 * 60 * 60 * 1000;
}

export async function loadAflContext({ fetch: fetcher, baseUrl, secret }) {
  if (!secret || !baseUrl) return null;
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/afl/context`, {
      headers: { 'X-Internal-Secret': secret }, cache: 'no-store',
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.schema_version !== 1 || data.source !== 'squiggle'
        || !Array.isArray(data.games) || data.games.length > 400
        || !Number.isFinite(Date.parse(data.retrieved_at)) || !data.coverage) return null;
    return data;
  } catch {
    return null;
  }
}
