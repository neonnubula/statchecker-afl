from datetime import datetime
import sqlite3

import pytest

import app.afl_fixture_overlay as overlay


@pytest.fixture
def db():
    conn = sqlite3.connect(':memory:')
    conn.executescript('''CREATE TABLE teams(team_id INTEGER,team_name TEXT);
        CREATE TABLE venues(venue_id INTEGER,venue_name TEXT);''')
    yield conn
    conn.close()


def test_missing_overlay_file_disables_overlay(db, monkeypatch, tmp_path):
    monkeypatch.setattr(overlay, 'DATA_PATH', tmp_path / 'absent.json')
    assert overlay.remaining_fixtures(db, now=datetime.fromisoformat('2026-09-12T12:00:00+10:00')) is None


@pytest.mark.parametrize('data', [
    {'schema_version': 2, 'season': 2026},
    {'schema_version': 1, 'season': '2026'},
])
def test_invalid_overlay_shape_is_rejected(db, data):
    with pytest.raises(ValueError):
        overlay.remaining_fixtures(db, now=datetime.fromisoformat('2026-09-12T12:00:00+10:00'), data=data)
