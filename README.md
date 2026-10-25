# StatChecker AFL

Open-source AFL player research. Pick a player and a line, and see how often they cleared it across past games. You can filter by opponent, venue, home or away, season, rest days and time of day. It also covers same-game multis, multi builds and match travel context.

**This repository ships no data.** There are no players, games, stats or fixtures in it. You source your own data, load it into the database schema described in [SCHEMA.md](SCHEMA.md), and the app works on top of it. The scripts below do that for you if you use API-Sports.

> Historical results describe past games only. They are not predictions or betting advice. Bet responsibly.

## What's inside

| Folder | What it is |
| --- | --- |
| `backend/` | FastAPI + SQLite research API, the database schema, and data-loading scripts |
| `frontend/` | Next.js app: Single search, SGM, Multi, Match context and a browser-local Vault |
| `SCHEMA.md` | Every table and column, plus how API-Sports responses map onto them |
| `PROMPTS.md` | Copy-paste prompts for an AI coding assistant to help you source and load data |

## Getting data (recommended: API-Sports)

We recommend **[API-Sports](https://api-sports.io/)** for AFL data. The loaders in `backend/scripts/` are built for its AFL API ([documentation](https://api-sports.io/documentation/afl/v1)).

1. Create an account at [api-sports.io](https://api-sports.io/) and subscribe to the AFL API. A free plan exists with a small daily request limit. A paid plan makes a full historical load practical.
2. Copy your API key from the API-Sports dashboard.
3. Read and follow API-Sports' terms for how you can use and display their data. You are responsible for your own data licensing.

Prefer another source? That works too. Load it into the tables in [SCHEMA.md](SCHEMA.md) and the app won't know the difference. [PROMPTS.md](PROMPTS.md) has prompts for writing your own importer.

## Quick start

Requirements: Python 3.11+, Node.js 20+.

### 1. Backend

```sh
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env           # then fill in AFL_API_KEY and INTERNAL_API_SECRET
python scripts/init_db.py      # creates an empty database/afl_stats.db from database/schema.sql
```

### 2. Load your data

With `AFL_API_KEY` set in `backend/.env`:

```sh
# Everything at once (players, games and player stats for every season), resumable:
python scripts/collect_all_seasons.py

# Or step by step for one season:
python scripts/get_all_players.py
python scripts/get_games_for_season.py 2025
python scripts/get_stats_for_season.py 2025
python scripts/run_update_days_since_last_game.py
```

Collection is checkpointed, so you can stop and resume. After the initial load, `python scripts/auto_update_round.py` fetches stats for newly finished games. Run it on a schedule, such as a nightly cron or a GitHub Action.

Check how many requests your plan allows before a full load. The client waits between requests to stay under the per-minute limit.

### 3. Run it

```sh
# terminal 1
cd backend && uvicorn app.main:app --reload --port 8000

# terminal 2
cd frontend
npm install
cp .env.example .env.local     # use the same INTERNAL_API_SECRET as the backend
npm run dev                    # http://localhost:3000
```

API docs are at http://localhost:8000/docs.

## Optional extras

These features work without extra setup, but get better with more inputs. All of them are optional.

| Feature | What to do |
| --- | --- |
| Match context (travel, turnaround) | Create `backend/data/afl_venues.json` with venue coordinates and time zones (format in SCHEMA.md). The schedule itself comes from the free [Squiggle API](https://api.squiggle.com.au/). Set `SCHEDULE_USER_AGENT` to identify yourself to Squiggle. |
| Player impact history | `python scripts/afl_fetch_schedule_snapshot.py --season 2025 --output snapshots/2025.json`, then `python scripts/afl_build_impact_history.py --snapshot snapshots/2025.json --venues data/afl_venues.json --output data/afl_impact_history.json` |
| "Top picks" before typing | Set `NEXT_PUBLIC_FEATURED_PLAYERS` in `frontend/.env.local` to player names in your database |
| Run summaries by email | Set `RESEND_API_KEY` and `NOTIFY_EMAIL` for `auto_update_round.py` |

## Deploying

- **Backend:** any host that runs Python and keeps a persistent disk for the SQLite file, such as Railway, Fly.io, Render or a VPS. Set `DB_PATH` to the file on the persistent disk. Set `REQUIRE_INTERNAL_SECRET=true` so the API refuses research requests without the shared secret.
- **Frontend:** any Next.js host, such as Vercel or Netlify. Set `NEXT_PUBLIC_API_BASE_URL` and `INTERNAL_API_SECRET`.
- Add the frontend's URL to the backend's `ALLOWED_ORIGINS`.
- **There are no user accounts.** Anyone who can reach your frontend can use it. Add your own authentication before you share it widely. The built-in request throttle lives in `frontend/src/lib/rate-limit.ts`.

## Tests

```sh
cd backend && python -m pytest -q
cd frontend && npm run build
```

Tests use small synthetic fixtures and never need real data or an API key.

## License

MIT. See [LICENSE](LICENSE). Data you load is subject to its provider's own terms.
