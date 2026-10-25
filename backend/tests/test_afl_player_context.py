"""Read-time player impact joins must not invent identities or samples."""
from copy import deepcopy
from datetime import datetime, timezone
import sqlite3

import pytest

from app.afl_player_context import attach_upcoming, match_games, read_player_impact

NOW = datetime(2026, 9, 12, tzinfo=timezone.utc)


@pytest.fixture
def db():
    conn = sqlite3.connect(':memory:', check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript('''
        CREATE TABLE players(player_id INTEGER PRIMARY KEY,player_name TEXT,api_player_id INTEGER);
        INSERT INTO players VALUES(1,'Fixture Player',9999),(99,'Fixture Player',1);
        CREATE TABLE teams(team_id INTEGER PRIMARY KEY,team_name TEXT);
        INSERT INTO teams VALUES(10,'Brisbane Lions'),(20,'Adelaide Crows'),(30,'Sydney Swans');
        CREATE TABLE venues(venue_id INTEGER PRIMARY KEY,venue_name TEXT);
        INSERT INTO venues VALUES(1,'Gabba'),(2,'Sydney Cricket Ground'),(3,'Unverified Ground');
        CREATE TABLE games(game_id INTEGER PRIMARY KEY,api_game_id INTEGER,season_year INTEGER,
            round_number INTEGER,game_type TEXT,game_date TEXT,game_time TEXT,
            venue_id INTEGER,home_team_id INTEGER,away_team_id INTEGER);
        CREATE TABLE player_game_stats(stat_id INTEGER PRIMARY KEY,player_id INTEGER,game_id INTEGER,
            team_id INTEGER,opponent_team_id INTEGER,disposals INTEGER,kicks INTEGER);
        CREATE TABLE player_team_history(player_id INTEGER,team_id INTEGER,is_current INTEGER,
            start_date TEXT,end_date TEXT);
    ''')
    yield conn
    conn.close()


def add_game(db, gid, *, year=2025, round_number=1, date=None, venue=1, home=10, away=20):
    date = date or f'{year}-06-{gid:02d}'
    db.execute('INSERT INTO games VALUES(?,?,?, ?,?,?,?, ?,?,?)',
               (gid, 50000+gid, year, round_number, 'Regular Season', date, '14:00', venue, home, away))
    return dict(db.execute('''SELECT g.*,h.team_name home_name,a.team_name away_name,v.venue_name
        FROM games g JOIN teams h ON h.team_id=g.home_team_id JOIN teams a ON a.team_id=g.away_team_id
        JOIN venues v USING(venue_id) WHERE game_id=?''', (gid,)).fetchone())


def add_stat(db, gid, *, value=20, kicks=10, player=1, team=10, opponent=20):
    db.execute('INSERT INTO player_game_stats(player_id,game_id,team_id,opponent_team_id,disposals,kicks) VALUES(?,?,?,?,?,?)',
               (player, gid, team, opponent, value, kicks))


def source(local, **overrides):
    names = {'Brisbane Lions': 'Brisbane Lions', 'Adelaide Crows': 'Adelaide', 'Sydney Swans': 'Sydney'}
    home, away = names[local['home_name']], names[local['away_name']]
    row = {'source_game_id': f"squiggle:{70000+local['game_id']}", 'season': local['season_year'],
           'round': local['round_number'] if local['round_number'] is not None else 25,
           'local_date': local['game_date'], 'starts_at': local['game_date']+'T09:00:00+00:00',
           'home': home, 'away': away, 'venue': 'Gabba', 'game_type': 'Regular Season',
           'teams': {home: {'start_gap_hours': 150, 'venue_distance_km': 800},
                     away: {'start_gap_hours': 170, 'venue_distance_km': 1800}}}
    row.update(overrides)
    return row


def history(*games):
    years = sorted(set(g['season'] for g in games))
    return {'schema_version': 1, 'source': 'squiggle', 'seasons': [
        {'season': year, 'source_url': f'https://api.squiggle.com.au/?q=games&year={year}',
         'retrieved_at': '2026-09-11T22:00:00+00:00', 'source_sha256': 'a'*64,
         'games': [g for g in games if g['season'] == year]} for year in years]}


def test_unique_round_join_ignores_provisional_date_but_requires_venue(db):
    local = add_game(db, 1, year=2026, round_number=17, date='2026-07-01')
    verified = source(local, local_date='2026-07-02', starts_at='2026-07-02T09:30:00+00:00')
    assert match_games([local], [verified]) == {1: verified}
    verified['venue'] = 'S.C.G.'
    assert match_games([local], [verified]) == {}


def test_null_round_uses_exact_source_local_calendar_date_not_utc_date(db):
    local = add_game(db, 1, round_number=None, date='2025-06-02')
    verified = source(local, starts_at='2025-06-01T23:30:00+00:00')
    assert match_games([local], [verified]) == {1: verified}
    verified['local_date'] = '2025-06-01'
    assert match_games([local], [verified]) == {}


@pytest.mark.parametrize('change', [{'home': 'Adelaide', 'away': 'Brisbane Lions'},
                                    {'home': 'Brisbane'}, {'venue': 'Unknown'}, {'season': 2024}])
def test_near_names_reversed_sides_and_wrong_year_do_not_guess_match(db, change):
    local = add_game(db, 1)
    assert match_games([local], [source(local, **change)]) == {}


@pytest.mark.parametrize('kind', ['source_round', 'local_round', 'source_date', 'local_date'])
def test_duplicate_candidates_on_either_side_are_excluded(db, kind):
    local = add_game(db, 1, round_number=None if 'date' in kind else 1)
    verified = source(local)
    other_local, other_source = deepcopy(local), deepcopy(verified)
    other_local['game_id'] = 2
    other_source['source_game_id'] = 'squiggle:other'
    locals_ = [local, other_local] if kind.startswith('local') else [local]
    sources = [verified, other_source] if kind.startswith('source') else [verified]
    assert match_games(locals_, sources) == {}


def test_source_cannot_be_reused_via_round_and_date_paths(db):
    first = add_game(db, 1, round_number=1, date='2025-06-01')
    fallback = add_game(db, 2, round_number=None, date='2025-06-02')
    verified = source(first, local_date='2025-06-02')
    assert match_games([first, fallback], [verified]) == {}


def test_source_final_phase_corrects_local_label_without_any_write(db):
    regular = add_game(db, 1, round_number=1)
    final = add_game(db, 2, round_number=None)
    add_stat(db, 1, value=20)
    add_stat(db, 2, value=30)
    injected = history(source(regular), source(final, game_type='Finals'))
    preserved = deepcopy(injected)
    db.execute('PRAGMA query_only=ON')
    result, club = read_player_impact(db, 1, 'disposals', history=injected, now=NOW)
    aggregate = result['finals']['aggregate']
    assert aggregate['target_games'] == aggregate['baseline_games'] == 1
    assert aggregate['target_mean'] == 30 and aggregate['baseline_mean'] == 20 and aggregate['delta'] == 10
    assert result['history_scope']['source_phase_corrections'] == 1
    assert db.execute('SELECT game_type FROM games WHERE game_id=2').fetchone()[0] == 'Regular Season'
    assert injected == preserved
    assert club is None  # no invented current roster


def test_null_round_opening_game_remains_regular(db):
    opening = add_game(db, 1, round_number=None)
    add_stat(db, 1)
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(opening, round=0)), now=NOW)
    assert result['finals']['per_season'][0]['target_games'] == 0
    assert result['finals']['per_season'][0]['baseline_games'] == 1
    assert result['finals']['aggregate']['available'] is False


