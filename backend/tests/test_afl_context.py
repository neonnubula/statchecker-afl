from copy import deepcopy
from datetime import datetime
import pytest
from app.afl_context import build_context


def game(gid, start, home=1, away=2, venue="East", complete=100):
    dt = datetime.fromisoformat(start)
    return {"id": gid, "year": 2026, "round": gid, "roundname": f"Round {gid}",
            "hteamid": home, "ateamid": away, "hteam": f"Team {home}", "ateam": f"Team {away}",
            "venue": venue, "unixtime": int(dt.timestamp()), "date": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "tz": dt.strftime("%z")[:3]+":"+dt.strftime("%z")[3:],
            "localtime": dt.strftime("%Y-%m-%d %H:%M:%S"), "complete": complete, "is_final": 0}


@pytest.fixture
def snapshot():
    return {"source": "Squiggle", "source_url": "https://api.squiggle.com.au/?q=games&year=2026",
            "retrieved_at": "2026-08-01T00:00:00Z", "payload": {"games": [
                game(1, "2026-06-01T19:00:00+10:00"),
                game(2, "2026-06-08T17:00:00+10:00", away=3),
                game(3, "2026-06-15T17:00:00+10:00", away=4)]}}


def context(snapshot, venues=None, index=-1, tid="squiggle:1"):
    return build_context(snapshot, venues)["games"][index]["teams"][tid]


def test_turnaround_off_days_workload_and_season_boundary(snapshot):
    first = context(snapshot, index=0)
    assert first["off_days"] is None and first["games_previous_14_days"] is None
    second = context(snapshot, index=1)
    assert second["start_gap_hours"] == 166
    assert second["calendar_gap_days"] == 7 and second["off_days"] == 6
    assert second["venue_distance_km"] is None
    assert context(snapshot)["games_previous_14_days"] == 2
    assert context(snapshot)["games_previous_28_days"] == 2


def test_reference_clock_is_not_venue_clock(snapshot):
    snapshot["payload"]["games"][1]["venue"] = "West"
    snapshot["payload"]["games"][1]["localtime"] = "2026-06-08 15:00:00"
    venues = {"East": {"latitude": -37.82, "longitude": 144.98, "timezone": "Australia/Melbourne", "source_url": "https://example.org/east"},
              "West": {"latitude": -31.95, "longitude": 115.89, "timezone": "Australia/Perth", "source_url": "https://example.org/west"}}
    result = context(snapshot, venues, index=1)
    assert 2700 < result["venue_distance_km"] < 2750
    assert result["venue_clock_shift_hours"] == -2
    assert result["start_gap_hours"] == 166
    assert context(snapshot, venues)["venue_clock_shift_hours"] == 2


def test_incomplete_previous_match_does_not_become_observed_rest(snapshot):
    snapshot["payload"]["games"][1]["complete"] = 0
    result = context(snapshot)
    assert result["status"] == "previous_match_not_final"
    assert result["start_gap_hours"] is None and result["games_previous_14_days"] is None


def test_sorts_before_deriving_and_keeps_source_ids(snapshot):
    expected = build_context(snapshot)
    snapshot["payload"]["games"].reverse()
    assert build_context(snapshot) == expected
    assert expected["games"][0]["game_id"] == "squiggle:1"


@pytest.mark.parametrize("field,value", [("unixtime", 1), ("complete", 101), ("complete", True),
    ("ateamid", 1), ("id", 0), ("year", 2025), ("is_final", 8), ("hteam", "")])
def test_rejects_invalid_source_before_derivation(snapshot, field, value):
    snapshot["payload"]["games"][0][field] = value
    with pytest.raises(ValueError):
        build_context(snapshot)


def test_rejects_duplicate_or_conflicting_identities(snapshot):
    snapshot["payload"]["games"].append(deepcopy(snapshot["payload"]["games"][0]))
    with pytest.raises(ValueError, match="Duplicate"):
        build_context(snapshot)
    snapshot["payload"]["games"].pop()
    snapshot["payload"]["games"][1]["hteam"] = "Different club"
    with pytest.raises(ValueError, match="Conflicting team"):
        build_context(snapshot)


def test_rejects_partial_query_as_full_season(snapshot):
    snapshot["source_url"] += "&round=1"
    with pytest.raises(ValueError, match="single-season"):
        build_context(snapshot)


def test_rejects_venue_timezone_disagreement_and_nonfinite_coordinates(snapshot):
    venues = {"East": {"latitude": -37.8, "longitude": 144.9, "timezone": "Australia/Perth", "source_url": "https://example.org/venue"}}
    with pytest.raises(ValueError, match="disagrees"):
        build_context(snapshot, venues)
    venues["East"]["latitude"] = float("nan")
    with pytest.raises(ValueError, match="finite"):
        build_context(snapshot, venues)


