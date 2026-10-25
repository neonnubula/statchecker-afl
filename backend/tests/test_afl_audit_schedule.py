"""Schedule reconciliation must never guess joins or change source data."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from scripts.afl_audit_schedule import audit


@pytest.fixture
def conn():
    db = sqlite3.connect(':memory:')
    db.executescript('''
        CREATE TABLE teams(team_id INTEGER, team_name TEXT);
        INSERT INTO teams VALUES(1,'Geelong Cats'),(2,'Brisbane Lions');
        CREATE TABLE games(game_id INTEGER,season_year INTEGER,round_number INTEGER,
          game_date TEXT,game_time TEXT,game_type TEXT,home_team_id INTEGER,away_team_id INTEGER);
        INSERT INTO games VALUES(8,2026,17,'2026-07-01','14:00','Regular Season',1,2);
        CREATE TABLE fixtures(fixture_id INTEGER,season_year INTEGER,round_number INTEGER,
          game_date TEXT,game_time TEXT,home_team_id INTEGER,away_team_id INTEGER);
        INSERT INTO fixtures VALUES(9,2026,17,NULL,NULL,1,2);
        CREATE TABLE player_game_stats(game_id INTEGER);
        INSERT INTO player_game_stats VALUES(8),(8);
    ''')
    yield db
    db.close()


def source(**overrides):
    row = dict(id=80, year=2026, round=17, hteam='Geelong', ateam='Brisbane Lions',
               is_final=0, complete=100, localtime='2026-07-02 19:30:00',
               unixtime=1782984600, venue='Kardinia Park')
    row.update(overrides)
    return {'payload': {'games': [row]}}


def test_unique_club_mapping_proposes_dates_and_counts_existing_players(conn):
    before = conn.execute('SELECT * FROM games').fetchall()
    result = audit(conn, source(), 2026)
    assert result['summary']['games']['date_discrepancies'] == 1
    assert result['summary']['fixtures']['date_discrepancies'] == 1
    assert result['summary']['games']['affected_existing_player_rows'] == 2
    item = result['candidates'][0]['tables']['games']
    assert item['differences'] == {'game_date': {'old': '2026-07-01', 'candidate': '2026-07-02'}}
    assert [tuple(r) for r in conn.execute('SELECT * FROM games')] == before


@pytest.mark.parametrize('change', [{'hteam': 'Geelong??'}, {'ateam': None}, {'round': None}])
def test_unknown_team_or_round_is_unresolved(conn, change):
    result = audit(conn, source(**change), 2026)
    assert result['summary']['unresolved_source_records'] == 1
    assert result['candidates'] == []
    assert len(result['unmatched_local']['games']) == 1


def test_reversed_home_away_does_not_guess_join(conn):
    result = audit(conn, source(hteam='Brisbane Lions', ateam='Geelong'), 2026)
    assert result['summary']['games']['source_missing_locally'] == 1
    assert result['summary']['games']['affected_existing_player_rows'] == 0


@pytest.mark.parametrize('same_id', [True, False])
def test_duplicate_source_id_or_tuple_blocks_candidates(conn, same_id):
    envelope = source()
    duplicate = copy.deepcopy(envelope['payload']['games'][0])
    if not same_id:
        duplicate['id'] = 81
    envelope['payload']['games'].append(duplicate)
    result = audit(conn, envelope, 2026)
    assert result['summary']['unresolved_source_records'] == 2
    assert result['candidates'] == []


def test_duplicate_local_tuple_is_ambiguous(conn):
    conn.execute("INSERT INTO games SELECT 10,season_year,round_number,game_date,game_time,game_type,home_team_id,away_team_id FROM games")
    result = audit(conn, source(), 2026)
    assert result['summary']['games']['ambiguous_source_matches'] == 1
    assert result['summary']['games']['date_discrepancies'] == 0
    assert result['candidates'][0]['tables']['games'] == {'status': 'ambiguous', 'candidate_ids': [8, 10]}


def test_missing_completed_final_is_separate_from_unknown_future_final(conn):
    envelope = source(round=26, is_final=3)
    envelope['payload']['games'].append(source(id=81, round=28, is_final=5, ateam=None, complete=0)['payload']['games'][0])
    result = audit(conn, envelope, 2026)
    assert result['summary']['source_finals'] == 2
    assert result['summary']['source_completed_finals'] == 1
    assert result['summary']['games']['completed_finals_missing'] == 1
    assert result['summary']['unresolved_source_records'] == 1


def test_classification_discrepancy_only_on_unique_join(conn):
    result = audit(conn, source(is_final=3), 2026)
    assert result['summary']['games']['finals_classification_discrepancies'] == 1
    assert result['summary']['games']['affected_existing_player_rows'] == 2


def test_invalid_timestamp_and_wrong_year_not_joined(conn):
    result = audit(conn, source(localtime='TBC'), 2026)
    assert result['unresolved_source'][0]['reason'] == 'invalid_source_start'
    result = audit(conn, source(year=2025), 2026)
    assert result['summary']['source_games'] == 0


def test_cli_only_reads_database_and_source(conn, tmp_path):
    db_path = tmp_path / 'input.db'
    conn.commit()
    with sqlite3.connect(db_path) as destination:
        conn.backup(destination)
    source_path = tmp_path / 'source.json'
    source_path.write_text(json.dumps(source()))
    before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (db_path, source_path)]
    script = Path(__file__).parents[1] / 'scripts/afl_audit_schedule.py'
    result = subprocess.run([sys.executable, str(script), '--db', str(db_path), '--source', str(source_path)], check=True, capture_output=True, text=True)
    assert json.loads(result.stdout)['summary']['games']['date_discrepancies'] == 1
    assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in (db_path, source_path)] == before