def test_null_selected_stat_is_excluded_but_zero_is_observed(db):
    regular, final = add_game(db, 1), add_game(db, 2, round_number=None)
    add_stat(db, 1, kicks=0)
    add_stat(db, 2, kicks=None)
    result, _ = read_player_impact(db, 1, 'kicks', history=history(source(regular), source(final, game_type='Finals')), now=NOW)
    assert result['coverage']['eligible_stat_rows'] == 1
    assert result['coverage']['exclusion_reasons'] == {'missing_stat': 1}
    assert result['finals']['per_season'][0]['baseline_mean'] == 0
    assert result['finals']['aggregate']['available'] is False


def test_older_schema_missing_stat_column_returns_missing_not_false_zero(db):
    local = add_game(db, 1)
    add_stat(db, 1)
    result, _ = read_player_impact(db, 1, 'hit_outs', history=history(source(local)), now=NOW)
    assert result['coverage']['eligible_stat_rows'] == 0
    assert result['coverage']['exclusion_reasons'] == {'missing_stat': 1}


def test_duplicate_player_game_observations_are_all_excluded(db):
    local = add_game(db, 1)
    add_stat(db, 1)
    add_stat(db, 1, value=999)
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(local)), now=NOW)
    assert result['coverage']['eligible_stat_rows'] == 0
    assert result['coverage']['exclusion_reasons'] == {'duplicate_game_id': 2}


