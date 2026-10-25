"""Pure descriptive AFL stat comparisons; no identities, database or forecasts.

Input: at most 10,000 appearance dictionaries with game_id (positive int),
season_year (positive int), game_type (Regular Season/Finals), stat_value,
and optional context.{start_gap_hours,venue_distance_km}. Extra source metadata
is ignored. Invalid stats/identities are excluded with counts; every occurrence
of a duplicated valid game ID is excluded, even across season filters.

Output: coverage, finals.{aggregate,per_season}, and rest/travel.{coverage,buckets}.
Every comparison supplies target_games, baseline_games, target_mean,
baseline_mean, delta, percent_change (percentage units), available, small_sample,
included_strata and excluded_target_games. Aggregate baselines weight each
eligible stratum's baseline mean by its TARGET appearance count. baseline_games
is the actual number of distinct control observations used, not a weight.
Per-stratum entries also carry included/reason and season_year/game_type.
Missing baselines never contribute to either aggregate mean. Zero baselines
remain valid comparisons, with percent_change=null.

Optional participation_unverified=True is an upstream quality flag, not a DNP
classification. It never changes the primary calculations. data_quality counts
flagged eligible rows. Comparisons whose sample counts change additionally carry
without_unverified_participation: an ordinary comparison calculated after those
flagged rows are omitted. Alternate comparisons never contain nested alternates.
Flags are not inferred from stat_value=0 or other stats supplied as metadata.
"""
from collections import Counter, defaultdict
import math

VALID_STATS = frozenset({"disposals", "goals", "tackles", "marks", "kicks", "handballs", "clearances", "hit_outs"})
GAME_TYPES = frozenset({"Regular Season", "Finals"})
MAX_ROWS = 10_000
REST_BUCKETS = (("under_144h", "Under 144 hours", 0, 144),
                ("144_to_168h", "144 to under 168 hours", 144, 168),
                ("168_to_192h", "168 to under 192 hours", 168, 192),
                ("192h_plus", "192 hours or more", 192, None))
# Geographic ranges audited across the sourced 2011–2026 club schedules.
# Keep local/regional ground changes separate from longer trips; never tune
# these thresholds to a player's outcomes. See afl_audit_travel_bands.py.
TRAVEL_BUCKETS = (("under_50km", "Under 50 km", 0, 50),
                  ("50_to_250km", "50 to under 250 km", 50, 250),
                  ("250_to_500km", "250 to under 500 km", 250, 500),
                  ("500_to_1000km", "500 to under 1,000 km", 500, 1000),
                  ("1000_to_2000km", "1,000 to under 2,000 km", 1000, 2000),
                  ("2000_to_3000km", "2,000 to under 3,000 km", 2000, 3000),
                  ("3000km_plus", "3,000 km or more", 3000, None))
TRAVEL_TRANSITIONS = (("home_to_away", "Home → away"),
                      ("away_to_home", "Away → home"),
                      ("away_to_away", "Away → away"),
                      ("home_to_home", "Home → home"))
COMPARISON_FIELDS = ("available", "target_games", "baseline_games", "target_mean", "baseline_mean",
                     "delta", "percent_change", "percent_change_reason", "small_sample",
                     "included_strata", "excluded_target_games")


def _number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def _positive_int(value):
    return type(value) is int and value > 0


def _mean(values):
    if not values:
        return None
    peak = max(values)
    return peak * min(1.0, math.fsum(v / peak for v in values) / len(values)) if peak else 0.0


def _weighted_mean(values, weights):
    peak, total = max(values), sum(weights)
    return peak * min(1.0, math.fsum((v / peak) * (w / total) for v, w in zip(values, weights))) if peak else 0.0


def _effects(target_mean, baseline_mean):
    if target_mean is None or baseline_mean is None:
        return {"delta": None, "percent_change": None, "percent_change_reason": "comparison_unavailable"}
    delta = target_mean - baseline_mean
    percent = delta / baseline_mean * 100 if baseline_mean else None
    reason = "zero_baseline" if baseline_mean == 0 else None
    if percent is not None and not math.isfinite(percent):
        percent, reason = None, "not_finitely_representable"
    return {"delta": delta, "percent_change": percent, "percent_change_reason": reason}


def _stratum(target, baseline, *, minimum_target, season_year, game_type=None):
    available = bool(target and baseline)
    result = {"season_year": season_year, "available": available, "included": available,
              "reason": None if available else "no_target_games" if not target else "no_baseline_games",
              "target_games": len(target), "baseline_games": len(baseline),
              "target_mean": _mean(target), "baseline_mean": _mean(baseline),
              "small_sample": len(target) < minimum_target or len(baseline) < 5,
              "included_strata": int(available), "excluded_target_games": 0 if available else len(target)}
    if game_type is not None:
        result["game_type"] = game_type
    result.update(_effects(result["target_mean"], result["baseline_mean"]))
    return result