def test_html_escapes_source_text(snapshot):
    from scripts.afl_build_context import render_report
    snapshot["payload"]["games"][0]["venue"] = "</script><script>alert(1)</script>"
    result = render_report(build_context(snapshot))
    assert "</script><script>alert(1)" not in result


@pytest.mark.parametrize("suffix", ["&round=", "&round=1", "&year=", "#round=1"])
def test_blank_or_fragment_filters_cannot_pass_complete_query_validation(snapshot, suffix):
    snapshot["source_url"] += suffix
    with pytest.raises(ValueError, match="single-season"):
        build_context(snapshot)


def test_rejects_other_provider_and_future_in_progress_match(snapshot):
    snapshot["source"] = "Other Provider"
    with pytest.raises(ValueError, match="single-season"):
        build_context(snapshot)
    snapshot["source"] = "squiggle"
    snapshot["retrieved_at"] = "2026-05-31T00:00:00Z"
    snapshot["payload"]["games"][0]["complete"] = 50
    with pytest.raises(ValueError, match="completed match"):
        build_context(snapshot)


def test_scheduled_turnaround_is_not_labeled_observed(snapshot):
    snapshot["payload"]["games"][-1]["complete"] = 0
    result = context(snapshot)
    assert result["status"] == "scheduled_gap"
    assert result["start_gap_hours"] == 168


def test_dst_alone_changes_elapsed_gap_but_not_venue_clock_shift(snapshot):
    snapshot["payload"]["games"] = [game(1, "2026-03-29T19:00:00+11:00"), game(2, "2026-04-05T19:00:00+10:00")]
    venues = {"East": {"latitude": -37.82, "longitude": 144.98, "timezone": "Australia/Melbourne", "source_url": "https://example.org/east"}}
    result = context(snapshot, venues)
    assert result["start_gap_hours"] == 169
    assert result["calendar_gap_days"] == 7
    assert result["venue_clock_shift_hours"] == 0
    assert result["venue_distance_km"] == 0


def test_unresolved_older_game_invalidates_workload_even_with_final_previous(snapshot):
    snapshot["payload"]["games"][0]["complete"] = 0
    result = context(snapshot)
    assert result["start_gap_hours"] == 168
    assert result["games_previous_14_days"] is None
    assert result["games_previous_28_days"] is None


def test_visible_venue_attribution_and_safe_license_links(snapshot):
    from scripts.afl_build_context import render_report
    venues = {"East": {"latitude": -37.82, "longitude": 144.98, "timezone": "Australia/Melbourne",
        "source_url": "https://www.openstreetmap.org/way/210337258", "attribution": "© OpenStreetMap contributors",
        "license": "ODbL-1.0", "license_url": "https://opendatacommons.org/licenses/odbl/1-0/"}}
    report = render_report(build_context(snapshot, venues))
    assert "OpenStreetMap contributors" in report and "ODbL-1.0" in report
    assert "attributions.map" in report and "Venue coordinates:" in report
    venues["East"]["license_url"] = "javascript:alert(1)"
    with pytest.raises(ValueError, match="license URL"):
        build_context(snapshot, venues)


def test_future_finals_placeholders_are_preserved_without_guessing_or_null_joins(snapshot):
    rows = snapshot["payload"]["games"]
    for g in rows[1:]:
        g.update(complete=0, ateamid=None, ateam=None, is_final=5)
    rows[-1].update(hteamid=None, hteam=None, is_final=6)
    result = build_context(snapshot)
    assert result["coverage"]["games"] == 3
    assert result["coverage"]["unresolved_team_games"] == 2
    assert result["games"][1]["away_team_id"] is None
    assert set(result["games"][1]["teams"]) == {"squiggle:1"}
    assert result["games"][-1]["teams"] == {}
    rows[1]["complete"] = 100
    with pytest.raises(ValueError, match="team identity"):
        build_context(snapshot)


@pytest.fixture
def appointment_sample():
    return {"source": "AFLUA published appointments",
        "source_url": "https://aflua.com.au/wp-content/uploads/2026/06/Round-16.pdf",
        "retrieved_at": "2026-07-01T00:00:00Z", "source_sha256": "a" * 64,
        "competition": "AFL", "season": 2026, "round": 16,
        "status": "announced_appointments_not_independently_verified_as_officiated",
        "extraction": "Synthetic fixture for validation tests",
        "appointments": [{"local_date": "2026-06-25", "local_time": "19:30",
            "home_team_source": "Test Home", "away_team_source": "Test Away", "venue_source": "Test Ground",
            "field_umpires": [{"shirt_number": 12, "name_source": "Test Official"}]}]}


