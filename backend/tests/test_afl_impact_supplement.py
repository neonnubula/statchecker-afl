"""Synthetic, read-only regressions for the bounded historical stat supplement.

Test IDs, names and statistics are fixtures, never source-acquisition evidence.
"""
import sqlite3

import pytest

from app.afl_impact_supplement import get_supplemental_appearances

STATS = ("disposals", "goals", "marks", "tackles", "kicks", "handballs", "clearances", "hit_outs")


@pytest.fixture
def supplement_case():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE players(player_id INTEGER PRIMARY KEY,api_player_id INTEGER,player_name TEXT);
        CREATE TABLE teams(team_id INTEGER PRIMARY KEY,api_team_id INTEGER,team_name TEXT);
        INSERT INTO teams VALUES(10,1,'Brisbane Lions'),(20,2,'Adelaide Crows');
        CREATE TABLE games(game_id INTEGER PRIMARY KEY,api_game_id INTEGER,season_year INTEGER,
            game_date TEXT,round_number INTEGER,game_type TEXT,home_team_id INTEGER,away_team_id INTEGER);
        INSERT INTO games VALUES(1,649,2013,'2013-07-27',NULL,'Regular Season',10,20),
            (2,648,2013,'2013-07-20',NULL,'Regular Season',10,20);
        CREATE TABLE player_game_stats(player_id INTEGER,game_id INTEGER,team_id INTEGER,
            opponent_team_id INTEGER,disposals INTEGER,goals INTEGER,marks INTEGER,tackles INTEGER,
            kicks INTEGER,handballs INTEGER,clearances INTEGER,hit_outs INTEGER);
        INSERT INTO player_game_stats VALUES(101,2,10,20,20,1,2,3,10,10,1,0);
    """)
    db.executemany("INSERT INTO players VALUES(?,?,?)", [(100+i, 1000+i, f"Synthetic Player {i}") for i in range(1, 45)])
    local_games = [dict(g) for g in db.execute("""SELECT g.*,h.team_name home_name,a.team_name away_name,
        'Unknown' venue_name FROM games g JOIN teams h ON h.team_id=g.home_team_id
        JOIN teams a ON a.team_id=g.away_team_id""")]
    matched = {1: {"source_game_id": "squiggle:12345", "season": 2013, "local_date": "2013-07-27",
        "home": "Brisbane Lions", "away": "Adelaide", "game_type": "Finals", "venue": "Gabba",
        "teams": {"Brisbane Lions": {"start_gap_hours": 168, "venue_distance_km": 0}}}}
    rows = [{"api_player_id": 1000+i, "api_team_id": 1 if i <= 22 else 2,
             "disposals": 20, "goals": 1, "marks": 2, "tackles": 3,
             "kicks": 10, "handballs": 10, "clearances": 1, "hit_outs": 0} for i in range(1, 45)]
    game = {"api_game_id": 649, "season": 2013, "local_date": "2013-07-27",
        "provider_date": "2013-07-27T00:00:00+00:00",
        "home": {"api_team_id": 1, "name": "Brisbane Lions"},
        "away": {"api_team_id": 2, "name": "Adelaide Crows"},
        "source_url": "https://v1.afl.api-sports.io/games/statistics/players?id=649",
        "retrieved_at": "2026-09-11T22:47:37+00:00", "source_sha256": "a" * 64,
        "schedule_source": {"source_url": "https://v1.afl.api-sports.io/games?season=2013&league=1",
                            "retrieved_at": "2026-09-11T22:47:30+00:00", "source_sha256": "b" * 64},
        "rows": rows}
    supplement = {"schema_version": 1, "source": "api-sports", "seasons": [2013], "games": [game]}
    try:
        yield db, local_games, matched, supplement
    finally:
        db.close()


def run(case, *, player_id=101, stat="disposals"):
    db, local_games, matched, supplement = case
    return get_supplemental_appearances(db, player_id, stat, local_games, matched, supplement=supplement)


def test_supplement_adds_only_requested_player_and_performs_no_database_write(supplement_case):
    db, _, _, _ = supplement_case
    before = list(db.iterdump())
    db.execute("PRAGMA query_only=ON")
    rows, report = run(supplement_case)
    assert len(rows) == report["rows_added"] == 1
    appearance = rows[0]
    assert {key: appearance[key] for key in ("game_id", "team_id", "opponent_team_id", "season_year", "stat_value")} == {
        "game_id": 1, "team_id": 10, "opponent_team_id": 20, "season_year": 2013, "stat_value": 20}
    assert {key: appearance["observed_"+key] for key in STATS} == {
        key: supplement_case[3]["games"][0]["rows"][0][key] for key in STATS}
    assert "game_type" not in appearance and "context" not in appearance
    assert len(report["sources"]) == 1
    assert list(db.iterdump()) == before


def test_zero_any_player_rows_rule_prevents_partial_game_top_up(supplement_case):
    db = supplement_case[0]
    db.execute("INSERT INTO player_game_stats VALUES(102,1,10,20,1,0,0,0,1,0,0,0)")
    rows, report = run(supplement_case)
    assert rows == [] and report["rows_added"] == 0
    assert sum(report["games_skipped"].values()) > 0


@pytest.mark.parametrize("mutation", ["no_squiggle", "wrong_date", "wrong_season", "reverse_sides", "wrong_name", "wrong_team_api", "duplicate_local_api"])
def test_fixture_preconditions_fail_closed(supplement_case, mutation):
    db, local_games, matched, supplement = supplement_case
    game = supplement["games"][0]
    if mutation == "no_squiggle":
        matched.clear()
    elif mutation == "wrong_date":
        game["local_date"] = "2013-07-28"
    elif mutation == "wrong_season":
        game["season"] = 2012
    elif mutation == "reverse_sides":
        game["home"], game["away"] = game["away"], game["home"]
    elif mutation == "wrong_name":
        game["home"]["name"] = "Brisbane"
    elif mutation == "wrong_team_api":
        db.execute("UPDATE teams SET api_team_id=3 WHERE team_id=10")
    else:
        db.execute("UPDATE games SET api_game_id=649 WHERE game_id=2")
        local_games[1]["api_game_id"] = 649
    rows, report = run(supplement_case)
    assert rows == [] and report["rows_added"] == 0


@pytest.mark.parametrize("mutation", ["missing_unrelated_player", "duplicate_target_api", "duplicate_unrelated_api"])
def test_every_source_player_identity_must_exist_uniquely_before_any_game_row_is_used(supplement_case, mutation):
    db = supplement_case[0]
    if mutation == "missing_unrelated_player":
        db.execute("DELETE FROM players WHERE player_id=144")
    else:
        db.execute("INSERT INTO players VALUES(999,?, 'Unrelated alias')", (1001 if mutation == "duplicate_target_api" else 1044,))
    rows, report = run(supplement_case)
    assert rows == [] and report["rows_added"] == 0


def test_target_without_any_club_evidence_cannot_be_inferred_from_source_name(supplement_case):
    db = supplement_case[0]
    db.execute("DELETE FROM player_game_stats")
    assert run(supplement_case)[0] == []


def test_same_season_club_contradiction_overrides_other_historical_evidence(supplement_case):
    db = supplement_case[0]
    db.execute("UPDATE player_game_stats SET team_id=20,opponent_team_id=10")
    assert run(supplement_case)[0] == []


def test_missing_season_can_use_only_unanimous_historical_club_evidence(supplement_case):
    db, local_games, _, _ = supplement_case
    db.execute("UPDATE games SET season_year=2012 WHERE game_id=2")
    local_games[1]["season_year"] = 2012
    assert len(run(supplement_case)[0]) == 1
    db.execute("INSERT INTO games VALUES(3,647,2011,'2011-07-20',NULL,'Regular Season',10,20)")
    db.execute("INSERT INTO player_game_stats VALUES(101,3,20,10,20,1,2,3,10,10,1,0)")
    assert run(supplement_case)[0] == []


def test_missing_season_cannot_use_future_only_club_evidence(supplement_case):
    supplement_case[0].execute("UPDATE games SET season_year=2014 WHERE game_id=2")
    rows, report = run(supplement_case)
    assert rows == []
    assert report['games_skipped'] == {'target_historical_club_unverified': 1}


def test_later_transfer_does_not_invalidate_unanimous_prior_club_evidence(supplement_case):
    db = supplement_case[0]
    db.execute("UPDATE games SET season_year=2012 WHERE game_id=2")
    db.execute("INSERT INTO games VALUES(3,647,2014,'2014-07-20',NULL,'Regular Season',10,20)")
    db.execute("INSERT INTO player_game_stats VALUES(101,3,20,10,20,1,2,3,10,10,1,0)")
    assert len(run(supplement_case)[0]) == 1


def test_ambiguous_same_season_clubs_reject_even_with_prior_support(supplement_case):
    db = supplement_case[0]
    db.execute("INSERT INTO games VALUES(3,647,2013,'2013-07-19',NULL,'Regular Season',10,20)")
    db.execute("INSERT INTO player_game_stats VALUES(101,3,20,10,20,1,2,3,10,10,1,0)")
    assert run(supplement_case)[0] == []


def test_duplicate_game_api_outside_supplied_slice_is_rejected(supplement_case):
    supplement_case[0].execute("INSERT INTO games VALUES(3,649,2014,'2014-07-19',NULL,'Regular Season',10,20)")
    rows, report = run(supplement_case)
    assert rows == [] and report['games_skipped'] == {'nonunique_game_mapping': 1}


@pytest.mark.parametrize("mutation", ["short_crew", "unbalanced_teams", "duplicate_player", "missing_stat", "negative_stat", "boolean_stat", "all_zero", "disposals_conflict"])
def test_invalid_full_game_stat_set_never_emits_a_partial_supplement(supplement_case, mutation):
    records = supplement_case[3]["games"][0]["rows"]
    if mutation == "short_crew":
        records.pop()
    elif mutation == "unbalanced_teams":
        records[-1]["api_team_id"] = 1
    elif mutation == "duplicate_player":
        records[-1]["api_player_id"] = records[0]["api_player_id"]
    elif mutation == "missing_stat":
        del records[-1]["marks"]
    elif mutation == "negative_stat":
        records[-1]["marks"] = -1
    elif mutation == "boolean_stat":
        records[-1]["marks"] = True
    elif mutation == "all_zero":
        records[-1].update({stat: 0 for stat in STATS})
    else:
        records[-1]["disposals"] = 21
    try:
        rows, report = run(supplement_case)
    except ValueError:
        return  # Malformed packaged data may reject the complete bundle.
    assert rows == [] and report["rows_added"] == 0


def test_target_stat_zero_is_valid_when_other_recorded_stats_prove_positive_activity(supplement_case):
    rows, _ = run(supplement_case, stat="hit_outs")
    assert len(rows) == 1 and rows[0]["stat_value"] == 0


def test_provider_clock_is_not_used_for_squiggle_context_or_phase(supplement_case):
    supplement_case[3]["games"][0]["provider_date"] = "2013-07-27T02:00:00+00:00"
    rows, _ = run(supplement_case)
    assert len(rows) == 1
    assert "starts_at" not in rows[0] and "game_type" not in rows[0] and "context" not in rows[0]


def test_unsupported_database_schema_has_no_supplement_instead_of_throwing(supplement_case):
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    try:
        rows, report = get_supplemental_appearances(db, 101, "disposals", [], {}, supplement=supplement_case[3])
        assert rows == [] and report["rows_added"] == 0
    finally:
        db.close()


@pytest.mark.parametrize('table', ['games', 'player_game_stats'])
def test_partial_database_schema_is_unsupported(supplement_case, table):
    supplement_case[0].execute(f'DROP TABLE {table}')
    assert run(supplement_case) == ([], {'rows_added': 0, 'games_skipped': {}, 'sources': []})


@pytest.mark.parametrize('mutation', ['nonobject', 'boolean_version', 'wrong_seasons', 'nondict_game',
    'unhashable_game_id', 'boolean_game_id', 'wrong_host', 'http', 'wrong_query', 'duplicate_query',
    'naive_timestamp', 'bad_hash', 'missing_schedule_receipt', 'wrong_schedule_season'])
def test_malformed_bundle_and_provenance_raise_controlled_error(supplement_case, mutation):
    db, games, matched, bundle = supplement_case
    source = bundle['games'][0]
    if mutation == 'nonobject':
        bundle = []
    elif mutation == 'boolean_version':
        bundle['schema_version'] = True
    elif mutation == 'wrong_seasons':
        bundle['seasons'] = [2012]
    elif mutation == 'nondict_game':
        bundle['games'][0] = []
    elif mutation == 'unhashable_game_id':
        source['api_game_id'] = []
    elif mutation == 'boolean_game_id':
        source['api_game_id'] = True
    elif mutation == 'wrong_host':
        source['source_url'] = source['source_url'].replace('v1.afl.api-sports.io', 'untrusted.example')
    elif mutation == 'http':
        source['source_url'] = source['source_url'].replace('https:', 'http:')
    elif mutation == 'wrong_query':
        source['source_url'] = source['source_url'].replace('649', '650')
    elif mutation == 'duplicate_query':
        source['source_url'] += '&id=649'
    elif mutation == 'naive_timestamp':
        source['retrieved_at'] = '2026-09-11T22:47:37'
    elif mutation == 'bad_hash':
        source['source_sha256'] = 'not-a-sha256'
    elif mutation == 'missing_schedule_receipt':
        del source['schedule_source']
    else:
        source['schedule_source']['source_url'] = source['schedule_source']['source_url'].replace('2013', '2014')
    with pytest.raises(ValueError):
        get_supplemental_appearances(db, 101, 'disposals', games, matched, supplement=bundle)


@pytest.mark.parametrize('field,value', [('api_team_id', True), ('api_team_id', []), ('api_player_id', [])])
def test_malformed_row_identifiers_do_not_alias_integers_or_throw(supplement_case, field, value):
    supplement_case[3]['games'][0]['rows'][0][field] = value
    rows, report = run(supplement_case)
    assert rows == [] and report['games_skipped'] == {'unresolved_source_identities': 1}


def test_boolean_fixture_team_identifier_cannot_alias_integer_id(supplement_case):
    supplement_case[3]['games'][0]['home']['api_team_id'] = True
    assert run(supplement_case)[0] == []
