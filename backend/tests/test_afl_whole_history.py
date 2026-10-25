"""Synthetic regressions for conservative whole-history joins and clocks.

These fixtures exercise ambiguity policies; they are not transcribed historical
match records and must never be presented as acquisition evidence.
"""
from copy import deepcopy
from datetime import datetime
import sqlite3

import pytest

from app.afl_context import build_context
from app.afl_player_context import match_games, read_player_impact
from app.afl_player_impact import calculate_player_impact


def local(gid=1, *, venue="Unknown", day="2012-06-15", round_number=None):
    return {"game_id": gid, "season_year": 2012, "round_number": round_number,
            "game_date": day, "venue_name": venue, "home_name": "Brisbane Lions", "away_name": "Adelaide Crows"}


def source(gid=1, *, venue="Gabba", day="2012-06-15", round_number=12):
    return {"source_game_id": f"squiggle:{gid}", "season": 2012, "round": round_number,
            "local_date": day, "starts_at": day + "T09:00:00+00:00",
            "venue": venue, "home": "Brisbane Lions", "away": "Adelaide", "game_type": "Regular Season"}


@pytest.mark.parametrize("missing", [None, "Unknown"])
def test_explicit_missing_venue_can_use_unique_ordered_clubs_and_exact_local_date(missing):
    a, b = local(venue=missing), source()
    assert match_games([a], [b]) == {a["game_id"]: b}


def test_missing_venue_path_uses_source_local_date_not_utc_date():
    a, b = local(), source()
    b["starts_at"] = "2012-06-14T23:00:00+00:00"
    assert match_games([a], [b]) == {1: b}
    b["local_date"] = "2012-06-14"
    assert match_games([a], [b]) == {}


@pytest.mark.parametrize("venue", [None, "", " ", "Unknown"])
def test_missing_local_venue_requires_a_real_source_venue(venue):
    assert match_games([local()], [source(venue=venue)]) == {}


def test_nonnull_round_is_an_additional_constraint_when_local_venue_is_missing():
    a, b = local(round_number=12), source(round_number=12)
    assert match_games([a], [b]) == {1: b}
    b["round"] = 13
    assert match_games([a], [b]) == {}
    b["round"] = 12
    b["local_date"] = "2012-06-16"
    assert match_games([a], [b]) == {}


@pytest.mark.parametrize("venue", ["Sydney Cricket Ground", "Unverified Ground", "", "unknown"])
def test_named_disagreement_or_unapproved_sentinel_never_uses_missing_venue_fallback(venue):
    assert match_games([local(venue=venue)], [source()]) == {}


def test_missing_venue_matching_never_reverses_home_and_away():
    b = source()
    b.update(home="Adelaide", away="Brisbane Lions")
    assert match_games([local()], [b]) == {}


@pytest.mark.parametrize("which", ["source", "local"])
def test_missing_venue_date_tuple_must_be_unique_on_both_sides(which):
    locals_, sources = [local()], [source()]
    if which == "source":
        sources.append(source(2))
    else:
        locals_.append(local(2))
    assert match_games(locals_, sources) == {}


def test_source_id_cannot_be_reused_through_missing_venue_and_known_venue_paths():
    # Each path individually has one candidate. Both must be discarded once
    # they resolve to the same provider event.
    missing = local(1)
    known = local(2, venue="Gabba", day="2012-06-14", round_number=12)
    assert match_games([missing, known], [source()]) == {}


def test_two_same_club_finals_on_distinct_dates_remain_distinct_without_round_guessing():
    locals_ = [local(1, day="2012-09-01"), local(2, day="2012-09-22")]
    sources = [source(1, day="2012-09-01", round_number=25), source(2, day="2012-09-22", round_number=28)]
    for g in sources:
        g["game_type"] = "Finals"
    assert match_games(locals_, sources) == {1: sources[0], 2: sources[1]}
    # The date becomes ambiguous if source records share the same local day.
    sources[1]["local_date"] = sources[0]["local_date"]
    assert match_games(locals_, sources) == {}


@pytest.mark.parametrize("local_name,source_name", [("GMHBA Stadium", "GMHBA Stadium"),
    ("UTAS Stadium", "University of Tasmania Stadium"), ("Optus Stadium", "Optus Stadium"),
    ("Marvel Stadium", "Marvel Stadium")])
def test_registered_sponsor_names_are_normalized_on_both_sides(local_name, source_name):
    a, b = local(venue=local_name), source(venue=source_name)
    assert match_games([a], [b]) == {1: b}


