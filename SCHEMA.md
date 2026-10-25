# AFL data schema

The backend reads one SQLite database, `backend/database/afl_stats.db` by default (override it with `DB_PATH`). Create an empty one with `python scripts/init_db.py`. The exact SQL is in [`backend/database/schema.sql`](backend/database/schema.sql). This page explains it.

If your data comes from API-Sports, the scripts in `backend/scripts/` fill every table for you. If it comes from anywhere else, write rows that follow the rules below.

## Tables at a glance

```
teams ─┐                  ┌─ players ── player_team_history
       ├── games ─────────┤
venues ┘                  └─ player_game_stats   (one row per player per game)
fixtures   (upcoming games, same shape as games)
api_player_id_aliases   (maps duplicate provider player IDs to one player)
search_feedback         (written by the app; leave empty)
vw_complete_game_stats  (view joining everything; read-only)
```

## `teams`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `team_id` | INTEGER PK | auto | Your internal ID |
| `team_name` | TEXT, unique | yes | Full club name, e.g. `Sydney Swans`. Use one consistent name per club. |
| `is_active` | BOOLEAN | | `1` for current clubs |
| `api_team_id` | INTEGER, unique | recommended | Provider's team ID (API-Sports `/teams` → `id`) |

## `venues`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `venue_id` | INTEGER PK | auto | |
| `venue_name` | TEXT, unique | yes | As your provider names it (API-Sports `/games` → `venue`) |

## `players`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `player_id` | INTEGER PK | auto | |
| `player_name` | TEXT | yes | Display name, `First Last` |
| `first_name`, `last_name` | TEXT | | Used for search |
| `date_of_birth` | DATE | | `YYYY-MM-DD` |
| `debut_year` | INTEGER | | |
| `api_player_id` | INTEGER, unique | recommended | Provider's player ID (API-Sports `/players` → `id`) |

## `games`

Completed games only. Put future games in `fixtures`.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `game_id` | INTEGER PK | auto | |
| `season_year` | INTEGER | yes | e.g. `2025` |
| `round_number` | INTEGER | | `NULL` for finals |
| `game_type` | TEXT | yes | Exactly `Pre-Season`, `Regular Season` or `Finals` |
| `game_date` | DATE | yes | `YYYY-MM-DD`, local date |
| `game_time` | TIME | | `HH:MM:SS`, local start time |
| `venue_id` | INTEGER FK | yes | → `venues` |
| `home_team_id`, `away_team_id` | INTEGER FK | yes | → `teams`; must differ |
| `api_game_id` | INTEGER, unique | recommended | Provider's game ID (API-Sports `/games` → `game.id`) |

## `player_game_stats`

One row per player per game. This is the table that powers every search.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `player_id` | INTEGER FK | yes | → `players` |
| `game_id` | INTEGER FK | yes | → `games`. `(player_id, game_id)` is unique. |
| `team_id` | INTEGER FK | yes | The club the player played for **in this game** |
| `opponent_team_id` | INTEGER FK | yes | The other club in this game |
| `venue_id` | INTEGER FK | yes | Same as the game's venue |
| `location` | TEXT | yes | `Home` or `Away`, from the player's side |
| `game_time` | TEXT | | `Day` (before 15:00), `Twilight` (15:00–17:59) or `Night` (18:00+) |
| `disposals` | INTEGER | yes | `kicks + handballs` |
| `goals` | INTEGER | yes | |
| `marks`, `tackles` | INTEGER | yes | Default `0` |
| `kicks`, `handballs`, `clearances`, `hit_outs` | INTEGER | | `NULL` when your source doesn't record them. Don't write `0` for "unknown". |
| `days_since_last_game` | INTEGER | derived | Run `python scripts/run_update_days_since_last_game.py` after loading |

API-Sports mapping: `/games/statistics/players?id=<game>` returns each team's players with `kicks`, `handballs`, `disposals`, `goals.total`, `marks`, `tackles`, `clearances`, `hitouts`. `scripts/get_stats_for_season.py` does this mapping.

## `player_team_history`

Drives "current roster" filters and player search.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `player_id`, `team_id` | INTEGER FK | yes | |
| `start_date` | DATE | yes | |
| `end_date` | DATE | | `NULL` while current |
| `is_current` | BOOLEAN | yes | Exactly one `1` row per active player |

The loaders keep this table updated as they see a player appear for a club.

## `fixtures`

Upcoming games, used by the "Next game" banner and filters. Same meaning as `games`, plus `round_name` (e.g. `Round 5`, `Qualifying Final`).

## `api_player_id_aliases`

Providers sometimes issue two IDs for one person. Map the extra ID to your canonical `players.player_id` here instead of creating a duplicate player.

## Season and time conventions

- **Seasons** are calendar years (`2025`).
- The API treats **2026 as the current season** in a few places (player search ranking and roster lookups in `backend/app/main.py`). Search the code for `2026` and update it when a new season starts.
- Store **local dates and times** for games.

## Optional sidecar files (`backend/data/`)

Leave these out and the related features say they're unavailable. Everything else keeps working. All of them are validated on load.

### `afl_venues.json`: venue coordinates for travel context

```json
{
  "Venue Name As In venues Table": {
    "latitude": -37.8,
    "longitude": 144.9,
    "timezone": "Australia/Melbourne",
    "source_url": "https://www.openstreetmap.org/way/<id>",
    "attribution": "© OpenStreetMap contributors",
    "license": "ODbL-1.0",
    "license_url": "https://opendatacommons.org/licenses/odbl/1-0/"
  }
}
```

`source_url` must be HTTPS. If you use OpenStreetMap coordinates, keep the attribution as its license requires.

### `afl_impact_history.json`: player impact history

Built for you by `scripts/afl_build_impact_history.py` from Squiggle schedule snapshots. See the README.

### `afl_fixture_confirmations.json` and `afl_remaining_fixtures.json`

These are optional, hand-reviewed overlays for fixtures your schedule source hasn't confirmed yet, such as finals. Their exact validation rules are in `app/afl_context_api.py` (`_annotate_confirmations`) and `app/afl_fixture_overlay.py`. Most forks never need them.
