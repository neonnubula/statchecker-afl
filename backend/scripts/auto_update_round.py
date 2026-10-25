#!/usr/bin/env python3
"""
Auto-update AFL stats: poll API for finished games, fetch stats for any not yet
in the DB, recompute days-since-last-game, run validation, email a summary.

Designed to be run nightly by GitHub Actions or manually. Missing finished
fixtures stop the run before collection. Existing rows are not a completeness
check, and this local database does not establish deployed freshness.

Usage:
    python scripts/auto_update_round.py
    python scripts/auto_update_round.py --dry-run
    python scripts/auto_update_round.py --season 2026

Env:
    AFL_API_KEY      required
    DB_PATH          optional, defaults to database/afl_stats.db
    RESEND_API_KEY   optional, no email if missing
    NOTIFY_EMAIL     optional, no email if missing

Exits:
    0  success or no-op
    1  failure (incomplete fixture inventory, API error, partial fetch, test failure)
"""

import argparse
import os
import subprocess
import sys
import traceback
from datetime import datetime

_current_file = os.path.abspath(__file__)
_scripts_dir = os.path.dirname(_current_file)
_backend_dir = os.path.dirname(_scripts_dir)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from scrapers.api_client import APIClient
from database.db_manager_api import DatabaseManager
from scripts.get_stats_for_season import (
    process_game_stats,
    load_checkpoint,
    save_checkpoint,
    add_processed_game,
    get_game_id_by_api_id,
)
from scripts.run_update_days_since_last_game import update_days_fast
from scripts.notify import send_notification

DEFAULT_SEASON = 2026
DEFAULT_DB_PATH = os.path.join(_backend_dir, "database", "afl_stats.db")


