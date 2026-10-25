"""Read-only reconciliation of player appearances with sourced match context.

The sourced season sidecar supplies match phase and clocks independently of provisional
SQLite dates/types. It never rewrites game or player identities in that database.
"""
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import json
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlsplit

from app.afl_player_impact import calculate_player_impact

HISTORY_PATH = Path(__file__).resolve().parents[1] / 'data' / 'afl_impact_history.json'
TEAM_NAMES = {
    'Adelaide': 'Adelaide Crows', 'Brisbane Lions': 'Brisbane Lions',
    'Carlton': 'Carlton Blues', 'Collingwood': 'Collingwood Magpies',
    'Essendon': 'Essendon Bombers', 'Fremantle': 'Fremantle Dockers',
    'Geelong': 'Geelong Cats', 'Gold Coast': 'Gold Coast Suns',
    'Greater Western Sydney': 'Greater Western Sydney Giants',
    'Hawthorn': 'Hawthorn Hawks', 'Melbourne': 'Melbourne Demons',
    'North Melbourne': 'North Melbourne Kangaroos', 'Port Adelaide': 'Port Adelaide Power',
    'Richmond': 'Richmond Tigers', 'St Kilda': 'St Kilda Saints',
    'Sydney': 'Sydney Swans', 'West Coast': 'West Coast Eagles',
    'Western Bulldogs': 'Western Bulldogs',
}
VENUE_NAMES = {
    'Adelaide Hills': 'Adelaide Hills', 'Adelaide Oval': 'Adelaide Oval', 'Barossa Park': 'Barossa Park',
    'Blundstone Arena': 'Bellerive Oval', 'Bellerive Oval': 'Bellerive Oval',
    'Corroboree Group Manuka Oval': 'Manuka Oval', 'Corroboree Group Oval': 'Manuka Oval',
    'Engie Stadium': 'Sydney Showground', 'GIANTS Stadium': 'Sydney Showground', 'Giants Stadium': 'Sydney Showground',
    'GMHBA Stadium': 'Kardinia Park', 'Gabba': 'Gabba', 'Hands Oval': 'Hands Oval',
    'UNSW Canberra Oval': 'Manuka Oval', 'Manuka Oval': 'Manuka Oval', 'Mars Stadium': 'Eureka Stadium', 'Marvel Stadium': 'Docklands',
    'Melbourne Cricket Ground': 'M.C.G.', 'MCG': 'M.C.G.', 'Ninja Stadium': 'Bellerive Oval',
    'Norwood Oval': 'Norwood Oval', 'Optus Stadium': 'Perth Stadium',
    'People First Stadium': 'Carrara', 'Metricon Stadium': 'Carrara', 'Heritage Bank Stadium': 'Carrara',
    'Sydney Cricket Ground': 'S.C.G.', 'SCG': 'S.C.G.', 'TIO Stadium': 'Marrara Oval',
    'TIO Traeger Park': 'Traeger Park', 'UTAS Stadium': 'York Park', 'University of Tasmania Stadium': 'York Park',
}
STAT_COLUMNS = {'disposals', 'goals', 'marks', 'tackles', 'kicks', 'handballs', 'clearances', 'hit_outs'}


@lru_cache(maxsize=1)
def load_history():
    history = json.loads(HISTORY_PATH.read_text())
    if history.get('schema_version') != 1 or history.get('source') != 'squiggle':
        raise ValueError('Invalid history sidecar')
    return history


def match_games(local_games, source_games):
    """Unique round/venue, or exact date/ordered clubs for missing historical venue.

    A missing ground is source enrichment, never evidence that two grounds agree.
    Named contradictions are rejected. Both date and round indexes must be unique
    when their path is used; one source fixture can never serve two local rows.
    """
    source_round, source_date, local_round, local_date = (defaultdict(list) for _ in range(4))
    for g in source_games:
        clubs = (TEAM_NAMES.get(g['home']), TEAM_NAMES.get(g['away']))
        if None in clubs:
            continue
        source_round[(g['season'], g['round'], *clubs)].append(g)
        source_date[(g['season'], g['local_date'], *clubs)].append(g)
    for g in local_games:
        clubs = (g['home_name'], g['away_name'])
        local_round[(g['season_year'], g['round_number'], *clubs)].append(g)
        local_date[(g['season_year'], g['game_date'], *clubs)].append(g)
    matches = {}
    for g in local_games:
        suffix = (g['home_name'], g['away_name'])
        missing_venue = g['venue_name'] in (None, 'Unknown')
        if g['round_number'] is None or missing_venue:
            key = (g['season_year'], g['game_date'], *suffix)
            candidates, peers = source_date[key], local_date[key]
        else:
            key = (g['season_year'], g['round_number'], *suffix)
            candidates, peers = source_round[key], local_round[key]
        if len(candidates) != 1 or len(peers) != 1:
            continue
        candidate = candidates[0]
        source_venue = candidate.get('venue')
        if not isinstance(source_venue, str) or not source_venue.strip() or source_venue == 'Unknown':
            continue
        venue = VENUE_NAMES.get(g['venue_name'])
        canonical_source = VENUE_NAMES.get(source_venue, source_venue)
        if missing_venue:
            # The exact local date and ordered clubs uniquely identify the game.
            # A known round remains an additional precondition, not a hint.
            if g['round_number'] is not None and g['round_number'] != candidate['round']:
                continue
            matches[g['game_id']] = candidate
        elif venue and venue == canonical_source:
            matches[g['game_id']] = candidate
    # One source fixture must not be reused by a different local row via the
    # date fallback and round path. Exclude both candidates if that occurs.
    counts = Counter(g['source_game_id'] for g in matches.values())
    return {gid: g for gid, g in matches.items() if counts[g['source_game_id']] == 1}


