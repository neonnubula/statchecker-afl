/** Only a sourced, dated, future fixture with two resolved clubs can seed research. */
export function isSelectableFixture(fixture, now = Date.now()) {
  const start = Date.parse(fixture?.starts_at ?? '');
  return fixture?.selectable === true && fixture.schedule_status === 'confirmed'
    && Number.isFinite(start) && start > now
    && typeof fixture.home_team_id === 'number' && typeof fixture.away_team_id === 'number'
    && fixture.home_team_id !== fixture.away_team_id
    && !!fixture.home_team_name && fixture.home_team_name !== 'TBC'
    && !!fixture.away_team_name && fixture.away_team_name !== 'TBC'
    && !!fixture.venue_name && fixture.venue_name !== 'TBC';
}

/** A known club can be preparing for a final even while its opponent/time is TBC. */
export function isUpcomingFinalFixture(fixture, now = Date.now()) {
  if (!fixture || fixture.game_type !== 'Finals' || fixture.source !== 'official_fixture_review'
      || !fixture.source_urls?.length || !fixture.checked_at
      || !(Date.parse(fixture.checked_at) <= now)) return false;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  if (String(fixture.season_year) !== today.slice(0, 4)
      || !fixture.date_window_end || fixture.date_window_end < today) return false;
  if (fixture.starts_at && !(Date.parse(fixture.starts_at) > now)) return false;
  return [fixture.home_team_name, fixture.away_team_name].some((name) => name && name !== 'TBC');
}

/**
 * @param {'regular' | 'finals' | 'all'} requested
 * @returns {'regular' | 'finals' | 'all'}
 */
export function nextGameType(requested, fixture, enabled, now = Date.now()) {
  return enabled && isUpcomingFinalFixture(fixture, now)
    ? 'all' : requested;
}
