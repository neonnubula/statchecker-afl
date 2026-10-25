#!/usr/bin/env python3
"""Save one season of the free Squiggle AFL schedule as a source envelope.

The envelope feeds scripts/afl_build_impact_history.py, which builds the
data/afl_impact_history.json sidecar used by the player impact view.
Squiggle asks API users to identify themselves: set SCHEDULE_USER_AGENT to a
string that includes your contact details. See https://api.squiggle.com.au/.

Usage:
    SCHEDULE_USER_AGENT="my-fork (me@example.com)" \\
      python scripts/afl_fetch_schedule_snapshot.py --season 2025 --output snapshots/2025.json
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    agent = os.getenv("SCHEDULE_USER_AGENT", "").strip()
    if not agent:
        print("Set SCHEDULE_USER_AGENT to identify yourself to Squiggle first.", file=sys.stderr)
        return 1
    url = f"https://api.squiggle.com.au/?q=games;year={args.season}"
    response = httpx.get(url, headers={"User-Agent": agent, "Accept": "application/json"}, timeout=30)
    response.raise_for_status()
    envelope = {"source": "squiggle", "source_url": url,
                "retrieved_at": datetime.now(timezone.utc).isoformat(), "payload": response.json()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(envelope) + "\n")
    print(f"Saved {len(envelope['payload'].get('games', []))} games to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