def test_mixed_club_season_excluded_while_other_season_survives(db):
    clean = add_game(db, 1, year=2024)
    first = add_game(db, 2, round_number=1)
    second = add_game(db, 3, round_number=2)
    for gid in [1, 2]:
        add_stat(db, gid)
    add_stat(db, 3, team=20, opponent=10)
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(clean), source(first), source(second)), now=NOW)
    assert result['history_scope']['ambiguous_seasons'] == [2025]
    assert result['history_scope']['excluded'] == {'multiple_recorded_clubs_in_season': 2}
    assert result['coverage']['eligible_stat_rows'] == 1


@pytest.mark.parametrize('team,opponent', [(10, 10), (10, 30), (30, 20), (10, None)])
def test_invalid_player_team_or_opponent_is_excluded(db, team, opponent):
    local = add_game(db, 1)
    add_stat(db, 1, team=team, opponent=opponent)
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(local)), now=NOW)
    assert result['history_scope']['excluded'] == {'inconsistent_appearance_team': 1}
    assert result['coverage']['eligible_stat_rows'] == 0


def test_provider_player_id_and_names_are_not_local_player_lookup(db):
    local = add_game(db, 1)
    add_stat(db, 1)
    result, club = read_player_impact(db, 9999, 'disposals', history=history(source(local)), now=NOW)
    assert result['player_name'] is None and result['coverage']['eligible_stat_rows'] == 0
    assert club is None


def test_invalid_stat_rejected_before_sql(db):
    with pytest.raises(ValueError, match='Invalid stat'):
        read_player_impact(db, 1, 'disposals; DROP TABLE games', history=history(), now=NOW)
    assert db.execute('SELECT count(*) FROM games').fetchone()[0] == 0


def test_current_club_needs_current_year_history_and_one_active_club(db):
    local = add_game(db, 1, year=2026)
    add_stat(db, 1)
    injected = history(source(local))
    db.execute("INSERT INTO player_team_history VALUES(1,10,1,'2026-01-01',NULL)")
    result, club = read_player_impact(db, 1, 'disposals', history=injected, now=NOW)
    assert club == 'Brisbane Lions'
    db.execute("INSERT INTO player_team_history VALUES(1,20,1,'2026-01-01',NULL)")
    assert read_player_impact(db, 1, 'disposals', history=injected, now=NOW)[1] is None


def test_current_club_dates_use_melbourne_calendar_day(db):
    local = add_game(db, 1, year=2026)
    add_stat(db, 1)
    db.execute("INSERT INTO player_team_history VALUES(1,10,1,'2026-09-12',NULL)")
    melbourne_september_12 = datetime(2026, 9, 11, 16, tzinfo=timezone.utc)
    _, club = read_player_impact(db, 1, 'disposals', history=history(source(local)), now=melbourne_september_12)
    assert club == 'Brisbane Lions'


def impact_result(db):
    return read_player_impact(db, 1, 'disposals', history=history(), now=NOW)[0]


@pytest.mark.parametrize('shift',[None,0,0.5,-0.5,2,-2,3,-3])
def test_ordinary_upcoming_retains_normalized_venue_clock_context(db,shift):
    game=upcoming('squiggle:next','2026-09-13T09:00:00+00:00')
    game['teams']['squiggle:2']['venue_clock_shift_hours']=shift
    result=attach_upcoming(impact_result(db),'Brisbane Lions',snapshot(game),now=NOW)['upcoming']
    assert result['available'] and result['venue_clock_shift_hours']==shift


def test_ordinary_upcoming_missing_venue_clock_context_stays_null(db):
    game=upcoming('squiggle:next','2026-09-13T09:00:00+00:00')
    result=attach_upcoming(impact_result(db),'Brisbane Lions',snapshot(game),now=NOW)['upcoming']
    assert result['available'] and result['venue_clock_shift_hours'] is None


