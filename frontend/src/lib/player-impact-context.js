/** Expired fixture details must never drive an automatic comparison. */
export function currentImpactFixture(upcoming, now = Date.now()) {
  if (!upcoming?.available) return upcoming ?? { available: false, reason: 'Next fixture details are pending.' };
  const starts = Date.parse(upcoming.starts_at);
  const retrieved = Date.parse(upcoming.retrieved_at);
  const reviewed = upcoming.source === 'official_fixture_review';
  const expires = reviewed ? Date.parse(upcoming.valid_until) : Math.min(starts, retrieved + 6 * 60 * 60 * 1000);
  const invalidStart = reviewed ? upcoming.starts_at != null && (!Number.isFinite(starts) || starts <= now) : !Number.isFinite(starts);
  if (invalidStart || !Number.isFinite(expires) || !Number.isFinite(retrieved) || expires <= now || retrieved > now) {
    return { available: false, reason: 'Next fixture details need refreshing. Run the search again to load automatic schedule comparisons.' };
  }
  return upcoming;
}

export const travelTransitionLabels = {
  home_to_away: 'Home → away',
  away_to_home: 'Away → home',
  away_to_away: 'Away → away',
  home_to_home: 'Home → home',
};

/** Select only the actual next-match band; never substitute pooled travel history. */
export function automaticImpactComparisons(data, now = Date.now()) {
  const upcoming = currentImpactFixture(data.upcoming, now);
  if (!upcoming.available) return { upcoming, rest: null, travel: null, transition: null };
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const contains = (band, value) => valid(band.min_inclusive) && value >= band.min_inclusive
    && (band.max_exclusive === null || (valid(band.max_exclusive) && value < band.max_exclusive));
  const rest = Number.isFinite(Date.parse(upcoming.starts_at)) && valid(upcoming.start_gap_hours) ? data.rest?.buckets?.find(b =>
    b.key === upcoming.rest_bucket && contains(b, upcoming.start_gap_hours)) ?? null : null;
  const transition = Object.hasOwn(travelTransitionLabels, upcoming.travel_transition) ?
    data.travel?.transitions?.find(t => t.key === upcoming.travel_transition) ?? null : null;
  const travel = transition && valid(upcoming.venue_distance_km) ? transition.buckets?.find(b =>
    b.key === upcoming.travel_bucket && contains(b, upcoming.venue_distance_km)) ?? null : null;
  return { upcoming, rest, travel, transition };
}

/** Finals impact applies only when the current verified next fixture is a final. */
export function isUpcomingImpactFinal(upcoming, now = Date.now()) {
  const current = currentImpactFixture(upcoming, now);
  return current.available === true && (current.game_type === 'Finals' || current.is_final === true);
}
