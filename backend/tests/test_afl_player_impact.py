from copy import deepcopy
import json
import math

import pytest

from app.afl_player_impact import calculate_player_impact


def row(gid, value, *, season=2026, kind="Regular Season", context=None):
    return {"game_id": gid, "season_year": season, "game_type": kind,
            "stat_value": value, "context": context}


def calculate(rows, **kwargs):
    return calculate_player_impact(rows, stat="disposals", **kwargs)


def test_finals_aggregate_uses_finals_weighted_same_season_baseline_not_pooled_regular_mean():
    rows = [row(i, 10, season=2025) for i in range(1, 21)]
    rows += [row(21, 20, season=2025, kind="Finals"), row(22, 100)]
    rows += [row(i, 110, kind="Finals") for i in range(23, 26)]
    result = calculate(rows)["finals"]
    assert [s["delta"] for s in result["per_season"]] == pytest.approx([10, 10])
    aggregate = result["aggregate"]
    assert aggregate["target_games"] == 4 and aggregate["baseline_games"] == 21
    assert aggregate["target_mean"] == pytest.approx(87.5)
    assert aggregate["baseline_mean"] == pytest.approx(77.5)
    assert aggregate["delta"] == pytest.approx(10)
    assert aggregate["percent_change"] == pytest.approx(1000 / 77.5)


def test_missing_regular_baseline_excludes_both_aggregate_sides_but_reports_season():
    rows = [row(1, 20, kind="Finals"), row(2, 10), row(3, 100, kind="Finals", season=2025),
            row(4, 500, season=2024)]
    result = calculate(rows)["finals"]
    assert result["aggregate"]["target_mean"] == 20
    assert result["aggregate"]["baseline_mean"] == 10
    assert result["aggregate"]["excluded_target_games"] == 1
    assert result["aggregate"]["included_strata"] == 1
    seasons = {s["season_year"]: s for s in result["per_season"]}
    assert seasons[2025]["reason"] == "no_baseline_games"
    assert seasons[2025]["target_games"] == 1 and not seasons[2025]["included"]
    assert seasons[2024]["reason"] == "no_target_games"


def test_zero_stats_are_real_observations_and_zero_baseline_percent_is_unavailable():
    result = calculate([row(1, 0), row(2, 5, kind="Finals")])["finals"]["aggregate"]
    assert result["available"] and result["baseline_games"] == 1
    assert result["baseline_mean"] == 0 and result["delta"] == 5
    assert result["percent_change"] is None and result["percent_change_reason"] == "zero_baseline"
    decrease = calculate([row(1, 10), row(2, 0, kind="Finals")])["finals"]["aggregate"]
    assert decrease["delta"] == -10 and decrease["percent_change"] == -100


def test_sparse_warning_applies_to_each_stratum_even_when_aggregate_counts_are_large():
    rows = [row(i, 10, season=2025) for i in range(1, 6)]
    rows += [row(i, 20, kind="Finals", season=2025) for i in range(6, 9)]
    assert not calculate(rows)["finals"]["aggregate"]["small_sample"]
    rows += [row(9, 10), row(10, 20, kind="Finals")]
    result = calculate(rows)["finals"]
    assert result["aggregate"]["small_sample"]
    assert [s["small_sample"] for s in result["per_season"]] == [False, True]


def test_context_controls_match_both_season_and_game_type_before_weighting():
    target = {"start_gap_hours": 100, "venue_distance_km": 25}
    baseline = {"start_gap_hours": 180, "venue_distance_km": 1500}
    rows = [row(i, 10, season=2025, context=baseline) for i in range(1, 10)]
    rows += [row(10, 20, season=2025, context=target), row(11, 100, context=baseline)]
    rows += [row(i, 110, context=target) for i in range(12, 15)]
    rows += [row(15, 300, kind="Finals", context=baseline), row(16, 310, kind="Finals", context=target)]
    result = calculate(rows)
    for family in ("rest", "travel"):
        bucket = result[family]["buckets"][0]
        assert bucket["target_games"] == 5 and bucket["baseline_games"] == 11
        assert bucket["target_mean"] == pytest.approx(132)
        assert bucket["baseline_mean"] == pytest.approx(122)
        assert bucket["delta"] == pytest.approx(10)
        assert bucket["included_strata"] == 3
        assert {(s["season_year"], s["game_type"]) for s in bucket["strata"]} == {
            (2025, "Regular Season"), (2026, "Regular Season"), (2026, "Finals")}