@pytest.mark.parametrize("field,value", [
    ("source_url", "http://aflua.com.au/wp-content/uploads/2026/06/Round-16.pdf"),
    ("source_url", "https://aflua.com.au.evil.example/wp-content/uploads/Round-16.pdf"),
    ("source_url", "https://aflua.com.au@evil.example/wp-content/uploads/Round-16.pdf"),
    ("source_url", "https://aflua.com.au/wp-content/uploads/Round-16.pdf?unverified=1"),
    ("status", "actually_officiated"), ("competition", "AFLW"), ("source_sha256", "unknown"),
    ("retrieved_at", "2026-07-01T00:00:00"), ("retrieved_at", "2099-07-01T00:00:00Z"),
    ("season", True), ("round", -1), ("extraction", ""), ("appointments", [])])
def test_appointment_sample_rejects_unverified_metadata(appointment_sample, field, value):
    from scripts.afl_build_context import validate_appointments
    appointment_sample[field] = value
    with pytest.raises(ValueError):
        validate_appointments(appointment_sample)


@pytest.mark.parametrize("field,value", [("local_date", "2025-06-25"), ("local_time", "25:10"),
    ("home_team_source", "Test Away"), ("field_umpires", []),
    ("field_umpires", [{"shirt_number": True, "name_source": "Test Official"}])])
def test_appointment_sample_rejects_invalid_fixtures(appointment_sample, field, value):
    from scripts.afl_build_context import validate_appointments
    appointment_sample["appointments"][0][field] = value
    with pytest.raises(ValueError):
        validate_appointments(appointment_sample)


def test_appointment_sample_rejects_duplicate_fixtures_and_crew(appointment_sample):
    from scripts.afl_build_context import validate_appointments
    appointment_sample["appointments"].append(deepcopy(appointment_sample["appointments"][0]))
    with pytest.raises(ValueError, match="fixture"):
        validate_appointments(appointment_sample)
    appointment_sample["appointments"].pop()
    crew = appointment_sample["appointments"][0]["field_umpires"]
    crew.append(deepcopy(crew[0]))
    with pytest.raises(ValueError, match="crew"):
        validate_appointments(appointment_sample)


def test_appointments_render_separately_above_schedule_and_escape_source_text(snapshot, appointment_sample):
    from scripts.afl_build_context import render_report
    appointment_sample["appointments"][0]["field_umpires"][0]["name_source"] = '</script><img src=x onerror="alert(1)">'
    context_data = build_context(snapshot)
    html = render_report(context_data, appointment_sample)
    assert html.index('<details id="appointments"') < html.index('<tbody id="rows">')
    assert '1 fixtures · 1 name entries' in html
    assert '&lt;/script&gt;&lt;img' in html and '<img src=x' not in html
    assert "not independently verified as the officials who worked" in html
    assert "no player, match or referee identity joins" in html
    assert "Retrieved 2026-07-01T00:00:00Z" in html
    assert "Source PDF SHA-256:" in html
    assert "appointments_sample" not in context_data
    assert '<details id="appointments"' not in render_report(context_data)


def test_appointments_cli_stores_separate_sample_without_schedule_joins(snapshot, appointment_sample, tmp_path):
    import json
    import subprocess
    import sys
    from pathlib import Path
    source, appointments, output = (tmp_path / name for name in ("source.json", "appointments.json", "result.json"))
    source.write_text(json.dumps(snapshot))
    appointments.write_text(json.dumps(appointment_sample))
    script = Path(__file__).resolve().parents[1] / "scripts" / "afl_build_context.py"
    result = subprocess.run([sys.executable, str(script), "--snapshot", str(source), "--appointments", str(appointments),
                             "--output", str(output)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    artifact = json.loads(output.read_text())
    assert artifact["games"] == build_context(snapshot)["games"]
    assert artifact["appointments_sample"]["appointments"] == appointment_sample["appointments"]
    assert '<details id="appointments"' in output.with_suffix('.html').read_text()


def test_source_text_cannot_trigger_a_second_template_substitution(snapshot, appointment_sample):
    from scripts.afl_build_context import render_report
    snapshot["payload"]["games"][0]["venue"] = "ATTRIBUTION_DATA"
    appointment_sample["appointments"][0]["venue_source"] = "CONTEXT_DATA"
    html = render_report(build_context(snapshot), appointment_sample)
    assert '"venue": "ATTRIBUTION_DATA"' in html
    assert " · CONTEXT_DATA</small>" in html
