"""Use reviewed fixture facts for automatic player context, including TBC kickoffs.

Completed schedule history supplies the club's previous ground and designation.
No flight itinerary, home base or player participation is inferred.
"""
from datetime import datetime, time, timezone
import json
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.afl_context import _distance
from app.afl_context_api import VENUES_PATH
from app.afl_fixture_overlay import ZONE, remaining_fixtures
from app.afl_player_context import TEAM_NAMES, VENUE_NAMES, load_history


def _stamp(value):
    stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Context time requires timezone')
    return stamp


def _band(context, value):
    if value is None:
        return None
    return next((b['key'] for b in context['buckets'] if value >= b['min_inclusive']
                 and (b['max_exclusive'] is None or value < b['max_exclusive'])), None)


def _venue_clock_shift(previous_ground, next_ground, next_start):
    """Next ground minus previous ground clock, at the SAME confirmed instant.

    This is geographic clock context, not observed travel or a player penalty.
    An uncertain kickoff cannot establish which seasonal UTC offsets apply.
    """
    if next_start is None or not previous_ground or not next_ground:
        return None
    prior_zone, next_zone = previous_ground.get('timezone'), next_ground.get('timezone')
    if not isinstance(prior_zone, str) or not isinstance(next_zone, str):
        return None
    try:
        previous_offset = next_start.astimezone(ZoneInfo(prior_zone)).utcoffset()
        next_offset = next_start.astimezone(ZoneInfo(next_zone)).utcoffset()
        return (next_offset - previous_offset).total_seconds() / 3600
    except (ZoneInfoNotFoundError, ValueError):
        return None


def attach_reviewed_upcoming(result, current_team, conn, *, now=None, fixtures=None, history=None, venues=None):
    now = now or datetime.now(timezone.utc)
    if not current_team:
        return result
    fixtures = remaining_fixtures(conn, now=now) if fixtures is None else fixtures
    if fixtures is None:  # Other seasons continue using the ordinary schedule feed.
        return result
    result['upcoming'] = {'available': False, 'reason': 'No confirmed next fixture is available for this club.'}
    club = TEAM_NAMES.get(current_team)
    matches = [f for f in fixtures if club in (f['home_team_name'], f['away_team_name'])]
    if not club or not matches:
        return result
    fixture = min(matches, key=lambda f: (f['date_window_start'], f['round_number']))
    start = _stamp(fixture['starts_at']) if fixture.get('starts_at') else None
    valid_until = start or datetime.combine(datetime.fromisoformat(fixture['date_window_start']).date(), time.min, ZONE)
    checked = _stamp(fixture['checked_at'])
    if not checked <= now < valid_until:
        return result
    history = load_history() if history is None else history
    season = next((s for s in history['seasons'] if s['season'] == fixture['season_year']), None)
    if not season:
        return result
    previous = sorted([g for g in season['games'] if current_team in (g['home'], g['away'])
                       and _stamp(g['starts_at']) < now], key=lambda g: _stamp(g['starts_at']))
    if not previous or (len(previous) > 1 and previous[-1]['starts_at'] == previous[-2]['starts_at']):
        return result
    prior = previous[-1]
    # A newly imported game beyond the retained source snapshot invalidates this
    # fallback until its schedule is refreshed; never silently skip an appearance.
    newer = conn.execute('''SELECT 1 FROM games g JOIN teams t
        ON t.team_id IN (g.home_team_id,g.away_team_id)
        WHERE t.team_name=? AND g.season_year=? AND g.game_date>? AND g.game_date<=? LIMIT 1''',
        (club, fixture['season_year'], prior['local_date'], now.astimezone(ZONE).date().isoformat())).fetchone()
    if newer:
        result['upcoming']['reason'] = 'The previous match schedule is being updated; automatic context is pending.'
        return result
    current = 'home' if fixture['home_team_name'] == club else 'away'
    old = 'home' if prior['home'] == current_team else 'away'
    transition = f'{old}_to_{current}'
    if venues is None:
        venues = json.loads(VENUES_PATH.read_text()) if VENUES_PATH.exists() else {}
    old_ground = venues.get(VENUE_NAMES.get(prior['venue'], prior['venue']))
    new_ground = venues.get(VENUE_NAMES.get(fixture['venue_name'], fixture['venue_name']))
    distance = _distance(old_ground, new_ground) if old_ground and new_ground else None
    clock_shift = _venue_clock_shift(old_ground, new_ground, start)
    gap = (start - _stamp(prior['starts_at'])).total_seconds()/3600 if start else None
    if gap is not None and gap <= 0:
        return result
    result['upcoming'] = {
        'available': True, 'source': 'official_fixture_review',
        'game_id': f"reviewed:{fixture['fixture_id']}", 'team': current_team,
        'game_type': fixture.get('game_type'),
        'home_team': fixture['home_team_name'], 'away_team': fixture['away_team_name'],
        'starts_at': start.isoformat() if start else None, 'venue': fixture['venue_name'],
        'date_window_start': fixture['date_window_start'], 'date_window_end': fixture['date_window_end'],
        'valid_until': valid_until.isoformat(), 'retrieved_at': fixture['checked_at'],
        'source_url': fixture['source_urls'][0], 'source_urls': fixture['source_urls'],
        'previous_game_id': prior['source_game_id'], 'previous_venue': prior['venue'],
        'previous_starts_at': prior['starts_at'], 'previous_schedule_source_url': season['source_url'],
        'previous_schedule_retrieved_at': season['retrieved_at'],
        'previous_designation': old, 'current_designation': current, 'travel_transition': transition,
        'start_gap_hours': gap, 'venue_distance_km': distance, 'venue_clock_shift_hours': clock_shift,
        'rest_bucket': _band(result['rest'], gap), 'travel_bucket': _band(result['travel'], distance),
        'note': 'Home/away means the designated club in consecutive fixtures; distance is between grounds, not an observed trip.',
    }
    return result
