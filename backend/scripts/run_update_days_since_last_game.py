#!/usr/bin/env python3
"""
Recalculate days_since_last_game for all player_game_stats in the database.

Run this after adding new games/stats (e.g. after get_stats_for_season) so that
days_since_last_game is correct for the new data.

Usage:
    python scripts/run_update_days_since_last_game.py
    DB_PATH=/path/to/snapshot/afl_stats.db python scripts/run_update_days_since_last_game.py
"""

import os
import sys
import sqlite3
import time

_current_file = os.path.abspath(__file__)
_scripts_dir = os.path.dirname(_current_file)
_backend_dir = os.path.dirname(_scripts_dir)

DEFAULT_DB_PATH = os.path.join(_backend_dir, "database", "afl_stats.db")
DB_PATH = os.getenv("DB_PATH", DEFAULT_DB_PATH)


def update_days_fast(db_path: str):
    """Batch-update days_since_last_game using Python-side computation (avoids slow correlated UPDATEs)."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    print("  Reading all stat rows ordered by player and date...")
    rows = conn.execute("""
        SELECT pgs.stat_id, pgs.player_id, g.game_date
        FROM player_game_stats pgs
        JOIN games g ON pgs.game_id = g.game_id
        ORDER BY pgs.player_id, g.game_date
    """).fetchall()
    print(f"  Total rows: {len(rows)}")

    updates = []
    prev_player = None
    prev_date = None
    for r in rows:
        sid = r["stat_id"]
        pid = r["player_id"]
        gd = r["game_date"]
        if pid == prev_player and prev_date and gd:
            from datetime import date as dt_date
            try:
                d1 = dt_date.fromisoformat(prev_date)
                d2 = dt_date.fromisoformat(gd)
                days = (d2 - d1).days
            except Exception:
                days = None
        else:
            days = None
        updates.append((days, sid))
        prev_player = pid
        prev_date = gd

    print(f"  Writing {len(updates)} updates in batch...")
    conn.executemany("UPDATE player_game_stats SET days_since_last_game = ? WHERE stat_id = ?", updates)
    conn.commit()
    conn.close()


def main():
    print("Updating days_since_last_game for all player_game_stats...")
    print(f"Database: {DB_PATH}")
    if not os.path.exists(DB_PATH):
        print(f"ERROR: Database not found: {DB_PATH}")
        sys.exit(1)
    t0 = time.time()
    update_days_fast(DB_PATH)
    elapsed = time.time() - t0
    print(f"Done in {elapsed:.1f}s.")


if __name__ == "__main__":
    main()
