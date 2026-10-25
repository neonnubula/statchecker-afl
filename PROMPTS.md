# Prompts for sourcing and loading your data

Paste these into an AI coding assistant (Claude Code, Cursor, Copilot Chat and so on) opened in this repository. Each one tells the assistant which files to read, so its answer fits this codebase. Replace anything in `<angle brackets>`.

Keep your API keys in `backend/.env`. Never paste a key into a chat.

---

### 1. Set up and load from API-Sports

```
Read README.md, SCHEMA.md and backend/scripts/collect_all_seasons.py.
I have an API-Sports AFL key in backend/.env as AFL_API_KEY. My plan allows
<N> requests per day. Help me:
1. create an empty database with scripts/init_db.py,
2. work out how many requests a full load of seasons <FIRST>-<LAST> needs and
   how many days that takes on my plan,
3. run the load in resumable batches, and
4. verify the result with SQL counts per season (games, players, stat rows)
   and flag any finished games that have no player_game_stats rows.
Don't change the schema.
```

### 2. Write an importer for a different data source

```
Read SCHEMA.md and backend/database/schema.sql. I have AFL data from
<describe source: CSV export / another API / spreadsheet> with these columns:
<paste the header row or a sample record with personal details removed>.
Write backend/scripts/import_<source>.py that:
- creates teams, venues, players and games idempotently (re-running must not
  duplicate rows),
- writes one player_game_stats row per player per game with the correct
  team_id, opponent_team_id, venue_id, location (Home/Away) and game_time
  (Day/Twilight/Night),
- stores NULL, not 0, for stats my source doesn't have,
- runs scripts/run_update_days_since_last_game.py at the end,
- has a --dry-run flag that prints what it would insert.
Add a pytest with a tiny synthetic sample.
```

### 3. Check data quality

```
Using the database at backend/database/afl_stats.db and SCHEMA.md, write and
run read-only SQL checks for:
- games with fewer than 40 or more than 46 player_game_stats rows,
- players who appear for two teams in the same game,
- disposals that don't equal kicks + handballs where both are present,
- duplicate players (same name and date of birth, different player_id),
- active players with zero or multiple is_current player_team_history rows.
Report counts and up to 10 examples each. Don't modify any data.
```

### 4. Keep it up to date automatically

```
Read backend/scripts/auto_update_round.py. Set up a scheduled job that runs it
nightly during the AFL season against my deployed database at <host / path>.
Use <GitHub Actions / cron on my server / my host's scheduler>. Store
AFL_API_KEY as a secret. Fail loudly if the run exits non-zero.
```

### 5. Build the venue file for match context

```
Read SCHEMA.md (the afl_venues.json section) and backend/app/afl_context.py
(validate_venues). List every venue_name in my venues table. For each one,
help me find its stadium coordinates and IANA time zone from a source I'm
allowed to reuse (for example OpenStreetMap, with attribution) and write
backend/data/afl_venues.json in the required format. Mark any venue you're
unsure about instead of guessing.
```

### 6. Roll the app over to a new season

```
Search backend/ and frontend/ for hard-coded season years (e.g. 2026) used as
"current season". List each place, explain what it controls, and propose a
single CURRENT_SEASON setting read from an environment variable.
```