def upcoming(gid, starts, *, verified=True, state='scheduled', gap=150, distance=800):
    return {'game_id': f'squiggle:{gid}', 'home_team': 'Brisbane Lions', 'away_team': 'Adelaide',
            'home_team_id': 'squiggle:2', 'away_team_id': 'squiggle:1', 'starts_at': starts,
            'state': state, 'schedule_verified': verified, 'venue': 'Gabba',
            'confirmation_source': 'https://www.afl.com.au/finals/tickets/semi-final-2',
            'teams': {'squiggle:2': {'start_gap_hours': gap, 'venue_distance_km': distance}}}


def snapshot(*games, **overrides):
    value = {'status': 'ready', 'stale': False, 'retrieved_at': NOW.isoformat(), 'games': list(games)}
    value.update(overrides)
    return value


def test_earlier_unconfirmed_fixture_prevents_skipping_to_verified_later(db):
    first = upcoming(1, '2026-09-13T09:00:00+00:00', verified=False)
    second = upcoming(2, '2026-09-20T09:00:00+00:00')
    result = attach_upcoming(impact_result(db), 'Brisbane Lions', snapshot(second, first), now=NOW)
    assert result['upcoming']['available'] is False


def test_first_verified_future_fixture_uses_correct_team_context_without_selection_claim(db):
    past = upcoming(1, '2026-09-11T09:00:00+00:00')
    next_ = upcoming(2, '2026-09-13T09:00:00+00:00')
    result = attach_upcoming(impact_result(db), 'Brisbane Lions', snapshot(next_, past), now=NOW)['upcoming']
    assert result['available'] is True and result['game_id'] == 'squiggle:2'
    assert result['rest_bucket'] == '144_to_168h' and result['travel_bucket'] == '500_to_1000km'
    assert 'player selection and actual travel are not confirmed' in result['note']
    assert 'player_selected' not in result


@pytest.mark.parametrize('context', [None, {'status': 'ready', 'stale': True}, {'status': 'unavailable', 'stale': False}])
def test_stale_or_missing_context_cannot_offer_upcoming(db, context):
    assert attach_upcoming(impact_result(db), 'Brisbane Lions', context, now=NOW)['upcoming']['available'] is False


def test_missing_current_club_prevents_guessing_from_upcoming_names(db):
    context = snapshot(upcoming(2, '2026-09-13T09:00:00+00:00'))
    assert attach_upcoming(impact_result(db), None, context, now=NOW)['upcoming']['available'] is False


def test_verified_fixture_with_unknown_metrics_keeps_null_bucket(db):
    context = snapshot(upcoming(2, '2026-09-13T09:00:00+00:00', gap=None, distance=None))
    result = attach_upcoming(impact_result(db), 'Brisbane Lions', context, now=NOW)['upcoming']
    assert result['available'] is True
    assert result['rest_bucket'] is None and result['travel_bucket'] is None


def test_unknown_ground_on_both_sides_is_not_venue_corroboration(db):
    local = add_game(db, 1, venue=3)
    assert match_games([local], [source(local, venue=None)]) == {}


def test_injected_history_avoids_loading_files_and_unknown_context_stays_missing(db, monkeypatch):
    import app.afl_player_context as module
    local = add_game(db, 1)
    add_stat(db, 1, value=0)
    def forbidden():
        raise AssertionError('Injected history must avoid filesystem loading')
    monkeypatch.setattr(module, 'load_history', forbidden)
    db.execute('PRAGMA query_only=ON')
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(local, teams={})), now=NOW)
    assert result['coverage']['eligible_stat_rows'] == 1
    assert result['rest']['coverage']['missing_context_rows'] == 1
    assert result['travel']['coverage']['missing_context_rows'] == 1
    assert result['rest']['coverage']['matched_context_rows'] == 0


def test_future_source_match_cannot_contribute_historical_statistics(db):
    local = add_game(db, 1, year=2026, date='2026-09-20')
    add_stat(db, 1, value=999)
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(local)), now=NOW)
    assert result['coverage']['eligible_stat_rows'] == 0
    assert result['history_scope']['excluded'] == {'unmatched_source_fixture': 1}