def designated_transitions(games, *, live=False):
    """Consecutive club fixture designations, never inferred from venue location.

    Include fixtures without player statistics. Ambiguous IDs/clocks invalidate
    both the affected transition and its immediate successor; never skip them.
    Seasons are independent. For live context the preceding fixture must be final.
    """
    id_key, home_key, away_key = ('game_id', 'home_team', 'away_team') if live else ('source_game_id', 'home', 'away')
    groups = defaultdict(list)
    ids = Counter(g[id_key] for g in games)
    for game in games:
        season = game.get('season')
        if type(season) is not int:
            continue
        instant = datetime.fromisoformat(game['starts_at'])
        for name, designation in ((game.get(home_key), 'home'), (game.get(away_key), 'away')):
            if name and game.get(home_key) != game.get(away_key):
                groups[(season, name)].append((instant, game, designation))
    result = {}
    for (_, name), fixtures in groups.items():
        fixtures.sort(key=lambda item: item[0])
        clocks = Counter(item[0] for item in fixtures)
        for index, (instant, game, designation) in enumerate(fixtures):
            value = {'travel_transition': None, 'previous_designation': None,
                     'current_designation': designation, 'previous_game_id': None}
            if index:
                prior_instant, previous, prior_designation = fixtures[index-1]
                if (ids[game[id_key]] == ids[previous[id_key]] == 1
                        and clocks[instant] == clocks[prior_instant] == 1
                        and (not live or previous.get('state') == 'final')):
                    value.update(travel_transition=f'{prior_designation}_to_{designation}',
                                 previous_designation=prior_designation, previous_game_id=previous[id_key])
            result[(game[id_key], name)] = value
    return result


def _recent_verified_club(conn, player_id, player_name, accepted_clubs, current_year, now):
    """Read-only fallback for absent valid club dates, using the atomic import ledger."""
    if len(accepted_clubs) != 1 or not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='afl_verified_final_imports'").fetchone():
        return None
    latest = [dict(r) for r in conn.execute('''
        SELECT g.game_id,g.api_game_id,g.game_date,g.game_type,s.team_id,s.opponent_team_id,
               g.home_team_id,g.away_team_id,t.team_name
        FROM player_game_stats s JOIN games g USING(game_id) JOIN teams t ON t.team_id=s.team_id
        WHERE s.player_id=? AND g.season_year=? ORDER BY g.game_date DESC,g.game_id DESC LIMIT 2''',
        (player_id, current_year))]
    if not latest:
        return None
    game = latest[0]
    today = now.astimezone(ZoneInfo('Australia/Melbourne')).date()
    try:
        age = (today - datetime.fromisoformat(game['game_date']).date()).days
    except (ValueError, TypeError):
        return None
    if (not 0 <= age <= 30 or game['game_type'] != 'Finals'
            or game['team_id'] not in accepted_clubs
            or {game['team_id'], game['opponent_team_id']} != {game['home_team_id'], game['away_team_id']}
            or game['team_id'] == game['opponent_team_id']
            or (len(latest) > 1 and latest[1]['game_date'] == game['game_date'])):
        return None
    official_hosts = {'afl.com.au', 'afc.com.au', 'lions.com.au', 'carltonfc.com.au',
                      'collingwoodfc.com.au', 'fremantlefc.com.au', 'geelongcats.com.au',
                      'hawthornfc.com.au', 'melbournefc.com.au', 'sydneyswans.com.au', 'westernbulldogs.com.au'}
    evidence = []
    for record in conn.execute('SELECT applied_at,receipt_json FROM afl_verified_final_imports'):
        try:
            applied = datetime.fromisoformat(record['applied_at'])
            if applied.tzinfo is None or not now-timedelta(days=30) <= applied <= now:
                continue
            receipt = json.loads(record['receipt_json'])
            for entry in receipt['source_identity_overrides']:
                if (entry.get('player_id') != player_id or entry.get('player_name') != player_name
                        or entry.get('api_game_id') != game['api_game_id']
                        or entry.get('imported_team_id') != game['team_id']):
                    continue
                source = entry['identity_source']
                url = urlsplit(source['source_url'])
                checked = datetime.fromisoformat(source['retrieved_at'])
                checksum = source['source_sha256']
                host = (url.hostname or '').removeprefix('www.')
                if (url.scheme != 'https' or url.username or url.password or host not in official_hosts
                        or checked.tzinfo is None or not now-timedelta(days=30) <= checked <= now
                        or not isinstance(checksum, str) or len(checksum) != 64
                        or any(ch not in '0123456789abcdef' for ch in checksum)):
                    continue
                evidence.append({'method': 'recent_verified_finals_import', 'team_name': game['team_name'],
                                 'game_id': game['game_id'], 'api_game_id': game['api_game_id'],
                                 'game_date': game['game_date'], 'identity_source': source,
                                 'note': 'Recent official club identity corroboration; player selection is not confirmed.'})
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
    return evidence[0] if evidence else None


