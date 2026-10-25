"""
Tests for api_player_id_aliases ingestion behaviour.

Covers `DatabaseManager.get_or_create_player`'s four resolution branches
using an isolated in-memory / tmp SQLite DB seeded with schema + minimal
fixtures. No dependency on the production DB.
"""

import os
import sqlite3
import sys
import tempfile

import pytest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from database.db_manager_api import DatabaseManager  # noqa: E402

SCHEMA_DIR = os.path.join(PROJECT_ROOT, "database")


def _apply_sql(conn: sqlite3.Connection, filename: str) -> None:
    path = os.path.join(SCHEMA_DIR, filename)
    with open(path) as f:
        conn.executescript(f.read())


@pytest.fixture
def fresh_db(tmp_path):
    """Build a minimal DB from schema + aliases migration, seed 2 teams."""
    db_path = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_path)
    _apply_sql(conn, "schema.sql")
    conn.execute("INSERT INTO teams (team_id, team_name, is_active) VALUES (1, 'Sydney Swans', 1)")
    conn.execute("INSERT INTO teams (team_id, team_name, is_active) VALUES (2, 'Carlton Blues', 1)")
    conn.commit()
    conn.close()
    yield db_path


def _set_current_team(db: DatabaseManager, player_id: int, team_id: int):
    db.conn.execute(
        "INSERT INTO player_team_history (player_id, team_id, start_date, is_current) "
        "VALUES (?, ?, ?, 1)",
        (player_id, team_id, "2026-01-01"),
    )
    db.conn.commit()


def test_branch1_api_id_direct_hit(fresh_db):
    db = DatabaseManager(fresh_db)
    pid = db.get_or_create_player(player_name="Isaac Heeney", api_player_id=1001)
    pid_again = db.get_or_create_player(player_name="Isaac Heeney", api_player_id=1001)
    assert pid == pid_again
    count = db.conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    assert count == 1


def test_branch2_alias_returns_canonical(fresh_db):
    db = DatabaseManager(fresh_db)
    canonical = db.get_or_create_player(player_name="Bailey Smith", api_player_id=1536)
    # Manually install an alias, as the merge script would.
    db._add_api_alias(1999, canonical, reason="test")
    resolved = db.get_or_create_player(player_name="Bailey Smith", api_player_id=1999)
    assert resolved == canonical
    count = db.conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    assert count == 1, "alias hit must not create a new row"


def test_branch3_name_plus_team_match_creates_alias(fresh_db):
    db = DatabaseManager(fresh_db)
    canonical = db.get_or_create_player(player_name="Bailey Smith", api_player_id=1536)
    _set_current_team(db, canonical, team_id=1)

    resolved = db.get_or_create_player(
        player_name="Bailey Smith", api_player_id=1999, team_id=1
    )
    assert resolved == canonical

    count = db.conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    assert count == 1
    alias_canon = db.conn.execute(
        "SELECT canonical_player_id FROM api_player_id_aliases WHERE alias_api_player_id = ?",
        (1999,),
    ).fetchone()[0]
    assert alias_canon == canonical


def test_branch4_name_match_different_team_creates_new_row(fresh_db):
    db = DatabaseManager(fresh_db)
    original = db.get_or_create_player(player_name="Callum Mills", api_player_id=1848)
    _set_current_team(db, original, team_id=1)  # Sydney

    new_pid = db.get_or_create_player(
        player_name="Callum Mills", api_player_id=1055, team_id=2  # Carlton
    )
    assert new_pid != original

    count = db.conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    assert count == 2
    alias_rows = db.conn.execute("SELECT COUNT(*) FROM api_player_id_aliases").fetchone()[0]
    assert alias_rows == 0, "no alias should be inserted when teams differ"


def test_branch4_name_match_unknown_team_creates_new_row(fresh_db):
    """If we can't confirm team match (team_id not passed), fall through to new row."""
    db = DatabaseManager(fresh_db)
    original = db.get_or_create_player(player_name="Harry Schoenberg", api_player_id=991)
    _set_current_team(db, original, team_id=1)

    # team_id omitted — cautious branch should create new row
    new_pid = db.get_or_create_player(
        player_name="Harry Schoenberg", api_player_id=1814
    )
    assert new_pid != original


def test_alias_table_exists_after_migration(fresh_db):
    db = DatabaseManager(fresh_db)
    assert db._alias_table_exists() is True