def test_future_only_appearance_cannot_corroborate_current_club(db):
    local = add_game(db, 1, year=2026, date='2026-09-20')
    add_stat(db, 1)
    db.execute("INSERT INTO player_team_history VALUES(1,10,1,'2026-01-01',NULL)")
    _, club = read_player_impact(db, 1, 'disposals', history=history(source(local)), now=NOW)
    assert club is None


def test_unsourced_older_season_does_not_contaminate_final_baseline(db):
    older = add_game(db, 1, year=2019)
    regular = add_game(db, 2, year=2025)
    final = add_game(db, 3, year=2025, round_number=None)
    add_stat(db, 1, value=1000)
    add_stat(db, 2, value=20)
    add_stat(db, 3, value=30)
    result, _ = read_player_impact(db, 1, 'disposals',
        history=history(source(regular), source(final, game_type='Finals')), now=NOW)
    assert result['history_scope']['seasons'] == [2025]
    assert result['history_scope']['local_player_rows'] == 2
    assert result['finals']['aggregate']['baseline_mean'] == 20
    assert result['finals']['aggregate']['delta'] == 10


def test_same_name_players_do_not_share_statistics(db):
    local = add_game(db, 1)
    add_stat(db, 1, player=1)
    result, _ = read_player_impact(db, 99, 'disposals', history=history(source(local)), now=NOW)
    assert result['player_name'] == 'Fixture Player'
    assert result['player_id'] == 99
    assert result['coverage']['eligible_stat_rows'] == 0


@pytest.fixture
def impact_api(db, monkeypatch):
    """Exercise the real route without lifespan, network, or writable databases."""
    from fastapi.testclient import TestClient
    from starlette.responses import JSONResponse
    import app.main as main
    import app.afl_context_api as context_api
    import app.afl_player_context as reader

    regular = add_game(db, 1)
    final = add_game(db, 2, round_number=None)
    current = add_game(db, 3, year=2026)
    add_stat(db, 1, value=20)
    add_stat(db, 2, value=30)
    add_stat(db, 3, value=0)
    db.execute("INSERT INTO player_team_history VALUES(1,10,1,'2026-01-01',NULL)")
    db.commit()
    db.execute('PRAGMA query_only=ON')
    supplied_history = history(source(regular), source(final, game_type='Finals'), source(current))
    clock = [NOW]

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0].astimezone(tz) if tz else clock[0].replace(tzinfo=None)

    monkeypatch.setenv('INTERNAL_API_SECRET', 'test-impact-secret')
    monkeypatch.delenv('REQUIRE_INTERNAL_SECRET', raising=False)
    monkeypatch.setattr(main, 'datetime', Clock)
    monkeypatch.setattr(main, 'get_connection', lambda: db)
    monkeypatch.setattr(reader, 'load_history', lambda: supplied_history)
    import app.afl_upcoming_impact as reviewed
    monkeypatch.setattr(reviewed, 'remaining_fixtures', lambda *args, **kwargs: None)
    monkeypatch.setattr(context_api, 'get_context', lambda year: JSONResponse(snapshot()))
    client = TestClient(main.app)  # Deliberately do not enter lifespan/startup.
    client.headers['x-internal-secret'] = 'test-impact-secret'
    yield client, db, main, reader, context_api, clock
    client.close()


@pytest.mark.parametrize('provided', [None, 'wrong-secret'])
def test_impact_api_rejects_missing_or_wrong_internal_secret_before_database(impact_api, monkeypatch, provided):
    client, _, main, *_ = impact_api
    def forbidden():
        raise AssertionError('Unauthorized request accessed the database')
    monkeypatch.setattr(main, 'get_connection', forbidden)
    client.headers.pop('x-internal-secret')
    response = client.get('/search/player-impact', params={'player_id': 1, 'stat': 'disposals'},
                          headers={} if provided is None else {'x-internal-secret': provided})
    assert response.status_code == 401
    assert response.json() == {'detail': 'Unauthorized'}


def test_impact_api_missing_deployed_secret_fails_closed(impact_api, monkeypatch):
    client, _, main, *_ = impact_api
    monkeypatch.delenv('INTERNAL_API_SECRET')
    monkeypatch.setenv('REQUIRE_INTERNAL_SECRET', 'true')
    def forbidden():
        raise AssertionError('Unconfigured deployed request accessed the database')
    monkeypatch.setattr(main, 'get_connection', forbidden)
    response = client.get('/search/player-impact', params={'player_id': 1, 'stat': 'disposals'})
    assert response.status_code == 503
    assert response.json() == {'detail': 'Search is temporarily unavailable'}