def _aggregate(strata):
    included = [s for s in strata if s["included"]]
    weights = [s["target_games"] for s in included]
    result = {"available": bool(included), "target_games": sum(weights),
              "baseline_games": sum(s["baseline_games"] for s in included),
              "target_mean": _weighted_mean([s["target_mean"] for s in included], weights) if included else None,
              "baseline_mean": _weighted_mean([s["baseline_mean"] for s in included], weights) if included else None,
              "small_sample": not included or any(s["small_sample"] for s in included),
              "included_strata": len(included),
              "excluded_target_games": sum(s["excluded_target_games"] for s in strata)}
    result.update(_effects(result["target_mean"], result["baseline_mean"]))
    return result


def _context_value(row, field):
    context = row.get("context")
    if context is None:
        return None, "missing"
    if not isinstance(context, dict):
        return None, "invalid"
    value = context.get(field)
    if value is None:
        return None, "missing"
    return (value, "matched") if _number(value) else (None, "invalid")


def _context_comparisons(rows, field, bucket_definitions):
    counts = Counter()
    groups = defaultdict(list)
    for row in rows:
        value, status = _context_value(row, field)
        counts[status] += 1
        if status == "matched":
            groups[(row["season_year"], row["game_type"])].append((value, row["stat_value"]))
    buckets = []
    for key, label, lower, upper in bucket_definitions:
        strata = []
        for (season, game_type), observations in sorted(groups.items()):
            target, baseline = [], []
            for value, stat in observations:
                (target if value >= lower and (upper is None or value < upper) else baseline).append(stat)
            strata.append(_stratum(target, baseline, minimum_target=5, season_year=season, game_type=game_type))
        buckets.append({"key": key, "label": label, "min_inclusive": lower, "max_exclusive": upper,
                        **_aggregate(strata), "strata": strata})
    return {"available": any(b["available"] for b in buckets), "context_field": field,
            "method": "Each bucket versus other known-context games in the same season and game type; stratum baseline means weighted by bucket appearance counts.",
            "small_sample_threshold": {"target_games": 5, "baseline_games": 5, "applies_to_each_included_stratum": True},
            "coverage": {"eligible_stat_rows": len(rows), "matched_context_rows": counts["matched"],
                         "missing_context_rows": counts["missing"], "invalid_context_rows": counts["invalid"]},
            "buckets": buckets}


def _attach_alternate(primary, alternate):
    count_fields = ("target_games", "baseline_games", "included_strata", "excluded_target_games")
    if any(primary[field] != alternate[field] for field in count_fields):
        primary["without_unverified_participation"] = {
            field: alternate[field] for field in (*COMPARISON_FIELDS, "season_year", "game_type", "included", "reason")
            if field in alternate}


def _travel_transitions(rows):
    """Distance comparisons condition on designated fixture sides, not geography."""
    groups = {key: [] for key, _ in TRAVEL_TRANSITIONS}
    counts = Counter()
    for row in rows:
        context = row.get("context")
        transition = context.get("travel_transition") if isinstance(context, dict) else None
        if transition is None:
            counts["missing"] += 1
        elif not isinstance(transition, str) or transition not in groups:
            counts["invalid"] += 1
        else:
            counts["matched"] += 1
            groups[transition].append(row)
    transitions = []
    for key, label in TRAVEL_TRANSITIONS:
        comparison = _context_comparisons(groups[key], "venue_distance_km", TRAVEL_BUCKETS)
        comparison["method"] = "Distance band versus other known distances with the same previous/current designated home-away transition, season and game type; baseline means weighted by target appearances."
        previous, current = key.split("_to_")
        transitions.append({"key": key, "label": label, "previous_designation": previous,
                            "current_designation": current, **comparison})
    return {"transitions": transitions,
            "transition_definition": "Previous club fixture's designated home/away side → current fixture's designated side, within the same season. This is not a player's travel itinerary or a venue's home-ground status.",
            "transition_coverage": {"eligible_stat_rows": len(rows), "matched_context_rows": counts["matched"],
                                    "missing_context_rows": counts["missing"], "invalid_context_rows": counts["invalid"]}}


def _attach_sensitivity(primary, alternate):
    _attach_alternate(primary["finals"]["aggregate"], alternate["finals"]["aggregate"])
    alternate_seasons = {s["season_year"]: s for s in alternate["finals"]["per_season"]}
    for season in primary["finals"]["per_season"]:
        other = alternate_seasons.get(season["season_year"])
        if other is None:
            other = _stratum([], [], minimum_target=3, season_year=season["season_year"])
        _attach_alternate(season, other)
    containers = [(primary[family], alternate[family]) for family in ("rest", "travel")]
    containers.extend(zip(primary["travel"]["transitions"], alternate["travel"]["transitions"]))
    for primary_context, alternate_context in containers:
        alternate_buckets = {b["key"]: b for b in alternate_context["buckets"]}
        for bucket in primary_context["buckets"]:
            other_bucket = alternate_buckets[bucket["key"]]
            _attach_alternate(bucket, other_bucket)
            strata = {(s["season_year"], s["game_type"]): s for s in other_bucket["strata"]}
            for stratum in bucket["strata"]:
                other = strata.get((stratum["season_year"], stratum["game_type"]))
                if other is None:
                    other = _stratum([], [], minimum_target=5, season_year=stratum["season_year"],
                                     game_type=stratum["game_type"])
                _attach_alternate(stratum, other)