def _fail(reason: str, body: str = "") -> int:
    """Print + email + return exit code 1. Notification failures are swallowed."""
    print(f"FAILURE: {reason}")
    if body:
        print(body)
    send_notification(
        subject=f"AFL stats auto-update FAILED: {reason}",
        body=f"{reason}\n\n{body}" if body else reason,
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Auto-update AFL player stats from api-sports.io")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be fetched without DB writes, tests, or email")
    parser.add_argument("--season", type=int, default=DEFAULT_SEASON,
                        help=f"AFL season year (default {DEFAULT_SEASON})")
    args = parser.parse_args()

    season = args.season
    api_key = os.getenv("AFL_API_KEY", "")
    db_path = os.getenv("DB_PATH", DEFAULT_DB_PATH)

    if not api_key:
        return _fail("AFL_API_KEY not set in environment")
    if not os.path.exists(db_path):
        return _fail(f"Database not found at {db_path}")

    started = datetime.utcnow()
    print(f"[{started:%Y-%m-%d %H:%M:%S} UTC] Auto-update starting "
          f"(season={season}, dry_run={args.dry_run}, db={db_path})")

    api_client = APIClient(api_key)
    db = DatabaseManager(db_path)

    try:
        print("Fetching game list with statuses from API...")
        games = api_client.get_games_with_status(season)
        if not games:
            return _fail("API returned no games for season", f"season={season}")

        finished = [g for g in games if g.get("status_short") == "FT"]
        print(f"API: {len(games)} total games, {len(finished)} finished")

        # Preflight the entire fixture inventory before collecting any stats.
        to_fetch = []
        missing_fixtures = []
        for g in finished:
            api_game_id = g["api_game_id"]
            game_info = get_game_id_by_api_id(db, api_game_id)
            if not game_info:
                # Do not silently skip new finals or create unreviewed fixtures.
                missing_fixtures.append(api_game_id)
                continue
            if db.stats_exist_for_game(game_info["game_id"]):
                continue
            to_fetch.append((api_game_id, game_info))

        if missing_fixtures:
            print("INCOMPLETE SOURCE: finished games are missing from the games table: "
                  + ", ".join(str(game_id) for game_id in sorted(set(missing_fixtures))))
            print("No stats were fetched or inserted. Reconcile the missing fixtures through "
                  "a verified import before retrying. Check your deployed database separately; "
                  "this source database does not establish live freshness.")
            return 1

        if not to_fetch:
            print("No recorded finished games are empty. Existing player-row completeness "
                  "and deployed freshness were not verified.")
            return 0

        print(f"Will fetch stats for {len(to_fetch)} game(s):")
        for api_game_id, _ in to_fetch:
            print(f"  - api_game_id={api_game_id}")

        if args.dry_run:
            print("[DRY RUN] Stopping before fetch.")
            return 0

        # Fetch each game; keep going on per-game errors so partial success is OK
        checkpoint = load_checkpoint(season) or {
            "season": season,
            "processed_games": [],
            "total_stats": 0,
            "api_requests": 0,
        }
        per_game_summary = []
        per_game_errors = []
        total_stats = 0

        for api_game_id, game_info in to_fetch:
            try:
                stats_count = process_game_stats(api_client, db, api_game_id, game_info)
                if stats_count:
                    total_stats += stats_count
                    checkpoint = add_processed_game(checkpoint, api_game_id, stats_count)
                    save_checkpoint(season, checkpoint)
                    per_game_summary.append((api_game_id, stats_count))
                    print(f"  ✅ Game {api_game_id}: {stats_count} stats")
                else:
                    print(f"  ⚠️  Game {api_game_id}: no stats returned (will retry next cycle)")
            except Exception as e:
                msg = f"Game {api_game_id}: {type(e).__name__}: {e}"
                print(f"  ❌ {msg}")
                per_game_errors.append(msg)

        if total_stats == 0:
            if per_game_errors:
                return _fail(
                    "All targeted games failed",
                    "\n".join(per_game_errors),
                )
            print("Nothing was inserted. Exiting silently.")
            return 0

        print("Recomputing days_since_last_game...")
        update_days_fast(db_path)

        print("Running validation tests...")
        result = subprocess.run(
            [
                sys.executable, "-m", "pytest", "tests/test_weekly_snapshot.py",
                "-m", "not api_verify", "-q", "--no-header",
            ],
            cwd=_backend_dir,
            env={**os.environ, "DB_PATH": db_path},
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            tail = (result.stdout[-2000:] + "\n" + result.stderr[-2000:]).strip()
            return _fail(
                f"Validation tests failed after fetching {len(per_game_summary)} game(s)",
                tail,
            )

        # Build success email
        body_lines = [
            f"Auto-update succeeded at {datetime.utcnow():%Y-%m-%d %H:%M:%S} UTC",
            f"DB: {db_path}",
            f"",
            f"Games fetched: {len(per_game_summary)}",
            f"New stat rows: {total_stats}",
            f"",
            f"Per-game breakdown:",
        ]
        for api_game_id, stats_count in per_game_summary:
            row = db.conn.execute(
                """SELECT g.round_number, ht.team_name AS home, at.team_name AS away
                   FROM games g
                   JOIN teams ht ON g.home_team_id = ht.team_id
                   JOIN teams at ON g.away_team_id = at.team_id
                   WHERE g.api_game_id = ?""",
                (api_game_id,),
            ).fetchone()
            if row:
                body_lines.append(
                    f"  • R{row['round_number']} {row['home']} vs {row['away']} "
                    f"({api_game_id}) — {stats_count} stats"
                )
            else:
                body_lines.append(f"  • Game {api_game_id} — {stats_count} stats")

        if per_game_errors:
            body_lines.append("")
            body_lines.append("Per-game errors (other games still committed):")
            for e in per_game_errors:
                body_lines.append(f"  ⚠ {e}")

        elapsed = datetime.utcnow() - started
        body_lines.extend([
            "",
            f"Elapsed: {elapsed.total_seconds():.0f}s",
            f"API requests this run: {api_client.get_request_count()}",
        ])

        subject = f"AFL stats: {len(per_game_summary)} game(s), {total_stats} rows"
        send_notification(subject, "\n".join(body_lines))
        return 0

    except Exception as e:
        return _fail(f"Unexpected error: {type(e).__name__}: {e}", traceback.format_exc())
    finally:
        try:
            db.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