def test_impact_api_invalid_stat_rejected_before_database(impact_api, monkeypatch):
    client, _, main, *_ = impact_api
    def forbidden():
        raise AssertionError('Invalid stat accessed the database')
    monkeypatch.setattr(main, 'get_connection', forbidden)
    response = client.get('/search/player-impact', params={'player_id': 1, 'stat': 'disposals; DROP TABLE players'})
    assert response.status_code == 400
    assert response.json() == {'detail': 'Invalid stat'}


@pytest.mark.parametrize('identity', [{}, {'player_id': 1, 'player_name': 'Fixture Player'}])
def test_impact_api_requires_exactly_one_identity(impact_api, identity):
    response = impact_api[0].get('/search/player-impact', params={'stat': 'disposals', **identity})
    assert response.status_code == 400
    assert response.json() == {'detail': 'Provide exactly one of player_id or player_name'}


def test_impact_api_missing_required_stat_is_validation_error(impact_api):
    response = impact_api[0].get('/search/player-impact', params={'player_id': 1})
    assert response.status_code == 422


def test_impact_api_exact_name_resolves_local_record_and_returns_read_only_sourced_history(impact_api):
    client, db, *_ = impact_api
    changes = db.total_changes
    response = client.get('/search/player-impact', params={'player_name': 'fixture player', 'stat': 'disposals'})
    assert response.status_code == 200
    body = response.json()
    assert body['player_id'] == 1 and body['player_name'] == 'Fixture Player'
    assert body['coverage']['eligible_stat_rows'] == 3
    assert body['finals']['aggregate']['delta'] == 10
    assert body['history_scope']['source_phase_corrections'] == 1
    assert body['sources'][0]['source_url'] == 'https://api.squiggle.com.au/?q=games&year=2025'
    assert db.execute('PRAGMA query_only').fetchone()[0] == 1
    assert db.total_changes == changes
    assert db.execute('SELECT game_type FROM games WHERE game_id=2').fetchone()[0] == 'Regular Season'


def test_impact_api_explicit_local_id_does_not_remap_same_name_or_provider_id(impact_api):
    response = impact_api[0].get('/search/player-impact', params={'player_id': 99, 'stat': 'disposals'})
    assert response.status_code == 200
    body = response.json()
    assert body['player_id'] == 99 and body['player_name'] == 'Fixture Player'
    assert body['coverage']['eligible_stat_rows'] == 0
    assert body['upcoming']['available'] is False


def test_impact_api_unknown_name_does_not_fuzzy_match(impact_api):
    response = impact_api[0].get('/search/player-impact', params={'player_name': 'Fixture', 'stat': 'disposals'})
    assert response.status_code == 404
    assert response.json() == {'detail': 'Player not found'}


@pytest.mark.parametrize('failure', [OSError('private path /volume/history.json'), sqlite3.DatabaseError('private SQL details')])
def test_impact_api_history_failures_return_503_without_partial_data_or_internal_details(impact_api, monkeypatch, failure):
    client, _, _, reader, *_ = impact_api
    def failed_history():
        raise failure
    monkeypatch.setattr(reader, 'load_history', failed_history)
    response = client.get('/search/player-impact', params={'player_id': 1, 'stat': 'disposals'})
    assert response.status_code == 503
    assert response.json() == {'detail': 'Player impact history is temporarily unavailable'}


def test_impact_api_schedule_unavailable_preserves_history_and_withholds_upcoming(impact_api, monkeypatch):
    from starlette.responses import JSONResponse
    client, _, _, _, context_api, _ = impact_api
    monkeypatch.setattr(context_api, 'get_context', lambda year: JSONResponse({'error': 'unavailable'}, status_code=503))
    response = client.get('/search/player-impact', params={'player_id': 1, 'stat': 'disposals'})
    assert response.status_code == 200
    assert response.json()['finals']['aggregate']['delta'] == 10
    assert response.json()['upcoming']['available'] is False
    assert 'fresh, verified fixture snapshot is unavailable' in response.json()['upcoming']['reason']