def calculate_player_impact(rows, *, stat, season_from=None, season_to=None):
    """Compare one player's appearances; caller supplies verified player records.

    Filters are inclusive. Counts refer to rows after conservative duplicate and
    stat validation, except coverage.input_rows/exclusion_reasons. No source or
    participation is inferred here: caller supplies recorded appearances and any
    participation_unverified flag. Only the literal boolean True activates that
    flag; arbitrary truthy metadata is not treated as participation evidence.
    """
    if not isinstance(stat, str) or stat not in VALID_STATS:
        raise ValueError("Unsupported AFL stat")
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise ValueError("rows must be a list of at most 10,000 appearances")
    if any(value is not None and not _positive_int(value) for value in (season_from, season_to)):
        raise ValueError("Season limits must be positive integers")
    if season_from is not None and season_to is not None and season_from > season_to:
        raise ValueError("Season range is reversed")
    ids = Counter(r["game_id"] for r in rows if isinstance(r, dict) and _positive_int(r.get("game_id")))
    eligible, excluded = [], Counter()
    for row in rows:
        if not isinstance(row, dict):
            reason = "invalid_record"
        elif not _positive_int(row.get("game_id")):
            reason = "invalid_game_id"
        elif ids[row["game_id"]] > 1:
            reason = "duplicate_game_id"
        elif not _positive_int(row.get("season_year")):
            reason = "invalid_season"
        elif ((season_from is not None and row["season_year"] < season_from)
              or (season_to is not None and row["season_year"] > season_to)):
            reason = "season_outside_range"
        elif not isinstance(row.get("game_type"), str) or row["game_type"] not in GAME_TYPES:
            reason = "invalid_game_type"
        elif row.get("stat_value") is None:
            reason = "missing_stat"
        elif not _number(row["stat_value"]):
            reason = "invalid_stat"
        else:
            eligible.append(row)
            continue
        excluded[reason] += 1
    groups = defaultdict(lambda: defaultdict(list))
    for row in eligible:
        groups[row["season_year"]][row["game_type"]].append(row["stat_value"])
    seasons = [_stratum(g["Finals"], g["Regular Season"], minimum_target=3, season_year=season)
               for season, g in sorted(groups.items())]
    rest = _context_comparisons(eligible, "start_gap_hours", REST_BUCKETS)
    travel = _context_comparisons(eligible, "venue_distance_km", TRAVEL_BUCKETS)
    travel.update(_travel_transitions(eligible))
    result = {"schema_version": 1, "stat": stat, "season_range": {"from": season_from, "to": season_to},
            "coverage": {"input_rows": len(rows), "eligible_stat_rows": len(eligible),
                         "excluded_rows": sum(excluded.values()), "exclusion_reasons": dict(sorted(excluded.items())),
                         "rest_context_rows": rest["coverage"]["matched_context_rows"],
                         "travel_context_rows": travel["coverage"]["matched_context_rows"]},
            "finals": {"method": "Finals versus same-season regular season; regular-season expectations weighted by each eligible season's finals appearance count.",
                       "small_sample_threshold": {"target_games": 3, "baseline_games": 5, "applies_to_each_included_stratum": True},
                       "aggregate": _aggregate(seasons), "per_season": seasons},
            "rest": rest, "travel": travel,
            "limitations": ["Descriptive associations, not causal uplift, forecasts or changes to player hit rates.",
                            "Small-sample thresholds are display warnings, not statistical validity tests.",
                            "Travel is approximate distance between consecutive grounds, not actual player travel.",
                            "Turnaround is between team match starts, not player recovery time.",
                            "Unknown context is excluded from both target and baseline; exploring buckets can introduce selection bias."]}
    flagged = sum(row.get("participation_unverified") is True for row in eligible)
    result["data_quality"] = {
        "unverified_participation_rows": flagged,
        "sensitivity_method": "Primary results retain recorded stats. The separate sensitivity omits only explicitly flagged eligible appearances; it does not establish DNP status or correct the source. Genuine all-zero appearances may exist.",
    }
    if flagged:
        # Use already validated rows: removing a flagged duplicate must never
        # resurrect another copy that the primary calculation excluded. No True
        # flags remain, so this invokes at most one additional calculation.
        alternate = calculate_player_impact(
            [row for row in eligible if row.get("participation_unverified") is not True], stat=stat)
        _attach_sensitivity(result, alternate)
    return result