def test_context_missing_and_invalid_excluded_from_both_groups_but_zero_is_matched():
    rows = [row(1, 10, context={"start_gap_hours": 0, "venue_distance_km": 0}),
            row(2, 20, context={"start_gap_hours": 144, "venue_distance_km": 50}),
            row(3, 900), row(4, 800, context={}),
            row(5, 700, context={"start_gap_hours": None, "venue_distance_km": None}),
            row(6, 600, context={"start_gap_hours": -1, "venue_distance_km": float("nan")}),
            row(7, 500, context=[])]
    result = calculate(rows)
    assert result["coverage"]["eligible_stat_rows"] == 7
    for family in ("rest", "travel"):
        assert result[family]["coverage"] == {"eligible_stat_rows": 7, "matched_context_rows": 2,
            "missing_context_rows": 3, "invalid_context_rows": 2}
        bucket = result[family]["buckets"][0]
        assert bucket["target_games"] == bucket["baseline_games"] == 1
        assert bucket["target_mean"] == 10 and bucket["baseline_mean"] == 20


@pytest.mark.parametrize("family,field,values,expected", [
    ("rest", "start_gap_hours", [0, 143.999, 144, 167.999, 168, 191.999, 192], [2, 2, 2, 1]),
    ("travel", "venue_distance_km", [0, 49.999, 50, 249.999, 250, 499.999, 500, 999.999,
                                    1000, 1999.999, 2000, 2999.999, 3000], [2, 2, 2, 2, 2, 2, 1])])
def test_bucket_boundaries_partition_targets_and_baselines_never_overlap(family, field, values, expected):
    result = calculate([row(i + 1, i, context={field: v}) for i, v in enumerate(values)])
    buckets = result[family]["buckets"]
    assert [b["target_games"] for b in buckets] == expected
    assert sum(b["target_games"] for b in buckets) == len(values)
    for bucket in buckets:
        assert bucket["baseline_games"] == len(values) - bucket["target_games"]


def test_all_context_in_one_bucket_has_no_comparison_and_does_not_use_other_season_or_type():
    result = calculate([row(1, 10, context={"start_gap_hours": 100}),
                        row(2, 100, season=2025, context={"start_gap_hours": 200}),
                        row(3, 500, kind="Finals", context={"start_gap_hours": 200})])
    bucket = result["rest"]["buckets"][0]
    assert not bucket["available"] and bucket["target_games"] == 0
    assert bucket["excluded_target_games"] == 1
    assert bucket["target_mean"] is None and bucket["baseline_mean"] is None
    assert next(s for s in bucket["strata"] if s["season_year"] == 2026 and s["game_type"] == "Regular Season")["reason"] == "no_baseline_games"


def test_duplicate_ids_are_all_excluded_even_if_one_duplicate_is_invalid_or_outside_filter():
    rows = [row(1, 10), row(1, None), row(2, 20), row(2, 30, season=2025),
            row(3, 15), row(4, 25, kind="Finals"), row(5, 50, season=2024)]
    result = calculate(rows, season_from=2026, season_to=2026)
    assert result["coverage"]["eligible_stat_rows"] == 2
    assert result["coverage"]["exclusion_reasons"] == {"duplicate_game_id": 4, "season_outside_range": 1}
    assert result["finals"]["aggregate"]["delta"] == 10


@pytest.mark.parametrize("value", [-1, True, "12", float("nan"), float("inf"), [], {}, 10**1000])
def test_invalid_stat_values_never_become_zero(value):
    result = calculate([row(1, value), row(2, 5, kind="Finals")])
    assert result["coverage"]["exclusion_reasons"] == {"invalid_stat": 1}
    assert not result["finals"]["aggregate"]["available"]


