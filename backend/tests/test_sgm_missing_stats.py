"""Unknown observations must not become losses or inflate research samples."""
import sqlite3

import pytest

from app.main import _fetch_over_under, _fetch_sgm, _fetch_sgm_game_log


@pytest.fixture
def db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript('''
        CREATE TABLE games (game_id INTEGER, game_date TEXT, season_year INTEGER,
                            round_number INTEGER, game_type TEXT);
        CREATE TABLE teams (team_id INTEGER, team_name TEXT);
        CREATE TABLE venues (venue_id INTEGER, venue_name TEXT);
        CREATE TABLE player_game_stats (
            player_id INTEGER, game_id INTEGER, team_id INTEGER,
            opponent_team_id INTEGER, venue_id INTEGER, location TEXT,
            disposals INTEGER, goals INTEGER, marks INTEGER, tackles INTEGER,
            kicks INTEGER, handballs INTEGER, clearances INTEGER, hit_outs INTEGER);
        INSERT INTO teams VALUES (2, 'Opponent');
        INSERT INTO venues VALUES (1, 'Ground');
    ''')
    # Complete win, genuine zero loss, missing first leg, missing second leg.
    for game, kicks in enumerate([(5, 5), (0, 5), (None, 5), (5, None)], start=1):
        conn.execute("INSERT INTO games VALUES (?, ?, 2026, ?, 'Regular Season')",
                     (game, f'2026-04-{game:02d}', game))
        for player, value in enumerate(kicks, start=1):
            conn.execute('INSERT INTO player_game_stats VALUES (?, ?, 1, 2, 1, ?, 10, 0, 2, 1, ?, 5, 1, 0)',
                         (player, game, 'Home', value))
    yield conn
    conn.close()


def selections(count=2):
    return [dict(player_id=p, player_name=f'Player {p}', stat='kicks',
                 threshold=1, strict_over=False) for p in range(1, count+1)]


FILTERS = dict(season_from=None, season_to=None, date_from=None, date_to=None,
               location=None, opponent=None, venue=None, game_type=None)


@pytest.mark.parametrize('mode', ['win_loss', 'over_under'])
def test_missing_either_leg_excluded_but_zero_counts_as_loss(db, mode):
    result = _fetch_sgm(db, selections=selections(), bet_mode=mode, **FILTERS)
    assert result['total'] == 2
    assert sum(result['outcomes'].values()) == 2
    if mode == 'win_loss':
        assert result['outcomes'] == {'win': 1, 'loss': 1}
    else:
        assert result['outcomes'] == {'under_under': 0, 'under_over': 1,
                                      'over_under': 0, 'over_over': 1}


def test_game_log_and_aggregate_use_same_known_sample(db):
    result = _fetch_sgm_game_log(db, selections=selections(), **FILTERS)
    assert result['total'] == 2
    assert result['all_hit_count'] == 1
    assert [g.game_date for g in result['games']] == ['2026-04-02', '2026-04-01']
    assert result['games'][0].players[0].stat_value == 0
    assert result['games'][0].players[0].hit is False


def test_one_leg_sgm_matches_single_player_missing_stat_handling(db):
    result = _fetch_sgm(db, selections=selections(1), bet_mode='over_under', **FILTERS)
    single = _fetch_over_under(db, player_id=1, stat='kicks', strict_over=False,
                              threshold=1, **FILTERS)
    assert result['total'] == 3
    assert result['outcomes'] == single == {'over': 2, 'under': 1}


def test_missing_unselected_stat_does_not_exclude_known_stat(db):
    legs = selections()
    for leg in legs:
        leg['stat'] = 'disposals'
    result = _fetch_sgm(db, selections=legs, bet_mode='win_loss', **FILTERS)
    assert result == {'total': 4, 'outcomes': {'win': 4, 'loss': 0}}


def test_all_unknown_sample_returns_no_results(db):
    db.execute('UPDATE player_game_stats SET kicks = NULL WHERE player_id = 2')
    result = _fetch_sgm(db, selections=selections(), bet_mode='win_loss', **FILTERS)
    assert result == {'total': 0, 'outcomes': {'win': 0, 'loss': 0}}
    assert _fetch_sgm_game_log(db, selections=selections(), **FILTERS) == {
        'games': [], 'total': 0, 'all_hit_count': 0}