def test_impact_api_rechecks_clock_after_schedule_refresh(impact_api, monkeypatch):
    from datetime import timedelta
    from starlette.responses import JSONResponse
    client, _, _, _, context_api, clock = impact_api
    starts = NOW + timedelta(seconds=30)
    def refresh(year):
        assert year == 2026
        clock[0] = NOW + timedelta(seconds=40)
        return JSONResponse(snapshot(upcoming(2, starts.isoformat())))
    monkeypatch.setattr(context_api, 'get_context', refresh)
    response = client.get('/search/player-impact', params={'player_id': 1, 'stat': 'disposals'})
    assert response.status_code == 200
    assert response.json()['upcoming']['available'] is False


def add_full_stat_columns(db):
    for column in ('goals', 'marks', 'tackles', 'handballs', 'clearances', 'hit_outs'):
        db.execute(f'ALTER TABLE player_game_stats ADD COLUMN {column} INTEGER DEFAULT 0')


def test_all_eight_known_zero_flags_sensitivity_without_changing_recorded_primary(db):
    add_full_stat_columns(db)
    regular = add_game(db, 1)
    final = add_game(db, 2, round_number=None)
    add_stat(db, 1, value=20)
    add_stat(db, 2, value=0, kicks=0)
    db.execute('PRAGMA query_only=ON')
    result, _ = read_player_impact(db, 1, 'disposals',
        history=history(source(regular), source(final, game_type='Finals')), now=NOW)
    assert result['data_quality']['unverified_participation_rows'] == 1
    assert result['coverage']['eligible_stat_rows'] == 2
    season = result['finals']['per_season'][0]
    assert season['target_games'] == 1 and season['target_mean'] == 0
    assert season['baseline_mean'] == 20
    assert season['without_unverified_participation']['target_games'] == 0
    assert 'does not establish DNP status' in result['data_quality']['sensitivity_method']
    assert db.execute('SELECT COUNT(*) FROM player_game_stats').fetchone()[0] == 2


def test_selected_zero_with_another_positive_stat_has_no_participation_flag(db):
    add_full_stat_columns(db)
    local = add_game(db, 1)
    add_stat(db, 1, value=0, kicks=0)
    db.execute('UPDATE player_game_stats SET tackles=1')
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(local)), now=NOW)
    assert result['data_quality']['unverified_participation_rows'] == 0
    assert result['coverage']['eligible_stat_rows'] == 1
    season = result['finals']['per_season'][0]
    assert season['baseline_mean'] == 0
    assert 'without_unverified_participation' not in season


def test_unknown_extended_stat_cannot_become_all_eight_zero_participation_flag(db):
    add_full_stat_columns(db)
    local = add_game(db, 1)
    add_stat(db, 1, value=0, kicks=0)
    db.execute('UPDATE player_game_stats SET handballs=NULL,clearances=NULL,hit_outs=NULL')
    result, _ = read_player_impact(db, 1, 'disposals', history=history(source(local)), now=NOW)
    assert result['data_quality']['unverified_participation_rows'] == 0
    assert result['coverage']['eligible_stat_rows'] == 1
    assert result['finals']['per_season'][0]['baseline_mean'] == 0


@pytest.fixture
def verified_recent_club(db):
    import json
    local = add_game(db, 1, year=2026, date='2026-09-05')
    db.execute("UPDATE games SET game_type='Finals' WHERE game_id=1")
    add_stat(db, 1)
    db.execute("INSERT INTO player_team_history VALUES(1,10,1,'2019-01-01','2013-12-31')")
    db.execute('CREATE TABLE afl_verified_final_imports(applied_at TEXT,receipt_json TEXT)')
    entry = {'player_id': 1, 'player_name': 'Fixture Player', 'api_game_id': 50001,
             'imported_team_id': 10, 'identity_source': {
                 'source_url': 'https://www.lions.com.au/teams/afl',
                 'retrieved_at': '2026-09-11T00:00:00+00:00', 'source_sha256': 'a'*64}}
    def put(value=entry, applied='2026-09-11T00:00:00+00:00'):
        db.execute('DELETE FROM afl_verified_final_imports')
        db.execute('INSERT INTO afl_verified_final_imports VALUES(?,?)',
                   (applied, json.dumps({'source_identity_overrides': [value]})))
    put()
    return history(source(local, game_type='Finals')), entry, put


