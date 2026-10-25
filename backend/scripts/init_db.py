#!/usr/bin/env python3
"""Create an empty StatChecker AFL database from database/schema.sql.

Usage:
    python scripts/init_db.py                       # database/afl_stats.db
    python scripts/init_db.py --database /tmp/afl.db
    python scripts/init_db.py --force               # replace an existing file
"""
import argparse
import os
import sqlite3
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SCHEMA = BACKEND / "database" / "schema.sql"
DEFAULT_DB = Path(os.getenv("DB_PATH", BACKEND / "database" / "afl_stats.db"))


def init_db(path: Path, force: bool = False) -> Path:
    path = Path(path)
    if path.exists():
        if not force:
            raise FileExistsError(f"{path} already exists. Use --force to replace it.")
        path.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA.read_text())
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        created = init_db(args.database, args.force)
    except FileExistsError as exc:
        print(exc, file=sys.stderr)
        return 1
    print(f"Created empty AFL database at {created}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
