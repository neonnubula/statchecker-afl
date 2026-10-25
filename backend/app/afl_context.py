"""Independent AFL schedule evidence; never rewrites the player statistics database.

Provider identities stay in their own namespace. A venue-to-venue distance is a
geographic proxy, not a team's itinerary or a measured effect on performance.
"""
from datetime import datetime, timedelta, timezone
import math
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

LEAGUE_ZONE = ZoneInfo("Australia/Melbourne")
METHOD = (
    "Turnaround is the gap between match starts, not recovery time. Calendar gaps "
    "and off-days use Australia/Melbourne consistently. Previous matches and workload "
    "are observed within this season snapshot; missing source games can affect them. "
    "Gaps to scheduled matches use scheduled starts and may change. "
    "Distance is straight-line between consecutive grounds, not actual travel. "
    "No player identity joins, betting probabilities or umpire effects are inferred."
)


def _integer(value, name, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(f"Invalid {name}")
    return value


def _text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing {name}")
    return value.strip()


def _instant(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Retrieval timestamp must include a timezone")
    return result.astimezone(timezone.utc)


def validate_venues(venues):
    """Require source attribution and real coordinates; unresolved grounds stay null."""
    for name, venue in venues.items():
        _text(name, "venue name")
        _text(venue.get("source_url"), "venue source")
        source = urlparse(venue["source_url"])
        if source.scheme != "https" or not source.netloc or source.username or source.password:
            raise ValueError("Venue source must be HTTPS")
        if venue.get("license_url"):
            license_url = urlparse(venue["license_url"])
            if license_url.scheme != "https" or not license_url.netloc or license_url.username or license_url.password:
                raise ValueError("Venue license URL must be HTTPS")
        ZoneInfo(venue["timezone"])
        lat, lon = venue.get("latitude"), venue.get("longitude")
        if not all(type(v) in (int, float) and math.isfinite(v) for v in (lat, lon)):
            raise ValueError("Venue coordinates must be finite numbers")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("Venue coordinates out of range")


def normalize_snapshot(envelope, venues=None):
    venues = venues or {}
    validate_venues(venues)
    source = urlparse(envelope["source_url"])
    query = parse_qs(source.query, keep_blank_values=True)
    if (not isinstance(envelope.get("source"), str) or envelope["source"].lower() != "squiggle" or source.scheme != "https"
            or source.netloc != "api.squiggle.com.au" or source.path not in ("", "/")
            or source.fragment
            or set(query) != {"q", "year"} or query["q"] != ["games"] or len(query["year"]) != 1):
        raise ValueError("Expected a complete single-season Squiggle games query")
    year = int(query["year"][0])
    if not 2000 <= year <= 2100:
        raise ValueError("Unsupported season")
    retrieved = _instant(envelope["retrieved_at"])
    if retrieved > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError("Retrieval timestamp cannot be in the future")
    rows = envelope["payload"].get("games")
    if not isinstance(rows, list) or not rows or len(rows) > 400:
        raise ValueError("Missing or unexpectedly large season response")
    games, ids, team_names = [], set(), {}
    for row in rows:
        gid = "squiggle:" + str(_integer(row["id"], "game identity", 1))
        if gid in ids:
            raise ValueError("Duplicate game identity")
        ids.add(gid)
        if type(row["year"]) is not int or row["year"] != year:
            raise ValueError("Unexpected season")
        complete = _integer(row["complete"], "completion")
        def team(side):
            # Future finals can carry genuine source placeholders. Never invent
            # an identity or connect different unresolved teams through a null ID.
            if row[side+"teamid"] is None and row[side+"team"] is None and complete == 0:
                return None
            return "squiggle:" + str(_integer(row[side+"teamid"], "team identity", 1))
        home, away = team("h"), team("a")
        if home and home == away:
            raise ValueError("Home and away team must differ")
        for tid, name in ((home, row["hteam"]), (away, row["ateam"])):
            if tid is None:
                continue
            name = _text(name, "team name")
            if tid in team_names and team_names[tid] != name:
                raise ValueError("Conflicting team names for provider identity")
            team_names[tid] = name
        instant = datetime.fromtimestamp(_integer(row["unixtime"], "start timestamp", 1), timezone.utc)
        if instant.astimezone(LEAGUE_ZONE).year != year:
            raise ValueError("Match start outside season")
        # Squiggle's date/tz is a reference clock, NOT the venue's timezone.
        reference = datetime.fromisoformat(row["date"] + row["tz"])
        if reference.tzinfo is None or reference.astimezone(timezone.utc) != instant:
            raise ValueError("Conflicting source start timestamps")
        if complete > 100 or (complete > 0 and instant > retrieved):
            raise ValueError("Invalid completed match")
        final_type = _integer(row["is_final"], "final type")
        if final_type > 7:
            raise ValueError("Unknown finals classification")
        venue_name = _text(row["venue"], "venue")
        venue = venues.get(venue_name)
        local = datetime.fromisoformat(row["localtime"])
        if local.tzinfo is not None:
            raise ValueError("Expected source local wall-clock time")
        if venue and instant.astimezone(ZoneInfo(venue["timezone"])).replace(tzinfo=None) != local:
            raise ValueError("Venue timezone disagrees with source local time")
        games.append({"game_id": gid, "season": year, "round": _integer(row["round"], "round"),
                      "round_name": _text(row["roundname"], "round name"), "is_final": final_type > 0,
                      "final_type": final_type, "starts_at": instant.isoformat(),
                      "source_local_time": local.isoformat(), "venue": venue_name,
                      "venue_evidence": venue, "home_team_id": home, "away_team_id": away,
                      "home_team": team_names.get(home), "away_team": team_names.get(away),
                      "state": "final" if complete == 100 else "scheduled" if complete == 0 else "in_progress"})
    games.sort(key=lambda g: (g["starts_at"], g["game_id"]))
    return games


def _distance(a, b):
    lat1, lat2 = math.radians(a["latitude"]), math.radians(b["latitude"])
    dlat = lat2 - lat1
    dlon = math.radians(b["longitude"] - a["longitude"])
    hav = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2)**2
    return round(6371.0088 * 2 * math.asin(math.sqrt(min(1, max(0, hav)))), 1)


def build_context(envelope, venues=None):
    games = normalize_snapshot(envelope, venues)
    history, records = {}, []
    for game in games:
        instant = _instant(game["starts_at"])
        teams = {}
        for tid in (game["home_team_id"], game["away_team_id"]):
            if tid is None:
                continue
            previous_games = history.setdefault(tid, [])
            previous = previous_games[-1] if previous_games else None
            context = {"previous_game_id": previous["game_id"] if previous else None,
                       "previous_venue": previous["venue"] if previous else None,
                       "status": "no_previous_observed_match", "start_gap_hours": None,
                       "calendar_gap_days": None, "off_days": None,
                       "venue_distance_km": None, "venue_clock_shift_hours": None,
                       "games_previous_14_days": None, "games_previous_28_days": None}
            if previous:
                prior_start = _instant(previous["starts_at"])
                if prior_start >= instant:
                    raise ValueError("Overlapping team start timestamps")
                context["status"] = ("scheduled_gap" if game["state"] == "scheduled" else "observed") if previous["state"] == "final" else "previous_match_not_final"
                if previous["state"] == "final":
                    gap = (instant.astimezone(LEAGUE_ZONE).date() - prior_start.astimezone(LEAGUE_ZONE).date()).days
                    context.update(start_gap_hours=round((instant-prior_start).total_seconds()/3600, 2),
                                   calendar_gap_days=gap, off_days=max(0, gap-1))
                    a, b = previous["venue_evidence"], game["venue_evidence"]
                    if a and b:
                        context["venue_distance_km"] = _distance(a, b)
                        # Both offsets evaluated at this match's instant: no false travel from DST alone.
                        shift = instant.astimezone(ZoneInfo(b["timezone"])).utcoffset() - instant.astimezone(ZoneInfo(a["timezone"])).utcoffset()
                        context["venue_clock_shift_hours"] = shift.total_seconds()/3600
                    for days in (14, 28):
                        window = [g for g in previous_games if instant-timedelta(days=days) <= _instant(g["starts_at"]) < instant]
                        if all(g["state"] == "final" for g in window):
                            context[f"games_previous_{days}_days"] = len(window)
            teams[tid] = context
            previous_games.append(game)
        records.append({**game, "teams": teams})
    return {"schema_version": 1, "source": "squiggle", "source_url": envelope["source_url"],
            "retrieved_at": envelope["retrieved_at"], "method": METHOD,
            "coverage": {"games": len(records), "completed": sum(g["state"] == "final" for g in records),
                         "unresolved_team_games": sum(g["home_team_id"] is None or g["away_team_id"] is None for g in records),
                         "venues_with_coordinates": len({g["venue"] for g in records if g["venue_evidence"]}),
                         "venues_total": len({g["venue"] for g in records}),
                         "scope": "Single-season source snapshot; completeness not independently certified"},
            "games": records}