def read_player_impact(conn, player_id, stat, history=None, now=None, supplement=None):
    if stat not in STAT_COLUMNS:
        raise ValueError('Invalid stat')
    now = now or datetime.now(timezone.utc)
    history = load_history() if history is None else history
    seasons = [s['season'] for s in history['seasons']]
    source_games = [g for s in history['seasons'] for g in s['games']
                    if datetime.fromisoformat(g['starts_at']) < now]
    transitions = designated_transitions(source_games)
    marks = ','.join('?' for _ in seasons)
    local_games = [dict(r) for r in conn.execute(f'''
        SELECT g.*,h.team_name home_name,a.team_name away_name,v.venue_name
        FROM games g JOIN teams h ON h.team_id=g.home_team_id
        JOIN teams a ON a.team_id=g.away_team_id LEFT JOIN venues v ON v.venue_id=g.venue_id
        WHERE g.season_year IN ({marks})''', seasons)]
    matched = match_games(local_games, source_games)
    local = {g['game_id']: g for g in local_games}
    columns = {r['name'] for r in conn.execute('PRAGMA table_info(player_game_stats)')}
    value = f'pgs.{stat}' if stat in columns else 'NULL'
    activity_columns = ','.join(f'pgs.{name} observed_{name}' if name in columns else f'NULL observed_{name}' for name in sorted(STAT_COLUMNS))
    appearances = [dict(r) for r in conn.execute(f'''
        SELECT pgs.game_id,pgs.team_id,pgs.opponent_team_id,g.season_year,{value} stat_value,{activity_columns}
        FROM player_game_stats pgs JOIN games g ON g.game_id=pgs.game_id
        WHERE pgs.player_id=? AND g.season_year IN ({marks})''', [player_id, *seasons])]
    from app.afl_impact_supplement import get_supplemental_appearances
    supplemental_rows, supplement_report = get_supplemental_appearances(
        conn, player_id, stat, local_games, matched, supplement=supplement)
    local_appearance_count = len(appearances)
    appearances.extend(supplemental_rows)
    clubs = defaultdict(set)
    for row in appearances:
        clubs[row['season_year']].add(row['team_id'])
    ambiguous_seasons = sorted(year for year, teams in clubs.items() if len(teams) != 1)
    rows, excluded = [], Counter()
    accepted_clubs = defaultdict(set)
    corrected_phase_rows = 0
    source_supplied_venue_rows = 0
    for row in appearances:
        if row['season_year'] in ambiguous_seasons:
            excluded['multiple_recorded_clubs_in_season'] += 1
            continue
        game, source = local.get(row['game_id']), matched.get(row['game_id'])
        if not game or not source:
            excluded['unmatched_source_fixture'] += 1
            continue
        pair = {game['home_team_id'], game['away_team_id']}
        if {row['team_id'], row['opponent_team_id']} != pair or row['team_id'] == row['opponent_team_id']:
            excluded['inconsistent_appearance_team'] += 1
            continue
        accepted_clubs[row['season_year']].add(row['team_id'])
        name = source['home'] if row['team_id'] == game['home_team_id'] else source['away']
        if game['venue_name'] in (None, 'Unknown'):
            source_supplied_venue_rows += 1
        if source['game_type'] != game['game_type']:
            corrected_phase_rows += 1
        rows.append({'game_id': row['game_id'], 'season_year': row['season_year'],
                     'stat_value': row['stat_value'], 'game_type': source['game_type'],
                     'context': {**(source['teams'].get(name) or {}),
                                 **transitions.get((source['source_game_id'], name), {})},
                     'participation_unverified': all(row[f'observed_{field}'] == 0 for field in STAT_COLUMNS)})
    result = calculate_player_impact(rows, stat=stat)
    player = conn.execute('SELECT player_name FROM players WHERE player_id=?', (player_id,)).fetchone()
    result.update(player_id=player_id, player_name=player['player_name'] if player else None,
                  history_scope={'seasons': seasons, 'filters': 'Independent history: search filters do not narrow these comparisons.',
                                 'local_player_rows': local_appearance_count, 'supplemental_player_rows': len(supplemental_rows), 'matched_player_rows': len(rows),
                                 'excluded': dict(excluded), 'ambiguous_seasons': ambiguous_seasons,
                                 'source_phase_corrections': corrected_phase_rows,
                                 'source_supplied_venue_rows': source_supplied_venue_rows},
                  sources=[{k: s[k] for k in ('season', 'source_url', 'retrieved_at', 'source_sha256')}
                           for s in history['seasons']])
    result['supplement'] = supplement_report
    # Current-club records are not selection/availability evidence. Require one
    # explicit current club that agrees with an unambiguous current-year history.
    local_now = now.astimezone(ZoneInfo('Australia/Melbourne'))
    current_year = local_now.year
    current_clubs = [dict(r) for r in conn.execute('''
        SELECT DISTINCT pth.team_id,t.team_name FROM player_team_history pth
        JOIN teams t ON t.team_id=pth.team_id WHERE pth.player_id=? AND pth.is_current=1
        AND (pth.start_date IS NULL OR pth.start_date<=?)
        AND (pth.end_date IS NULL OR pth.end_date>=?)''', (player_id, local_now.date().isoformat(), local_now.date().isoformat()))]
    current_team = None
    if len(current_clubs) == 1 and accepted_clubs.get(current_year) == {current_clubs[0]['team_id']}:
        current_team = next((name for name, local_name in TEAM_NAMES.items() if local_name == current_clubs[0]['team_name']), None)
    elif not current_clubs:
        evidence = _recent_verified_club(conn, player_id, result['player_name'],
                                         accepted_clubs.get(current_year, set()), current_year, now)
        if evidence:
            current_team = next((name for name, local_name in TEAM_NAMES.items() if local_name == evidence['team_name']), None)
            if current_team:
                result['current_club_evidence'] = evidence
    return result, current_team


