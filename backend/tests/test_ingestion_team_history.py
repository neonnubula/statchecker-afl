"""Historical imports must not turn the current roster backwards in time."""
from pathlib import Path
import sqlite3

import pytest

from database.db_manager_api import DatabaseManager


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "history.db"
    with sqlite3.connect(path) as conn:
        conn.executescript((Path(__file__).parents[1] / "database/schema.sql").read_text())
        conn.execute("INSERT INTO players (player_id, player_name) VALUES (1, 'Fixture Player')")
        conn.executemany("INSERT INTO teams (team_id, team_name) VALUES (?, ?)", [(1, 'First'), (2, 'Second')])
        conn.execute("INSERT INTO venues (venue_id, venue_name) VALUES (1, 'Fixture Ground')")
    with DatabaseManager(str(path)) as manager:
        yield manager


def ingest(db, game_id, date, team=1):
    db.conn.execute("INSERT OR IGNORE INTO games (game_id, season_year, game_type, game_date, venue_id, home_team_id, away_team_id) VALUES (?, ?, 'Regular Season', ?, 1, 1, 2)", (game_id, int(date[:4]), date))
    db.conn.commit()
    return db.insert_player_stats(1, game_id, team, 3-team, 1, 'Home' if team == 1 else 'Away', 'Day', 12, 0, marks=3, tackles=2)


def history(db):
    return [tuple(r) for r in db.conn.execute("SELECT team_id, start_date, end_date, is_current FROM player_team_history ORDER BY history_id")]


def roster(db, team, date):
    db.conn.execute("INSERT INTO player_team_history (player_id, team_id, start_date, is_current) VALUES (1, ?, ?, 1)", (team, date))
    db.conn.commit()


def test_older_match_preserves_newer_team_and_still_imports_stats(db):
    ingest(db, 10, '2026-05-10', 2)
    before = history(db)
    ingest(db, 99, '2025-08-10', 1)
    assert history(db) == before
    assert db.conn.execute('SELECT COUNT(*) FROM player_game_stats').fetchone()[0] == 2


def test_same_date_other_team_cannot_rewrite_current_history(db):
    ingest(db, 10, '2026-05-10', 2)
    before = history(db)
    ingest(db, 11, '2026-05-10', 1)
    assert history(db) == before  # identity conflict requires separate review
    assert [tuple(r) for r in db.conn.execute(
        'SELECT game_id, team_id FROM player_game_stats ORDER BY game_id'
    )] == [(10, 2), (11, 1)]


def test_newer_match_advances_team_once_even_with_lower_game_id(db):
    ingest(db, 99, '2025-08-10', 1)
    stat_id = ingest(db, 1, '2026-05-10', 2)
    assert history(db) == [(1, '2025-08-10', '2026-05-10', 0), (2, '2026-05-10', None, 1)]
    assert ingest(db, 1, '2026-05-10', 2) == stat_id
    assert len(history(db)) == 2


@pytest.mark.parametrize('game_date', ['2025-08-10', '2026-01-01'])
def test_first_historical_stat_preserves_existing_newer_roster(db, game_date):
    roster(db, 2, '2026-01-01')
    before = history(db)
    ingest(db, 1, game_date, 1)
    assert history(db) == before


def test_existing_roster_same_team_does_not_get_duplicate_current_row(db):
    roster(db, 2, '2026-01-01')
    before = history(db)
    ingest(db, 1, '2026-05-10', 2)
    assert history(db) == before


def test_roster_newer_than_last_stat_is_respected(db):
    ingest(db, 1, '2024-08-10', 1)
    db.conn.execute("UPDATE player_team_history SET is_current=0, end_date='2026-01-01'")
    roster(db, 2, '2026-01-01')
    before = history(db)
    ingest(db, 2, '2025-08-10', 1)
    assert history(db) == before


def test_new_match_after_roster_can_record_a_later_team_change(db):
    roster(db, 1, '2025-01-01')
    ingest(db, 1, '2026-05-10', 2)
    assert history(db) == [(1, '2025-01-01', '2026-05-10', 0), (2, '2026-05-10', None, 1)]