def test_recent_verified_club_corroborates_corrupt_dates_without_writes(db, verified_recent_club):
    data, _, _ = verified_recent_club
    writes = db.total_changes
    result, club = read_player_impact(db, 1, 'disposals', history=data, now=NOW)
    assert club == 'Brisbane Lions'
    assert result['current_club_evidence']['method'] == 'recent_verified_finals_import'
    assert result['current_club_evidence']['api_game_id'] == 50001
    assert 'selection is not confirmed' in result['current_club_evidence']['note']
    assert db.total_changes == writes
    assert db.execute('SELECT end_date FROM player_team_history').fetchone()[0] == '2013-12-31'


@pytest.mark.parametrize('change', [
    {'player_id': 99}, {'player_name': 'Other Player'}, {'api_game_id': 50002},
    {'imported_team_id': 20},
    {'identity_source': {'source_url': 'https://fake.lions.com.au.example.org/',
                         'retrieved_at': '2026-09-11T00:00:00Z', 'source_sha256': 'a'*64}},
    {'identity_source': {'source_url': 'https://www.lions.com.au/teams/afl',
                         'retrieved_at': '2026-08-01T00:00:00Z', 'source_sha256': 'a'*64}},
])
def test_recent_verified_club_rejects_nonmatching_or_stale_receipt(db, verified_recent_club, change):
    data, entry, put = verified_recent_club
    put({**entry, **change})
    result, club = read_player_impact(db, 1, 'disposals', history=data, now=NOW)
    assert club is None
    assert 'current_club_evidence' not in result


@pytest.mark.parametrize('applied', ['2026-08-01T00:00:00Z', '2026-09-13T00:00:00Z'])
def test_recent_verified_club_rejects_stale_or_future_import(db, verified_recent_club, applied):
    data, entry, put = verified_recent_club
    put(entry, applied=applied)
    assert read_player_impact(db, 1, 'disposals', history=data, now=NOW)[1] is None


@pytest.mark.parametrize('teams', [(20,), (10, 20)])
def test_recent_verified_club_never_overrides_conflicting_active_clubs(db, verified_recent_club, teams):
    data, _, _ = verified_recent_club
    for team in teams:
        db.execute('INSERT INTO player_team_history VALUES(1,?,1,NULL,NULL)', (team,))
    assert read_player_impact(db, 1, 'disposals', history=data, now=NOW)[1] is None


@pytest.mark.parametrize('case', ['latest_changed', 'duplicate_latest', 'not_final', 'mixed_club', 'malformed'])
def test_recent_verified_club_requires_unambiguous_latest_final(db, verified_recent_club, case):
    data, _, put = verified_recent_club
    if case == 'latest_changed':
        latest = add_game(db, 2, year=2026, date='2026-09-10', round_number=2)
        add_stat(db, 2)
        data['seasons'][0]['games'].append(source(latest))
    elif case == 'duplicate_latest':
        add_stat(db, 1)
    elif case == 'not_final':
        db.execute("UPDATE games SET game_type='Regular Season' WHERE game_id=1")
    elif case == 'mixed_club':
        latest = add_game(db, 2, year=2026, date='2026-08-01', round_number=2)
        add_stat(db, 2, team=20, opponent=10)
        data['seasons'][0]['games'].append(source(latest))
    else:
        put(None)
    assert read_player_impact(db, 1, 'disposals', history=data, now=NOW)[1] is None


def test_reader_transition_uses_club_fixture_when_player_missed_previous(db):
    previous = add_game(db, 1, year=2026, date='2026-06-01')
    current = add_game(db, 2, year=2026, round_number=2, date='2026-06-08', home=20, away=10)
    add_stat(db, 2)
    data = history(source(previous), source(current))
    unchanged = deepcopy(data)
    result, _ = read_player_impact(db, 1, 'disposals', history=data, now=NOW)
    target = next(t for t in result['travel']['transitions'] if t['key'] == 'home_to_away')
    assert target['coverage']['eligible_stat_rows'] == 1
    assert data == unchanged


@pytest.mark.parametrize('phase,expected', [(True,'Finals'),(False,'Regular Season'),(None,None)])
def test_upcoming_phase_is_explicit_source_classification(db,phase,expected):
    game=upcoming(2,'2026-09-13T09:00:00+00:00')
    game['is_final']=phase
    result=attach_upcoming(impact_result(db),'Brisbane Lions',snapshot(game),now=NOW)
    assert result['upcoming']['game_type']==expected