def attach_upcoming(result, current_team, context, now=None):
    now = now or datetime.now(timezone.utc)
    result['upcoming'] = {'available': False, 'reason': 'No verified upcoming club fixture is available.'}
    if not current_team:
        result['upcoming']['reason'] = 'Current club could not be corroborated from this player’s records.'
        return result
    if not context or context.get('stale') or context.get('status') != 'ready':
        result['upcoming']['reason'] = 'A fresh, verified fixture snapshot is unavailable. Automatic comparisons are pending a verified next fixture.'
        return result
    candidates = sorted([g for g in context.get('games', [])
                         if current_team in (g['home_team'], g['away_team']) and g['state'] == 'scheduled'
                         and datetime.fromisoformat(g['starts_at']) > now], key=lambda g: g['starts_at'])
    if not candidates or not candidates[0].get('schedule_verified'):
        return result
    game = candidates[0]
    tid = game['home_team_id'] if game['home_team'] == current_team else game['away_team_id']
    values = game['teams'].get(tid, {})
    transition = designated_transitions(context.get('games', []), live=True).get(
        (game['game_id'], current_team), {'travel_transition': None, 'previous_designation': None,
                                        'current_designation': 'home' if game['home_team'] == current_team else 'away',
                                        'previous_game_id': None})
    def bucket(kind, value):
        if value is None:
            return None
        return next((b['key'] for b in result[kind]['buckets']
                     if value >= b['min_inclusive'] and (b['max_exclusive'] is None or value < b['max_exclusive'])), None)
    result['upcoming'] = {'available': True, 'game_id': game['game_id'], 'team': current_team,
                          'home_team': game['home_team'], 'away_team': game['away_team'],
                          'game_type': 'Finals' if game.get('is_final') is True else 'Regular Season' if game.get('is_final') is False else None,
                          'starts_at': game['starts_at'], 'venue': game['venue'],
                          'start_gap_hours': values.get('start_gap_hours'), 'venue_distance_km': values.get('venue_distance_km'),
                          'venue_clock_shift_hours': values.get('venue_clock_shift_hours'),
                          'rest_bucket': bucket('rest', values.get('start_gap_hours')),
                          'travel_bucket': bucket('travel', values.get('venue_distance_km')),
                          **transition,
                          'source_url': game.get('confirmation_source'), 'retrieved_at': context['retrieved_at'],
                          'note': 'Club fixture and team schedule only; player selection and actual travel are not confirmed.'}
    return result