def test_invalid_record_identity_season_type_and_missing_stats_are_reported():
    rows = [None, {"game_id": True}, {**row(1, 1), "season_year": "2026"},
            row(2, 10, kind="Preseason"), row(3, None), {**row(4, 10), "game_type": []}]
    result = calculate(rows)
    assert result["coverage"]["excluded_rows"] == len(rows)
    assert result["coverage"]["exclusion_reasons"] == {"invalid_record": 1, "invalid_game_id": 1,
        "invalid_season": 1, "invalid_game_type": 2, "missing_stat": 1}
    assert not result["rest"]["available"] and not result["travel"]["available"]


def test_empty_and_extreme_finite_samples_produce_valid_json_without_mutating_input():
    assert calculate([])["finals"]["per_season"] == []
    rows = [row(1, 1e308), row(2, 1e308), row(3, 1e308, kind="Finals")]
    original = deepcopy(rows)
    result = calculate(rows)
    assert result["finals"]["aggregate"]["baseline_mean"] == 1e308
    assert result["finals"]["aggregate"]["delta"] == 0
    json.dumps(result, allow_nan=False)
    tiny = calculate([row(1, 1e-308), row(2, 1e308, kind="Finals")])
    assert tiny["finals"]["aggregate"]["percent_change"] is None
    json.dumps(tiny, allow_nan=False)
    assert rows == original


@pytest.mark.parametrize("kwargs", [{"stat": "not_a_stat"}, {"season_from": True}, {"season_to": "2026"},
                                    {"season_from": 2026, "season_to": 2025}])
def test_invalid_function_arguments_are_rejected(kwargs):
    with pytest.raises(ValueError):
        calculate_player_impact([], **{"stat": "disposals", **kwargs})


def test_input_is_bounded_and_requires_a_list():
    for rows in ({}, iter([]), [None] * 10001):
        with pytest.raises(ValueError):
            calculate(rows)


def without_sensitivity(value):
    if isinstance(value, dict):
        return {k: without_sensitivity(v) for k, v in value.items()
                if k not in {"without_unverified_participation", "data_quality"}}
    if isinstance(value, list):
        return [without_sensitivity(v) for v in value]
    return value


def test_participation_sensitivity_retains_primary_and_reweights_each_season_after_omission():
    rows = [row(1, 10, season=2025), row(2, 0, season=2025),
            row(3, 20, season=2025, kind="Finals"), row(4, 0, season=2025, kind="Finals"),
            row(5, 100), *[row(i, 110, kind="Finals") for i in range(6, 9)]]
    unflagged = calculate(rows)
    rows[1]["participation_unverified"] = True
    rows[3]["participation_unverified"] = True
    preserved = deepcopy(rows)
    result = calculate(rows)
    assert without_sensitivity(result) == without_sensitivity(unflagged)
    assert result["data_quality"]["unverified_participation_rows"] == 2
    primary = result["finals"]["aggregate"]
    alternate = primary["without_unverified_participation"]
    assert primary["target_games"] == 5 and primary["baseline_games"] == 3
    assert primary["delta"] == pytest.approx(8)
    assert alternate["target_games"] == 4 and alternate["baseline_games"] == 2
    assert alternate["target_mean"] == pytest.approx(87.5)
    assert alternate["baseline_mean"] == pytest.approx(77.5)
    assert alternate["delta"] == pytest.approx(10)
    seasons = result["finals"]["per_season"]
    assert seasons[0]["without_unverified_participation"]["delta"] == pytest.approx(10)
    assert "without_unverified_participation" not in seasons[1]
    assert rows == preserved


def test_context_sensitivity_preserves_game_type_controls_and_reports_affected_strata_only():
    target = {"start_gap_hours": 100, "venue_distance_km": 0}
    baseline = {"start_gap_hours": 180, "venue_distance_km": 1500}
    rows = [row(1, 0, context=target), row(2, 20, context=target), row(3, 10, context=baseline),
            row(4, 310, kind="Finals", context=target), row(5, 300, kind="Finals", context=baseline)]
    rows[0]["participation_unverified"] = True
    result = calculate(rows)
    for family in ("rest", "travel"):
        bucket = result[family]["buckets"][0]
        alternate = bucket["without_unverified_participation"]
        assert bucket["delta"] == pytest.approx(10 / 3)
        assert alternate["delta"] == pytest.approx(10)
        assert alternate["target_games"] == 2 and alternate["baseline_games"] == 2
        assert alternate["target_mean"] == pytest.approx(165)
        assert alternate["baseline_mean"] == pytest.approx(155)
        strata = {s["game_type"]: s for s in bucket["strata"]}
        assert "without_unverified_participation" in strata["Regular Season"]
        assert "without_unverified_participation" not in strata["Finals"]
        for sibling in result[family]["buckets"]:
            sensitivity = sibling.get("without_unverified_participation", {})
            assert "without_unverified_participation" not in sensitivity
            assert "strata" not in sensitivity