def test_source_supplied_unknown_venue_is_counted_without_rewriting_local_data():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    try:
        db.executescript("""
            CREATE TABLE players(player_id INTEGER PRIMARY KEY,player_name TEXT);
            INSERT INTO players VALUES(1,'Synthetic Player');
            CREATE TABLE teams(team_id INTEGER PRIMARY KEY,team_name TEXT);
            INSERT INTO teams VALUES(10,'Brisbane Lions'),(20,'Adelaide Crows');
            CREATE TABLE venues(venue_id INTEGER PRIMARY KEY,venue_name TEXT);
            INSERT INTO venues VALUES(1,'Unknown'),(2,'Gabba');
            CREATE TABLE games(game_id INTEGER PRIMARY KEY,season_year INTEGER,round_number INTEGER,
                game_date TEXT,game_type TEXT,venue_id INTEGER,home_team_id INTEGER,away_team_id INTEGER);
            INSERT INTO games VALUES(1,2012,NULL,'2012-06-15','Regular Season',1,10,20),
                (2,2012,NULL,'2012-09-15','Regular Season',2,10,20);
            CREATE TABLE player_game_stats(player_id INTEGER,game_id INTEGER,team_id INTEGER,
                opponent_team_id INTEGER,disposals INTEGER);
            INSERT INTO player_game_stats VALUES(1,1,10,20,20),(1,2,10,20,30);
            CREATE TABLE player_team_history(player_id INTEGER,team_id INTEGER,is_current INTEGER,
                start_date TEXT,end_date TEXT);
        """)
        games = [source(1), source(2, day="2012-09-15", round_number=25)]
        games[1]["game_type"] = "Finals"
        for g in games:
            g["teams"] = {"Brisbane Lions": {"start_gap_hours": 168, "venue_distance_km": 0}}
        history = {"schema_version": 1, "source": "squiggle", "seasons": [{"season": 2012,
            "source_url": "https://api.squiggle.com.au/?q=games&year=2012", "retrieved_at": "2026-09-01T00:00:00Z",
            "source_sha256": "a" * 64, "games": games}]}
        db.execute("PRAGMA query_only=ON")
        result, current_club = read_player_impact(db, 1, "disposals", history=history,
                                                 now=datetime.fromisoformat("2026-09-12T00:00:00+00:00"))
        assert result["history_scope"]["source_supplied_venue_rows"] == 1
        assert result["history_scope"]["matched_player_rows"] == 2
        assert result["history_scope"]["source_phase_corrections"] == 1
        assert result["finals"]["aggregate"]["delta"] == 10
        assert db.execute("SELECT venue_name FROM venues WHERE venue_id=1").fetchone()[0] == "Unknown"
        assert db.execute("SELECT game_type FROM games WHERE game_id=2").fetchone()[0] == "Regular Season"
        assert current_club is None
    finally:
        db.close()


def raw_game(gid, instant, venue, home, away):
    stamp = datetime.fromisoformat(instant)
    return {"id": gid, "year": 2020, "round": gid, "roundname": f"Round {gid}",
            "hteamid": home, "ateamid": away, "hteam": f"Test Team {home}", "ateam": f"Test Team {away}",
            "venue": venue, "unixtime": int(stamp.timestamp()), "date": stamp.strftime("%Y-%m-%d %H:%M:%S"),
            "tz": "+10:00", "localtime": stamp.strftime("%Y-%m-%d %H:%M:%S"), "complete": 100, "is_final": 0}


def test_neutral_ground_sequence_uses_actual_grounds_even_when_home_designation_changes():
    # Synthetic 2020 hub-like sequence: one team plays twice at the same ground
    # as away then home. Neither designation implies a journey to its home city.
    rows = [raw_game(1, "2020-07-01T19:00:00+10:00", "Neutral Ground", 2, 1),
            raw_game(2, "2020-07-05T19:00:00+10:00", "Neutral Ground", 1, 3)]
    envelope = {"source": "Squiggle", "source_url": "https://api.squiggle.com.au/?q=games&year=2020",
                "retrieved_at": "2026-09-01T00:00:00+00:00", "payload": {"games": rows}}
    venues = {"Neutral Ground": {"latitude": -27.5, "longitude": 153.0,
               "timezone": "Australia/Brisbane", "source_url": "https://example.org/synthetic-ground"}}
    result = build_context(envelope, venues)["games"][1]["teams"]["squiggle:1"]
    assert result["start_gap_hours"] == 96
    assert result["venue_distance_km"] == 0
    assert result["venue_clock_shift_hours"] == 0
    conflicting = deepcopy(envelope)
    conflicting["payload"]["games"][1]["tz"] = "+11:00"
    with pytest.raises(ValueError, match="Conflicting source start timestamps"):
        build_context(conflicting, venues)


def test_whole_history_aggregation_keeps_seasons_and_game_types_separate_at_scale():
    rows = []
    for year in range(2011, 2027):
        regular = 10 if year == 2020 else 20 + year - 2011
        for index in range(20):
            rows.append({"game_id": year * 100 + index, "season_year": year, "game_type": "Regular Season",
                         "stat_value": regular, "context": {"start_gap_hours": 144, "venue_distance_km": 0}})
        rows.append({"game_id": year * 100 + 99, "season_year": year, "game_type": "Finals",
                     "stat_value": regular + 2, "context": {"start_gap_hours": 100, "venue_distance_km": 2000}})
    result = calculate_player_impact(rows, stat="disposals")
    assert result["coverage"]["eligible_stat_rows"] == 16 * 21
    assert result["finals"]["aggregate"]["included_strata"] == 16
    assert result["finals"]["aggregate"]["delta"] == pytest.approx(2)
    assert [s["season_year"] for s in result["finals"]["per_season"]] == list(range(2011, 2027))
    # All target-context games are finals, controls regular. There is no same-
    # game-type control, so a naive pooled 'travel effect' must stay unavailable.
    assert not result["travel"]["available"]
    assert not result["rest"]["available"]