def test_entire_stratum_removed_has_explicit_unavailable_alternate_counts():
    rows = [row(1, 0, context={"start_gap_hours": 100, "venue_distance_km": 0}),
            row(2, 0, kind="Finals", context={"start_gap_hours": 200, "venue_distance_km": 2000})]
    for r in rows:
        r["participation_unverified"] = True
    result = calculate(rows)
    for comparison in (result["finals"]["aggregate"], result["finals"]["per_season"][0],
                       result["rest"]["buckets"][0], result["rest"]["buckets"][0]["strata"][0]):
        alternate = comparison["without_unverified_participation"]
        assert not alternate["available"]
        assert alternate["target_games"] == alternate["baseline_games"] == 0
        assert alternate["target_mean"] is None and alternate["delta"] is None
    json.dumps(result, allow_nan=False)


def test_flagged_only_baseline_can_make_unflagged_targets_ineligible_in_sensitivity():
    rows = [row(1, 0), row(2, 20, kind="Finals")]
    rows[0]["participation_unverified"] = True
    primary = calculate(rows)["finals"]["aggregate"]
    alternate = primary["without_unverified_participation"]
    assert primary["available"] and primary["target_games"] == 1
    assert not alternate["available"] and alternate["target_games"] == 0
    assert alternate["excluded_target_games"] == 1


def test_single_stat_zero_never_creates_an_inferred_participation_flag():
    rows = [row(1, 0), row(2, 5, kind="Finals")]
    rows[0].update(other_stats={"goals": 1, "tackles": 2}, participation_unverified=False)
    result = calculate(rows)
    assert result["data_quality"]["unverified_participation_rows"] == 0
    assert result["finals"]["aggregate"]["baseline_mean"] == 0
    assert "without_unverified_participation" not in json.dumps(result)
    for non_boolean in (1, "true", [True]):
        rows[0]["participation_unverified"] = non_boolean
        assert calculate(rows)["data_quality"]["unverified_participation_rows"] == 0


def test_sensitivity_counts_only_eligible_flags_and_never_resurrects_duplicate_rows():
    rows = [row(1, 0), row(1, 900), row(2, None), row(3, 0, season=2024),
            row(4, 0), row(5, 10), row(6, 20, kind="Finals")]
    for i in (0, 2, 3, 4):
        rows[i]["participation_unverified"] = True
    result = calculate(rows, season_from=2026)
    assert result["data_quality"]["unverified_participation_rows"] == 1
    assert result["coverage"]["exclusion_reasons"] == {
        "duplicate_game_id": 2, "missing_stat": 1, "season_outside_range": 1}
    alternate = result["finals"]["aggregate"]["without_unverified_participation"]
    assert alternate["baseline_games"] == 1 and alternate["baseline_mean"] == 10
    assert alternate["delta"] == 10


def test_flagged_unknown_context_does_not_attach_unchanged_context_comparisons():
    rows = [row(1, 0), row(2, 10, context={"start_gap_hours": 100, "venue_distance_km": 0}),
            row(3, 20, context={"start_gap_hours": 200, "venue_distance_km": 2000})]
    rows[0]["participation_unverified"] = True
    result = calculate(rows)
    assert result["data_quality"]["unverified_participation_rows"] == 1
    assert "without_unverified_participation" not in json.dumps(result["rest"])
    assert "without_unverified_participation" not in json.dumps(result["travel"])
    # There are no finals, so removing a regular-season row changes the season
    # details but cannot create or alter a combined finals comparison.
    assert "without_unverified_participation" in result["finals"]["per_season"][0]
    assert "without_unverified_participation" not in result["finals"]["aggregate"]
