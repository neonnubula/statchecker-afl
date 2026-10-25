import os
import secrets
import sqlite3
import time
from threading import Lock
from typing import Any, Dict, List, Literal, Optional, Tuple
from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import logging
from collections import defaultdict
from datetime import datetime

# ============================================================================
# DATABASE CONFIGURATION
# ============================================================================
# Current: SQLite (fast for read-heavy workloads with caching)
# 
# When to migrate to PostgreSQL:
# - 100+ concurrent users hitting cache misses
# - Need concurrent writes from multiple services
# - Database file > 10GB
# - Need replication/high availability
#
# Migration path: Code is already SQL-agnostic. To switch:
# 1. Add psycopg2 dependency
# 2. Replace sqlite3.connect() with psycopg2.connect(DATABASE_URL)
# 3. Update connection handling (PostgreSQL uses connection pooling)
# 4. Same SQL queries work (minor syntax differences)
# ============================================================================

# Calculate database path relative to this file's location
# __file__ is app/main.py, so we go up one level to backend/, then into database/
_current_file = os.path.abspath(__file__)  # /path/to/backend/app/main.py
_app_dir = os.path.dirname(_current_file)  # /path/to/backend/app
_backend_dir = os.path.dirname(_app_dir)  # /path/to/backend
DEFAULT_DB_PATH = os.path.join(_backend_dir, "database", "afl_stats.db")

# Allow override via environment variable
DB_PATH = os.getenv("DB_PATH", DEFAULT_DB_PATH)

# Ensure the path is absolute
DB_PATH = os.path.abspath(DB_PATH)

# Cache TTL: Historical stats don't change, so we can cache aggressively
# Increase this as you scale - 1 hour (3600) or even 24 hours (86400) is fine
CACHE_TTL_SECONDS = max(int(os.getenv("CACHE_TTL_SECONDS", "3600")), 0)  # Default: 1 hour

_stats_cache: Dict[Tuple[Any, ...], Tuple[float, Dict[str, int]]] = {}
_cache_lock = Lock()
_stats_cache_generation = 0

# Performance tracking
_perf_stats = {
    "query_times": [],  # List of query execution times in ms
    "cache_hits": 0,
    "cache_misses": 0,
    "total_requests": 0,
    "player_resolution_times": [],  # Time to resolve player_id from name
}
_perf_lock = Lock()

INDEX_STATEMENTS = [
    "CREATE INDEX IF NOT EXISTS idx_pgs_player_disposals ON player_game_stats(player_id, disposals)",
    "CREATE INDEX IF NOT EXISTS idx_pgs_player_goals ON player_game_stats(player_id, goals)",
]

SEARCH_FEEDBACK_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS search_feedback (
    feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_type TEXT NOT NULL CHECK (feedback_type IN ('instant', 'bad_delay')),
    player_name TEXT,
    player_id INTEGER,
    stat TEXT NOT NULL,
    threshold REAL NOT NULL,
    strict_over BOOLEAN DEFAULT 0,
    season_from INTEGER,
    season_to INTEGER,
    location TEXT,
    opponent TEXT,
    venue TEXT,
    game_type TEXT,
    response_time_ms INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_type ON search_feedback(feedback_type);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON search_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_response_time ON search_feedback(response_time_ms);
"""

app = FastAPI(title="AFL Player Over/Under Search API")



@app.get("/")
def root():
    """Root endpoint - redirects to API docs"""
    return {
        "message": "AFL Player Over/Under Search API",
        "docs": "/docs",
        "endpoint": "/search/over-under"
    }


# ============================================================================
# PLAYER AUTOCOMPLETE ENDPOINT
# ============================================================================

class PlayerSuggestion(BaseModel):
    player_id: int
    player_name: str
    games_played: int
    games_2025: int  # Games in current season
    avg_disposals_2025: float  # Average disposals per game in current season
    team_id: Optional[int] = None
    team_name: Optional[str] = None


class PlayerAutocompleteResponse(BaseModel):
    suggestions: List[PlayerSuggestion]
    total: int


@app.get("/players/autocomplete", response_model=PlayerAutocompleteResponse)
def autocomplete_players(
    q: str = Query(..., min_length=2, description="Search query (minimum 2 characters)"),
    limit: int = Query(10, ge=1, le=50, description="Maximum number of suggestions"),
    team_id: Optional[int] = Query(None, ge=1, description="Optional team filter"),
    active_2025: bool = Query(False, description="Only return players on a current 2026 roster"),
):
    """
    Get player name suggestions for autocomplete.
    Returns players matching the query, ranked by recent disposals per game
    (players with recent game stats first), then total games.
    When active_2025=True, only return players on a current 2026 roster.
    """
    search_term = q.strip()
    if len(search_term) < 2:
        raise HTTPException(status_code=400, detail="Search query must be at least 2 characters")
    
    season_year = 2026
    
    with get_connection() as conn:
        where_clauses = ["p.player_name LIKE :search_pattern"]
        if team_id is not None:
            where_clauses.append("pth.team_id = :team_id")
        if active_2025:
            where_clauses.append("pth.is_current = 1")
        having_clause = ""
        sql = f"""
            SELECT 
                p.player_id,
                p.player_name,
                COUNT(pgs.stat_id) as games_played,
                SUM(CASE WHEN g.season_year = :season_year THEN 1 ELSE 0 END) as games_2025,
                COALESCE(AVG(CASE WHEN g.season_year = :season_year THEN pgs.disposals END), 0) as avg_disposals_2025,
                pth.team_id as team_id,
                t.team_name as team_name
            FROM players p
            LEFT JOIN player_game_stats pgs ON p.player_id = pgs.player_id
            LEFT JOIN games g ON pgs.game_id = g.game_id
            LEFT JOIN player_team_history pth ON pth.player_id = p.player_id AND pth.is_current = 1
            LEFT JOIN teams t ON t.team_id = pth.team_id
            WHERE {" AND ".join(where_clauses)}
            GROUP BY p.player_id
            {having_clause}
            ORDER BY 
                CASE WHEN games_2025 > 0 THEN 1 ELSE 0 END DESC,
                avg_disposals_2025 DESC,
                games_2025 DESC,
                games_played DESC,
                p.player_name ASC
            LIMIT :limit
        """
        # Use % wildcards for partial matching
        search_pattern = f"%{search_term}%"
        
        params = {
            "search_pattern": search_pattern,
            "limit": limit,
            "season_year": season_year,
        }
        if team_id is not None:
            params["team_id"] = team_id
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
        cur.close()
        
        suggestions = [
            PlayerSuggestion(
                player_id=row["player_id"],
                player_name=row["player_name"],
                games_played=row["games_played"] or 0,
                games_2025=row["games_2025"] or 0,
                avg_disposals_2025=float(row["avg_disposals_2025"] or 0),
                team_id=row["team_id"],
                team_name=row["team_name"],
            )
            for row in rows
        ]
        
        return PlayerAutocompleteResponse(suggestions=suggestions, total=len(suggestions))


@app.get("/players/featured", response_model=PlayerAutocompleteResponse)
def featured_players(
    names: str = Query(..., description="Comma-separated list of player names"),
    season_year: int = Query(2026, ge=2000, le=2100, description="Season year for ranking"),
):
    """
    Return stats for a specific list of players (used for featured/top picks).
    Preserves the input name order in the response when possible.
    """
    name_list = [name.strip() for name in names.split(",") if name.strip()]
    if not name_list:
        raise HTTPException(status_code=400, detail="At least one player name is required")

    placeholders = ",".join(["?"] * len(name_list))
    sql = f"""
        SELECT 
            p.player_id,
            p.player_name,
            COUNT(pgs.stat_id) as games_played,
            SUM(CASE WHEN g.season_year = ? THEN 1 ELSE 0 END) as games_2025,
            COALESCE(AVG(CASE WHEN g.season_year = ? THEN pgs.disposals END), 0) as avg_disposals_2025,
            pth.team_id as team_id,
            t.team_name as team_name
        FROM players p
        LEFT JOIN player_game_stats pgs ON p.player_id = pgs.player_id
        LEFT JOIN games g ON pgs.game_id = g.game_id
        LEFT JOIN player_team_history pth ON pth.player_id = p.player_id AND pth.is_current = 1
        LEFT JOIN teams t ON t.team_id = pth.team_id
        WHERE p.player_name IN ({placeholders})
        GROUP BY p.player_id
    """

    with get_connection() as conn:
        cur = conn.execute(sql, [season_year, season_year, *name_list])
        rows = cur.fetchall()
        cur.close()

    # If two rows share the same player_name (duplicate-name collision),
    # keep the one with more games_played so we don't drop history.
    by_name: dict[str, PlayerSuggestion] = {}
    for row in rows:
        candidate = PlayerSuggestion(
            player_id=row["player_id"],
            player_name=row["player_name"],
            games_played=row["games_played"] or 0,
            games_2025=row["games_2025"] or 0,
            avg_disposals_2025=float(row["avg_disposals_2025"] or 0),
            team_id=row["team_id"],
            team_name=row["team_name"],
        )
        existing = by_name.get(row["player_name"])
        if existing is None or candidate.games_played > existing.games_played:
            by_name[row["player_name"]] = candidate

    ordered = [by_name[name] for name in name_list if name in by_name]
    return PlayerAutocompleteResponse(suggestions=ordered, total=len(ordered))

# ============================================================================
# TEAM PLAYERS ENDPOINT
# ============================================================================

@app.get("/teams/{team_id}/players", response_model=PlayerAutocompleteResponse)
def team_players(
    team_id: int,
    limit: int = Query(50, ge=1, le=100, description="Maximum number of players to return"),
):
    """
    Return all current roster players for a team, ranked by recent activity.
    Shows the full 2026 roster from player_team_history (is_current=1).
    """
    season_year = 2026
    with get_connection() as conn:
        sql = """
            SELECT 
                p.player_id,
                p.player_name,
                COUNT(pgs.stat_id) as games_played,
                SUM(CASE WHEN g.season_year = :season_year THEN 1 ELSE 0 END) as games_2025,
                COALESCE(AVG(CASE WHEN g.season_year = :season_year THEN pgs.disposals END), 0) as avg_disposals_2025,
                pth.team_id as team_id,
                t.team_name as team_name
            FROM players p
            JOIN player_team_history pth ON pth.player_id = p.player_id AND pth.is_current = 1
            JOIN teams t ON t.team_id = pth.team_id
            LEFT JOIN player_game_stats pgs ON p.player_id = pgs.player_id
            LEFT JOIN games g ON pgs.game_id = g.game_id
            WHERE pth.team_id = :team_id
            GROUP BY p.player_id
            ORDER BY 
                CASE WHEN SUM(CASE WHEN g.season_year = :season_year THEN 1 ELSE 0 END) > 0 THEN 0 ELSE 1 END,
                avg_disposals_2025 DESC,
                games_played DESC,
                p.player_name ASC
            LIMIT :limit
        """
        rows = conn.execute(sql, {"team_id": team_id, "season_year": season_year, "limit": limit}).fetchall()
        suggestions = [
            PlayerSuggestion(
                player_id=row["player_id"],
                player_name=row["player_name"],
                games_played=row["games_played"] or 0,
                games_2025=row["games_2025"] or 0,
                avg_disposals_2025=float(row["avg_disposals_2025"] or 0),
                team_id=row["team_id"],
                team_name=row["team_name"],
            )
            for row in rows
        ]
        return PlayerAutocompleteResponse(suggestions=suggestions, total=len(suggestions))


@app.get("/teams/by-name/{team_name}/roster", response_model=PlayerAutocompleteResponse)
def team_roster_by_name(
    team_name: str = Path(..., description="Team name (e.g. 'Collingwood Magpies')"),
    limit: int = Query(50, ge=1, le=100, description="Maximum number of players to return"),
):
    """
    Return all current roster players for a team looked up by name.
    Supports partial matching (e.g. 'Collingwood' matches 'Collingwood Magpies').
    """
    season_year = 2026
    with get_connection() as conn:
        team_row = conn.execute(
            "SELECT team_id, team_name FROM teams WHERE team_name LIKE ?",
            (f"%{team_name}%",),
        ).fetchone()
        if not team_row:
            raise HTTPException(status_code=404, detail=f"Team '{team_name}' not found")

        matched_team_id = team_row["team_id"]
        matched_team_name = team_row["team_name"]

        sql = """
            SELECT 
                p.player_id,
                p.player_name,
                COUNT(pgs.stat_id) as games_played,
                SUM(CASE WHEN g.season_year = :season_year THEN 1 ELSE 0 END) as games_2025,
                COALESCE(AVG(CASE WHEN g.season_year = :season_year THEN pgs.disposals END), 0) as avg_disposals_2025,
                pth.team_id as team_id,
                t.team_name as team_name
            FROM players p
            JOIN player_team_history pth ON pth.player_id = p.player_id AND pth.is_current = 1
            JOIN teams t ON t.team_id = pth.team_id
            LEFT JOIN player_game_stats pgs ON p.player_id = pgs.player_id
            LEFT JOIN games g ON pgs.game_id = g.game_id
            WHERE pth.team_id = :team_id
            GROUP BY p.player_id
            ORDER BY 
                CASE WHEN SUM(CASE WHEN g.season_year = :season_year THEN 1 ELSE 0 END) > 0 THEN 0 ELSE 1 END,
                avg_disposals_2025 DESC,
                games_played DESC,
                p.player_name ASC
            LIMIT :limit
        """
        rows = conn.execute(sql, {"team_id": matched_team_id, "season_year": season_year, "limit": limit}).fetchall()
        suggestions = [
            PlayerSuggestion(
                player_id=row["player_id"],
                player_name=row["player_name"],
                games_played=row["games_played"] or 0,
                games_2025=row["games_2025"] or 0,
                avg_disposals_2025=float(row["avg_disposals_2025"] or 0),
                team_id=row["team_id"],
                team_name=row["team_name"],
            )
            for row in rows
        ]
        return PlayerAutocompleteResponse(suggestions=suggestions, total=len(suggestions))


@app.on_event("startup")
async def startup_event():
    """Log database path on startup for debugging"""
    import logging
    logger = logging.getLogger("uvicorn")
    _initialize_database()
    logger.info(f"Database path configured: {DB_PATH}")
    logger.info(f"Database exists: {os.path.exists(DB_PATH)}")
    if CACHE_TTL_SECONDS:
        logger.info(f"Stats cache enabled (ttl={CACHE_TTL_SECONDS}s)")
    else:
        logger.info("Stats cache disabled")
    if not os.path.exists(DB_PATH):
        logger.error(f"WARNING: Database file not found at {DB_PATH}")
        logger.error(f"Current working directory: {os.getcwd()}")
        logger.error(f"__file__ location: {__file__}")
        logger.error(f"Backend directory: {_backend_dir}")

# Enable CORS for frontend access. The bundled frontend calls this API from
# its server-side proxy, so browsers only need CORS for origins you list in
# ALLOWED_ORIGINS (comma separated, e.g. https://your-app.example).
_allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
_allowed_origin_regex = None
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=_allowed_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# CAREER AVERAGES
# ============================================================================

CAREER_STAT_COLUMNS: List[str] = [
    "disposals",
    "goals",
    "marks",
    "tackles",
    "kicks",
    "handballs",
    "clearances",
    "hit_outs",
]


class CareerSeasonAverage(BaseModel):
    season_year: int
    team_name: str
    games: int
    averages: Dict[str, Optional[float]]


class CareerAveragesResponse(BaseModel):
    player_id: int
    player_name: str
    seasons: List[CareerSeasonAverage]


# ============================================================================
# GAME LOG
# ============================================================================

class GameLogEntry(BaseModel):
    game_date: str
    season_year: int
    round_number: Optional[int]
    game_type: str
    opponent_name: str
    venue_name: str
    location: str          # 'Home' or 'Away'
    game_time: Optional[str]  # 'Day', 'Twilight', 'Night', or None
    days_since_last_game: Optional[int]
    # Core stats — always present
    disposals: int
    goals: int
    marks: int
    tackles: int
    # Extended stats — None when column not yet in DB (feature/data-increase)
    kicks: Optional[int] = None
    handballs: Optional[int] = None
    clearances: Optional[int] = None
    hit_outs: Optional[int] = None


class GameLogResponse(BaseModel):
    games: List[GameLogEntry]
    total: int


# ============================================================================
# SGM GAME LOG MODELS
# ============================================================================

class SgmGameLogPlayerEntry(BaseModel):
    player_name: str
    stat: str
    threshold: float
    stat_value: Optional[int] = None
    hit: bool
    disposals: int
    goals: int
    marks: int
    tackles: int
    kicks: Optional[int] = None
    handballs: Optional[int] = None
    clearances: Optional[int] = None
    hit_outs: Optional[int] = None


class SgmGameLogGame(BaseModel):
    game_date: str
    season_year: int
    round_number: Optional[int]
    game_type: str
    opponent_name: str
    venue_name: str
    location: str
    all_hit: bool
    players: List[SgmGameLogPlayerEntry]


class SgmGameLogResponse(BaseModel):
    games: List[SgmGameLogGame]
    total: int
    all_hit_count: int


class OverUnderResponse(BaseModel):
    over: int
    under: int


class SgmSelection(BaseModel):
    player_id: Optional[int] = None
    player_name: Optional[str] = None
    stat: str
    threshold: float
    strict_over: bool = False


class SgmRequest(BaseModel):
    selections: List[SgmSelection]
    bet_mode: str
    season_from: Optional[int] = None
    season_to: Optional[int] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    location: Optional[str] = None
    opponent: Optional[str] = None
    venue: Optional[str] = None
    game_type: Optional[str] = None
    days_rest_min: Optional[int] = None
    days_rest_max: Optional[int] = None


class SgmResponse(BaseModel):
    outcomes: Dict[str, int]
    total: int

class FixtureResponse(BaseModel):
    fixture_id: int
    season_year: int
    round_name: str
    round_number: Optional[int]
    game_date: Optional[str]
    game_time: Optional[str]
    home_team_id: Optional[int]
    home_team_name: str
    away_team_id: Optional[int]
    away_team_name: str
    venue_id: Optional[int]
    venue_name: str
    game_type: Optional[str] = None
    starts_at: Optional[str] = None
    date_window_start: Optional[str] = None
    date_window_end: Optional[str] = None
    schedule_status: str = 'unverified'
    selectable: bool = False
    source: Optional[str] = None
    source_urls: List[str] = []
    checked_at: Optional[str] = None
    note: Optional[str] = None


class UpcomingFixturesResponse(BaseModel):
    fixtures: List[FixtureResponse]
    total: int


# ============================================================================
# SEARCH FEEDBACK MODELS
# ============================================================================

class SearchFeedbackRequest(BaseModel):
    feedback_type: Literal['instant', 'bad_delay']
    player_name: Optional[str] = None
    player_id: Optional[int] = None
    stat: str
    threshold: float
    strict_over: bool = False
    season_from: Optional[int] = None
    season_to: Optional[int] = None
    location: Optional[str] = None
    opponent: Optional[str] = None
    venue: Optional[str] = None
    game_type: Optional[str] = None
    response_time_ms: Optional[int] = None


class SearchFeedbackResponse(BaseModel):
    success: bool
    message: str
    feedback_id: Optional[int] = None


def _configure_connection(conn: sqlite3.Connection) -> None:
    """Apply performance-related PRAGMAs to the SQLite connection."""
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
    except sqlite3.Error:
        # PRAGMA statements can fail on read-only filesystems; ignore gracefully
        pass


def _initialize_database() -> None:
    """Ensure required indexes and tables exist before serving traffic."""
    import logging
    logger = logging.getLogger("uvicorn")
    
    if not os.path.exists(DB_PATH):
        logger.error(f"❌ Database file not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    try:
        _configure_connection(conn)
        # Create search feedback table
        conn.executescript(SEARCH_FEEDBACK_TABLE_SQL)
        # Create indexes
        for statement in INDEX_STATEMENTS:
            conn.execute(statement)
        conn.commit()
    finally:
        conn.close()


def _normalize_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _normalize_location(value: Optional[str]) -> Optional[str]:
    normalized = _normalize_text(value)
    if not normalized:
        return None
    normalized = normalized.lower()
    if normalized not in {"home", "away"}:
        raise HTTPException(status_code=400, detail="location must be 'home' or 'away'")
    return normalized


def _normalize_game_type(value: Optional[str]) -> Optional[str]:
    normalized = _normalize_text(value)
    if not normalized:
        return None
    normalized = normalized.lower()
    if normalized not in {"regular", "finals", "all"}:
        raise HTTPException(status_code=400, detail="game_type must be regular|finals|all")
    return normalized


def _normalize_date(value: Optional[str], label: str) -> Optional[str]:
    normalized = _normalize_text(value)
    if not normalized:
        return None
    try:
        datetime.fromisoformat(normalized).date()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{label} must be YYYY-MM-DD")
    return normalized


def _require_internal_secret(request: Request) -> None:
    secret = os.getenv("INTERNAL_API_SECRET")
    if not secret:
        # A deployed proxy boundary must never disappear because its secret
        # was omitted from an environment. Local development stays opt-in.
        if os.getenv("REQUIRE_INTERNAL_SECRET", "").lower() in ("1", "true", "yes"):
            raise HTTPException(status_code=503, detail="Search is temporarily unavailable")
        return
    provided = request.headers.get("x-internal-secret") or ""
    if not secrets.compare_digest(provided.encode("utf-8"), secret.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Unauthorized")



from app.afl_context_api import router as afl_context_router
app.include_router(afl_context_router, dependencies=[Depends(_require_internal_secret)])

from app.afl_finals_maintenance import create_router as create_afl_finals_maintenance_router


def _clear_afl_stats_cache():
    global _stats_cache_generation
    with _cache_lock:
        _stats_cache_generation += 1
        _stats_cache.clear()


app.include_router(create_afl_finals_maintenance_router(lambda: DB_PATH, _clear_afl_stats_cache))


def _make_cache_key(
    player_id: int,
    stat: str,
    threshold: float,
    strict_over: bool,
    season_from: Optional[int],
    season_to: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
    location: Optional[str],
    opponent: Optional[str],
    venue: Optional[str],
    game_type: Optional[str],
    days_rest_min: Optional[int] = None,
    days_rest_max: Optional[int] = None,
) -> Tuple[Any, ...]:
    def _lower(value: Optional[str]) -> Optional[str]:
        return value.lower() if value else None

    return (
        _stats_cache_generation,
        player_id,
        stat,
        round(float(threshold), 4),
        strict_over,
        season_from,
        season_to,
        date_from,
        date_to,
        location,
        _lower(opponent),
        _lower(venue),
        game_type,
        days_rest_min,
        days_rest_max,
    )


def _get_cached_result(key: Tuple[Any, ...]) -> Optional[Dict[str, int]]:
    if CACHE_TTL_SECONDS == 0:
        return None
    now = time.time()
    with _cache_lock:
        cached = _stats_cache.get(key)
        if not cached:
            return None
        cached_at, payload = cached
        if now - cached_at > CACHE_TTL_SECONDS:
            _stats_cache.pop(key, None)
            return None
        return payload.copy()


def _store_cached_result(key: Tuple[Any, ...], payload: Dict[str, int]) -> None:
    if CACHE_TTL_SECONDS == 0:
        return
    with _cache_lock:
        _stats_cache[key] = (time.time(), payload.copy())


def get_connection() -> sqlite3.Connection:
    try:
        # Debug: Log the actual path being used
        if not os.path.exists(DB_PATH):
            raise HTTPException(
                status_code=500, 
                detail=f"Database file not found at: {DB_PATH}. Please check DB_PATH environment variable or ensure the database exists."
            )
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        _configure_connection(conn)
        return conn
    except sqlite3.Error as e:
        raise HTTPException(status_code=500, detail=f"Database connection error: {e}")


VALID_STATS = {"disposals", "goals", "tackles", "marks", "kicks", "handballs", "clearances", "hit_outs"}
GAME_TYPE_MAP = {
    "all": ("Regular Season", "Finals"),
    "regular": ("Regular Season",),
    "finals": ("Finals",),
}


def _resolve_player_id(
    conn: sqlite3.Connection,
    *,
    player_id: Optional[int],
    player_name: Optional[str],
) -> int:
    if player_id is not None:
        return player_id

    normalized_name = _normalize_text(player_name)
    if not normalized_name:
        raise HTTPException(status_code=400, detail="player_name is required when player_id is not provided")

    # Time player resolution.
    # Deterministic tie-break for duplicate names: prefer the row with the
    # most stats (full history), falling back to lower player_id for stability.
    resolve_start = time.time()
    cur = conn.execute(
        """
        SELECT p.player_id
        FROM players p
        LEFT JOIN player_game_stats pgs ON pgs.player_id = p.player_id
        WHERE p.player_name = ? COLLATE NOCASE
        GROUP BY p.player_id
        ORDER BY COUNT(pgs.stat_id) DESC, p.player_id ASC
        LIMIT 1
        """,
        (normalized_name,),
    )
    row = cur.fetchone()
    cur.close()
    resolve_time_ms = (time.time() - resolve_start) * 1000
    
    # Track player resolution time
    with _perf_lock:
        _perf_stats["player_resolution_times"].append(resolve_time_ms)
        if len(_perf_stats["player_resolution_times"]) > 1000:
            _perf_stats["player_resolution_times"] = _perf_stats["player_resolution_times"][-1000:]
    
    if not row:
        raise HTTPException(status_code=404, detail="Player not found")
    return int(row["player_id"])


def _validate_season_range(season_from: Optional[int], season_to: Optional[int]) -> None:
    if season_from and season_to and season_from > season_to:
        raise HTTPException(status_code=400, detail="season_from must be less than or equal to season_to")


def _validate_date_range(date_from: Optional[str], date_to: Optional[str]) -> None:
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status_code=400, detail="date_from must be less than or equal to date_to")


def _build_stats_query(
    stat: str,
    strict_over: bool,
    season_from: Optional[int],
    season_to: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
    location: Optional[str],
    opponent: Optional[str],
    venue: Optional[str],
    game_type: Optional[str],
    days_rest_min: Optional[int] = None,
    days_rest_max: Optional[int] = None,
) -> Tuple[str, Dict[str, Any]]:
    over_op = ">" if strict_over else ">="
    under_op = "<=" if strict_over else "<"
    joins = ["JOIN games g ON g.game_id = pgs.game_id"]
    where_clauses = ["pgs.player_id = :player_id"]
    params: Dict[str, Any] = {}

    if season_from is not None:
        where_clauses.append("g.season_year >= :season_from")
        params["season_from"] = season_from

    if season_to is not None:
        where_clauses.append("g.season_year <= :season_to")
        params["season_to"] = season_to

    if date_from is not None:
        where_clauses.append("g.game_date >= :date_from")
        params["date_from"] = date_from

    if date_to is not None:
        where_clauses.append("g.game_date <= :date_to")
        params["date_to"] = date_to

    if location:
        where_clauses.append("LOWER(pgs.location) = :location")
        params["location"] = location

    if opponent:
        joins.append("JOIN teams opponent ON opponent.team_id = pgs.opponent_team_id")
        where_clauses.append("LOWER(opponent.team_name) = :opponent_name")
        params["opponent_name"] = opponent.lower()

    if venue:
        joins.append("JOIN venues v ON v.venue_id = pgs.venue_id")
        where_clauses.append("LOWER(v.venue_name) = :venue_name")
        params["venue_name"] = venue.lower()

    if game_type:
        mapped = GAME_TYPE_MAP.get(game_type)
        if not mapped:
            raise HTTPException(status_code=400, detail="Unsupported game_type filter")
        where_clauses.append("g.game_type IN ({placeholders})".format(
            placeholders=", ".join(f":game_type_{idx}" for idx in range(len(mapped)))
        ))
        for idx, label in enumerate(mapped):
            params[f"game_type_{idx}"] = label

    if days_rest_min is not None:
        where_clauses.append("pgs.days_since_last_game >= :days_rest_min")
        params["days_rest_min"] = days_rest_min

    if days_rest_max is not None:
        where_clauses.append("pgs.days_since_last_game <= :days_rest_max")
        params["days_rest_max"] = days_rest_max

    sql = f"""
        SELECT
            SUM(CASE WHEN pgs.{stat} {over_op} :threshold THEN 1 ELSE 0 END) AS over,
            SUM(CASE WHEN pgs.{stat} {under_op} :threshold THEN 1 ELSE 0 END) AS under
        FROM player_game_stats pgs
        {' '.join(joins)}
        WHERE {' AND '.join(where_clauses)}
    """
    return sql, params


def _build_sgm_query(
    *,
    selections: List[Dict[str, Any]],
    season_from: Optional[int],
    season_to: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
    location: Optional[str],
    opponent: Optional[str],
    venue: Optional[str],
    game_type: Optional[str],
    bet_mode: str,
    days_rest_min: Optional[int] = None,
    days_rest_max: Optional[int] = None,
) -> Tuple[str, Dict[str, Any], List[str]]:
    aliases = [f"p{idx + 1}" for idx in range(len(selections))]
    joins = ["JOIN games g ON g.game_id = p1.game_id"]
    where_clauses = []
    params: Dict[str, Any] = {}

    for idx, selection in enumerate(selections):
        alias = aliases[idx]
        where_clauses.append(f"{alias}.player_id = :player_id_{idx}")
        # Unknown selected statistics cannot be evaluated as wins or losses.
        where_clauses.append(f"{alias}.{selection['stat']} IS NOT NULL")
        params[f"player_id_{idx}"] = selection["player_id"]
        params[f"threshold_{idx}"] = selection["threshold"]

    for idx in range(1, len(aliases)):
        joins.append(
            f"JOIN player_game_stats {aliases[idx]} ON {aliases[idx]}.game_id = p1.game_id AND {aliases[idx]}.team_id = p1.team_id"
        )

    if season_from is not None:
        where_clauses.append("g.season_year >= :season_from")
        params["season_from"] = season_from

    if season_to is not None:
        where_clauses.append("g.season_year <= :season_to")
        params["season_to"] = season_to

    if date_from is not None:
        where_clauses.append("g.game_date >= :date_from")
        params["date_from"] = date_from

    if date_to is not None:
        where_clauses.append("g.game_date <= :date_to")
        params["date_to"] = date_to

    if location:
        where_clauses.append("LOWER(p1.location) = :location")
        params["location"] = location

    if opponent:
        joins.append("JOIN teams opponent ON opponent.team_id = p1.opponent_team_id")
        where_clauses.append("LOWER(opponent.team_name) = :opponent_name")
        params["opponent_name"] = opponent.lower()

    if venue:
        joins.append("JOIN venues v ON v.venue_id = p1.venue_id")
        where_clauses.append("LOWER(v.venue_name) = :venue_name")
        params["venue_name"] = venue.lower()

    if game_type:
        mapped = GAME_TYPE_MAP.get(game_type)
        if not mapped:
            raise HTTPException(status_code=400, detail="Unsupported game_type filter")
        where_clauses.append(
            "g.game_type IN ({placeholders})".format(
                placeholders=", ".join(f":game_type_{idx}" for idx in range(len(mapped)))
            )
        )
        for idx, label in enumerate(mapped):
            params[f"game_type_{idx}"] = label

    if days_rest_min is not None:
        where_clauses.append("p1.days_since_last_game >= :days_rest_min")
        params["days_rest_min"] = days_rest_min

    if days_rest_max is not None:
        where_clauses.append("p1.days_since_last_game <= :days_rest_max")
        params["days_rest_max"] = days_rest_max

    conditions = []
    for idx, selection in enumerate(selections):
        alias = aliases[idx]
        op = ">" if selection["strict_over"] else ">="
        conditions.append(f"{alias}.{selection['stat']} {op} :threshold_{idx}")

    outcome_keys: List[str] = []
    outcome_clauses: List[str] = []

    if bet_mode == "win_loss":
        outcome_keys = ["win", "loss"]
        win_clause = " AND ".join(conditions)
        outcome_clauses.append(f"SUM(CASE WHEN {win_clause} THEN 1 ELSE 0 END) AS win")
        outcome_clauses.append(f"COUNT(1) - SUM(CASE WHEN {win_clause} THEN 1 ELSE 0 END) AS loss")
    else:
        total_outcomes = 2 ** len(conditions)
        for mask in range(total_outcomes):
            parts = []
            labels = []
            for idx, condition in enumerate(conditions):
                is_over = (mask >> (len(conditions) - idx - 1)) & 1
                if is_over:
                    parts.append(condition)
                    labels.append("over")
                else:
                    parts.append(f"NOT ({condition})")
                    labels.append("under")
            key = "_".join(labels)
            outcome_keys.append(key)
            outcome_clauses.append(
                f"SUM(CASE WHEN {' AND '.join(parts)} THEN 1 ELSE 0 END) AS {key}"
            )

    sql = f"""
        SELECT
            COUNT(1) AS total,
            {", ".join(outcome_clauses)}
        FROM player_game_stats p1
        {' '.join(joins)}
        WHERE {' AND '.join(where_clauses)}
    """
    return sql, params, outcome_keys


def _fetch_sgm(
    conn: sqlite3.Connection,
    *,
    selections: List[Dict[str, Any]],
    season_from: Optional[int],
    season_to: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
    location: Optional[str],
    opponent: Optional[str],
    venue: Optional[str],
    game_type: Optional[str],
    bet_mode: str,
    days_rest_min: Optional[int] = None,
    days_rest_max: Optional[int] = None,
) -> Dict[str, Any]:
    sql, params, outcome_keys = _build_sgm_query(
        selections=selections,
        season_from=season_from,
        season_to=season_to,
        date_from=date_from,
        date_to=date_to,
        location=location,
        opponent=opponent,
        venue=venue,
        game_type=game_type,
        bet_mode=bet_mode,
        days_rest_min=days_rest_min,
        days_rest_max=days_rest_max,
    )
    cur = conn.execute(sql, params)
    row = cur.fetchone()
    cur.close()

    total = int(row["total"]) if row and row["total"] is not None else 0
    outcomes = {key: int(row[key]) if row and row[key] is not None else 0 for key in outcome_keys}
    return {"total": total, "outcomes": outcomes}

def _fetch_sgm_game_log(
    conn: sqlite3.Connection,
    *,
    selections: List[Dict[str, Any]],
    season_from: Optional[int],
    season_to: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
    location: Optional[str],
    opponent: Optional[str],
    venue: Optional[str],
    game_type: Optional[str],
    without_player_ids: Optional[List[int]] = None,
) -> Dict[str, Any]:
    """Return per-game data for all players in an SGM, grouped by game."""
    aliases = [f"p{idx + 1}" for idx in range(len(selections))]

    # Detect extended stat columns
    EXTENDED_STATS = ["kicks", "handballs", "clearances", "hit_outs"]
    pragma_rows = conn.execute("PRAGMA table_info(player_game_stats)").fetchall()
    existing_cols = {row["name"] for row in pragma_rows}
    available_extended = [c for c in EXTENDED_STATS if c in existing_cols]

    # Build SELECT columns for each player alias
    player_selects = []
    for alias in aliases:
        player_selects.append(f"{alias}.disposals AS {alias}_disposals")
        player_selects.append(f"{alias}.goals AS {alias}_goals")
        player_selects.append(f"{alias}.marks AS {alias}_marks")
        player_selects.append(f"{alias}.tackles AS {alias}_tackles")
        for ext_col in available_extended:
            player_selects.append(f"{alias}.{ext_col} AS {alias}_{ext_col}")

    # Build JOINs
    joins = [
        "JOIN games g ON g.game_id = p1.game_id",
        "JOIN teams opponent ON opponent.team_id = p1.opponent_team_id",
        "JOIN venues v ON v.venue_id = p1.venue_id",
    ]
    where_clauses = []
    params: Dict[str, Any] = {}

    for idx, selection in enumerate(selections):
        alias = aliases[idx]
        where_clauses.append(f"{alias}.player_id = :player_id_{idx}")
        # Keep the log's evaluated sample consistent with the aggregate query.
        where_clauses.append(f"{alias}.{selection['stat']} IS NOT NULL")
        params[f"player_id_{idx}"] = selection["player_id"]

    for idx in range(1, len(aliases)):
        joins.append(
            f"JOIN player_game_stats {aliases[idx]} ON {aliases[idx]}.game_id = p1.game_id AND {aliases[idx]}.team_id = p1.team_id"
        )

    if season_from is not None:
        where_clauses.append("g.season_year >= :season_from")
        params["season_from"] = season_from
    if season_to is not None:
        where_clauses.append("g.season_year <= :season_to")
        params["season_to"] = season_to
    if date_from is not None:
        where_clauses.append("g.game_date >= :date_from")
        params["date_from"] = date_from
    if date_to is not None:
        where_clauses.append("g.game_date <= :date_to")
        params["date_to"] = date_to
    if location:
        where_clauses.append("LOWER(p1.location) = :location")
        params["location"] = location
    if opponent:
        where_clauses.append("LOWER(opponent.team_name) = :opponent_name")
        params["opponent_name"] = opponent.lower()
    if venue:
        where_clauses.append("LOWER(v.venue_name) = :venue_name")
        params["venue_name"] = venue.lower()
    if game_type:
        mapped = GAME_TYPE_MAP.get(game_type)
        if not mapped:
            raise HTTPException(status_code=400, detail="Unsupported game_type filter")
        where_clauses.append(
            "g.game_type IN ({})".format(
                ", ".join(f":game_type_{idx}" for idx in range(len(mapped)))
            )
        )
        for idx, label in enumerate(mapped):
            params[f"game_type_{idx}"] = label
    if without_player_ids:
        for wp_idx, wp_id in enumerate(without_player_ids):
            where_clauses.append(
                f"p1.game_id NOT IN (SELECT game_id FROM player_game_stats WHERE player_id = :without_pid_{wp_idx})"
            )
            params[f"without_pid_{wp_idx}"] = wp_id

    sql = f"""
        SELECT
            g.game_date,
            g.season_year,
            g.round_number,
            g.game_type,
            opponent.team_name AS opponent_name,
            v.venue_name,
            p1.location,
            {", ".join(player_selects)}
        FROM player_game_stats p1
        {" ".join(joins)}
        WHERE {" AND ".join(where_clauses)}
        ORDER BY g.game_date DESC
        LIMIT 200
    """

    rows = conn.execute(sql, params).fetchall()

    games = []
    all_hit_count = 0
    for row in rows:
        players = []
        all_hit = True
        for idx, selection in enumerate(selections):
            alias = aliases[idx]
            stat_col = selection["stat"]
            stat_value_raw = row[f"{alias}_{stat_col}"]
            stat_value = int(stat_value_raw) if stat_value_raw is not None else None

            if stat_value is not None:
                if selection["strict_over"]:
                    hit = stat_value > selection["threshold"]
                else:
                    hit = stat_value >= selection["threshold"]
            else:
                hit = False

            if not hit:
                all_hit = False

            player_entry = SgmGameLogPlayerEntry(
                player_name=selection["player_name"],
                stat=stat_col,
                threshold=selection["threshold"],
                stat_value=stat_value,
                hit=hit,
                disposals=row[f"{alias}_disposals"] or 0,
                goals=row[f"{alias}_goals"] or 0,
                marks=row[f"{alias}_marks"] or 0,
                tackles=row[f"{alias}_tackles"] or 0,
                kicks=row[f"{alias}_kicks"] if "kicks" in available_extended else None,
                handballs=row[f"{alias}_handballs"] if "handballs" in available_extended else None,
                clearances=row[f"{alias}_clearances"] if "clearances" in available_extended else None,
                hit_outs=row[f"{alias}_hit_outs"] if "hit_outs" in available_extended else None,
            )
            players.append(player_entry)

        if all_hit:
            all_hit_count += 1

        games.append(SgmGameLogGame(
            game_date=row["game_date"],
            season_year=row["season_year"],
            round_number=row["round_number"],
            game_type=row["game_type"],
            opponent_name=row["opponent_name"],
            venue_name=row["venue_name"],
            location=row["location"],
            all_hit=all_hit,
            players=players,
        ))

    return {"games": games, "total": len(games), "all_hit_count": all_hit_count}


def _fetch_over_under(
    conn: sqlite3.Connection,
    *,
    player_id: int,
    stat: str,
    threshold: float,
    strict_over: bool,
    season_from: Optional[int],
    season_to: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
    location: Optional[str],
    opponent: Optional[str],
    venue: Optional[str],
    game_type: Optional[str],
    days_rest_min: Optional[int] = None,
    days_rest_max: Optional[int] = None,
) -> Dict[str, int]:
    sql, params = _build_stats_query(
        stat=stat,
        strict_over=strict_over,
        season_from=season_from,
        season_to=season_to,
        date_from=date_from,
        date_to=date_to,
        location=location,
        opponent=opponent,
        venue=venue,
        game_type=game_type,
        days_rest_min=days_rest_min,
        days_rest_max=days_rest_max,
    )
    params.update(
        {
            "player_id": player_id,
            "threshold": threshold,
        }
    )

    # Time the query execution
    query_start = time.time()
    cur = conn.execute(sql, params)
    row = cur.fetchone()
    cur.close()
    query_time_ms = (time.time() - query_start) * 1000
    
    # Log query performance
    logger = logging.getLogger("uvicorn")
    logger.info(
        f"QUERY_PERF | player_id={player_id} stat={stat} threshold={threshold} "
        f"time_ms={query_time_ms:.2f} filters={len([f for f in [season_from, season_to, location, opponent, venue, game_type] if f is not None])}"
    )
    
    # Track in stats (keep last 1000 queries)
    with _perf_lock:
        _perf_stats["query_times"].append(query_time_ms)
        if len(_perf_stats["query_times"]) > 1000:
            _perf_stats["query_times"] = _perf_stats["query_times"][-1000:]
    
    over = int(row["over"]) if row and row["over"] is not None else 0
    under = int(row["under"]) if row and row["under"] is not None else 0
    return {"over": over, "under": under}


@app.get("/players/{player_id}/career-averages", response_model=CareerAveragesResponse)
def get_player_career_averages(
    player_id: int = Path(..., ge=1, description="Player ID"),
):
    """
    Return per-season averages for a player across their full career.

    Results are grouped by season_year + team so mid-season trade stints
    appear as separate rows. Only Regular Season and Finals games are included
    (Pre-Season games are excluded). Results are ordered newest season first.
    """
    with get_connection() as conn:
        player_row = conn.execute(
            "SELECT player_id, player_name FROM players WHERE player_id = ?",
            (player_id,),
        ).fetchone()
        if not player_row:
            raise HTTPException(status_code=404, detail=f"Player {player_id} not found")

        stat_select = ", ".join(
            f"ROUND(AVG(pgs.{col}), 1) as avg_{col}"
            for col in CAREER_STAT_COLUMNS
        )
        sql = f"""
            SELECT
                g.season_year,
                t.team_name,
                COUNT(*) as games_played,
                {stat_select}
            FROM player_game_stats pgs
            JOIN games g ON pgs.game_id = g.game_id
            JOIN teams t ON pgs.team_id = t.team_id
            WHERE pgs.player_id = ?
              AND g.game_type IN ('Regular Season', 'Finals')
            GROUP BY g.season_year, pgs.team_id
            ORDER BY g.season_year DESC, COUNT(*) DESC
        """
        rows = conn.execute(sql, (player_id,)).fetchall()

    seasons = []
    for row in rows:
        averages = {
            col: row[f"avg_{col}"] if f"avg_{col}" in row.keys() else None
            for col in CAREER_STAT_COLUMNS
        }
        season = CareerSeasonAverage(
            season_year=row["season_year"],
            team_name=row["team_name"],
            games=row["games_played"],
            averages=averages,
        )
        seasons.append(season)

    return CareerAveragesResponse(
        player_id=player_row["player_id"],
        player_name=player_row["player_name"],
        seasons=seasons,
    )


@app.get("/search/over-under", response_model=OverUnderResponse)
def search_over_under(
    request: Request,
    player_id: Optional[int] = Query(None),
    player_name: Optional[str] = Query(None),
    stat: str = Query(...),
    threshold: float = Query(...),
    strict_over: bool = Query(False),
    season_from: Optional[int] = Query(None, ge=1900, le=2100),
    season_to: Optional[int] = Query(None, ge=1900, le=2100),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    location: Optional[str] = Query(None),
    opponent: Optional[str] = Query(None),
    venue: Optional[str] = Query(None),
    game_type: Optional[str] = Query(None),
    days_rest_min: Optional[int] = Query(None, ge=0, le=365),
    days_rest_max: Optional[int] = Query(None, ge=0, le=365),
):
    _require_internal_secret(request)
    request_start = time.time()
    logger = logging.getLogger("uvicorn")
    
    # Validate identifier parameters
    if (player_id is None and not player_name) or (player_id is not None and player_name):
        raise HTTPException(status_code=400, detail="Provide exactly one of player_id or player_name")

    # Validate stat
    if stat not in VALID_STATS:
        raise HTTPException(status_code=400, detail="Invalid stat. Must be one of disposals|goals|tackles|marks|kicks|handballs|clearances|hit_outs")

    _validate_season_range(season_from, season_to)
    normalized_date_from = _normalize_date(date_from, "date_from")
    normalized_date_to = _normalize_date(date_to, "date_to")
    _validate_date_range(normalized_date_from, normalized_date_to)
    normalized_location = _normalize_location(location)
    normalized_opponent = _normalize_text(opponent)
    normalized_venue = _normalize_text(venue)
    normalized_game_type = _normalize_game_type(game_type)
    if days_rest_min is not None and days_rest_max is not None and days_rest_min > days_rest_max:
        raise HTTPException(status_code=400, detail="days_rest_min must be less than or equal to days_rest_max")

    cache_key = None
    result: Optional[Dict[str, int]] = None
    cache_hit = False

    with get_connection() as conn:
        resolved_player_id = _resolve_player_id(conn, player_id=player_id, player_name=player_name)
        cache_key = _make_cache_key(
            resolved_player_id,
            stat,
            threshold,
            strict_over,
            season_from,
            season_to,
            normalized_date_from,
            normalized_date_to,
            normalized_location,
            normalized_opponent,
            normalized_venue,
            normalized_game_type,
            days_rest_min,
            days_rest_max,
        )

        cached = _get_cached_result(cache_key)
        if cached:
            cache_hit = True
            with _perf_lock:
                _perf_stats["cache_hits"] += 1
                _perf_stats["total_requests"] += 1
            
            total_time_ms = (time.time() - request_start) * 1000
            logger.info(
                f"REQUEST_PERF | cache=HIT player_id={resolved_player_id} stat={stat} "
                f"threshold={threshold} total_ms={total_time_ms:.2f}"
            )
            return OverUnderResponse(**cached)

        # Cache miss - execute query
        with _perf_lock:
            _perf_stats["cache_misses"] += 1
            _perf_stats["total_requests"] += 1

        result = _fetch_over_under(
            conn,
            player_id=resolved_player_id,
            stat=stat,
            threshold=threshold,
            strict_over=strict_over,
            season_from=season_from,
            season_to=season_to,
            date_from=normalized_date_from,
            date_to=normalized_date_to,
            location=normalized_location,
            opponent=normalized_opponent,
            venue=normalized_venue,
            game_type=normalized_game_type,
            days_rest_min=days_rest_min,
            days_rest_max=days_rest_max,
        )

    if cache_key and result:
        _store_cached_result(cache_key, result)

    total_time_ms = (time.time() - request_start) * 1000
    logger.info(
        f"REQUEST_PERF | cache=MISS player_id={resolved_player_id} stat={stat} "
        f"threshold={threshold} total_ms={total_time_ms:.2f}"
    )

    return OverUnderResponse(**(result or {"over": 0, "under": 0}))


@app.get("/search/player-impact")
def search_player_impact(
    request: Request,
    player_id: Optional[int] = Query(None),
    player_name: Optional[str] = Query(None),
    stat: str = Query(...),
):
    """Independent sourced history for a previously authorized player/stat search."""
    _require_internal_secret(request)
    if (player_id is None and not player_name) or (player_id is not None and player_name):
        raise HTTPException(400, "Provide exactly one of player_id or player_name")
    if stat not in VALID_STATS:
        raise HTTPException(400, "Invalid stat")
    from app.afl_player_context import read_player_impact, attach_upcoming
    from app.afl_context_api import get_context
    from datetime import timezone
    from zoneinfo import ZoneInfo
    import json

    now = datetime.now(timezone.utc)
    try:
        with get_connection() as conn:
            resolved = _resolve_player_id(conn, player_id=player_id, player_name=player_name)
            impact, current_team = read_player_impact(conn, resolved, stat, now=now)
            from app.afl_upcoming_impact import attach_reviewed_upcoming
            impact = attach_reviewed_upcoming(impact, current_team, conn, now=now)
            if 'upcoming' in impact:
                return impact
    except (OSError, ValueError, sqlite3.DatabaseError):
        raise HTTPException(503, "Player impact history is temporarily unavailable")
    # The primary result has already returned. A bounded shared schedule refresh
    # can take place for this supplemental panel without holding a DB connection.
    context = None
    if current_team:
        response = get_context(now.astimezone(ZoneInfo('Australia/Melbourne')).year)
        if response.status_code == 200:
            context = json.loads(response.body)
    return attach_upcoming(impact, current_team, context, now=datetime.now(timezone.utc))


@app.get("/search/game-log", response_model=GameLogResponse)
def search_game_log(
    request: Request,
    player_id: Optional[int] = Query(None),
    player_name: Optional[str] = Query(None),
    season_from: Optional[int] = Query(None, ge=1900, le=2100),
    season_to: Optional[int] = Query(None, ge=1900, le=2100),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    game_type: Optional[str] = Query(None),
    without_player_id: Optional[int] = Query(None),
    without_player_name: Optional[str] = Query(None),
):
    """Return a game-by-game log for a player within the given date/season range.

    Always returns all games regardless of home/away, opponent, or venue — the
    caller can apply contextual flags client-side.  Results are ordered most-recent
    first.  Extended stat columns (kicks, handballs, clearances, hit_outs) are
    returned as None when they do not yet exist in the database.
    """
    _require_internal_secret(request)

    if (player_id is None and not player_name) or (player_id is not None and player_name):
        raise HTTPException(status_code=400, detail="Provide exactly one of player_id or player_name")

    _validate_season_range(season_from, season_to)
    normalized_date_from = _normalize_date(date_from, "date_from")
    normalized_date_to = _normalize_date(date_to, "date_to")
    _validate_date_range(normalized_date_from, normalized_date_to)
    normalized_game_type = _normalize_game_type(game_type)

    # Detect which extended columns exist so we stay backward-compatible
    # when feature/data-increase hasn't landed yet.
    EXTENDED_STATS = ["kicks", "handballs", "clearances", "hit_outs"]

    with get_connection() as conn:
        resolved_player_id = _resolve_player_id(conn, player_id=player_id, player_name=player_name)
        resolved_without_pid = None
        if without_player_id or without_player_name:
            resolved_without_pid = _resolve_player_id(
                conn,
                player_id=without_player_id,
                player_name=without_player_name,
            )

        # Discover which extended columns are present in this DB
        pragma_rows = conn.execute("PRAGMA table_info(player_game_stats)").fetchall()
        existing_cols = {row["name"] for row in pragma_rows}
        available_extended = [c for c in EXTENDED_STATS if c in existing_cols]

        # Build SELECT clause — always include core stats, optionally extended
        extended_select = "".join(
            f", pgs.{col}" for col in available_extended
        )

        where_clauses = ["pgs.player_id = :player_id"]
        params: Dict[str, Any] = {"player_id": resolved_player_id}

        if season_from is not None:
            where_clauses.append("g.season_year >= :season_from")
            params["season_from"] = season_from

        if season_to is not None:
            where_clauses.append("g.season_year <= :season_to")
            params["season_to"] = season_to

        if normalized_date_from is not None:
            where_clauses.append("g.game_date >= :date_from")
            params["date_from"] = normalized_date_from

        if normalized_date_to is not None:
            where_clauses.append("g.game_date <= :date_to")
            params["date_to"] = normalized_date_to

        if normalized_game_type:
            mapped = GAME_TYPE_MAP.get(normalized_game_type)
            if mapped:
                where_clauses.append("g.game_type IN ({})".format(
                    ", ".join(f":game_type_{i}" for i in range(len(mapped)))
                ))
                for i, label in enumerate(mapped):
                    params[f"game_type_{i}"] = label

        if resolved_without_pid is not None:
            where_clauses.append(
                "pgs.game_id NOT IN (SELECT game_id FROM player_game_stats WHERE player_id = :without_player_id)"
            )
            params["without_player_id"] = resolved_without_pid

        sql = f"""
            SELECT
                g.game_date,
                g.season_year,
                g.round_number,
                g.game_type,
                opponent.team_name  AS opponent_name,
                v.venue_name,
                pgs.location,
                pgs.game_time,
                pgs.days_since_last_game,
                pgs.disposals,
                pgs.goals,
                pgs.marks,
                pgs.tackles
                {extended_select}
            FROM player_game_stats pgs
            JOIN games g              ON g.game_id          = pgs.game_id
            JOIN teams opponent       ON opponent.team_id   = pgs.opponent_team_id
            JOIN venues v             ON v.venue_id         = pgs.venue_id
            WHERE {' AND '.join(where_clauses)}
            ORDER BY g.game_date DESC
        """

        rows = conn.execute(sql, params).fetchall()

    games = []
    for row in rows:
        entry = GameLogEntry(
            game_date=row["game_date"],
            season_year=row["season_year"],
            round_number=row["round_number"],
            game_type=row["game_type"],
            opponent_name=row["opponent_name"],
            venue_name=row["venue_name"],
            location=row["location"],
            game_time=row["game_time"],
            days_since_last_game=row["days_since_last_game"],
            disposals=row["disposals"] or 0,
            goals=row["goals"] or 0,
            marks=row["marks"] or 0,
            tackles=row["tackles"] or 0,
            kicks=row["kicks"] if "kicks" in available_extended else None,
            handballs=row["handballs"] if "handballs" in available_extended else None,
            clearances=row["clearances"] if "clearances" in available_extended else None,
            hit_outs=row["hit_outs"] if "hit_outs" in available_extended else None,
        )
        games.append(entry)

    return GameLogResponse(games=games, total=len(games))


@app.post("/search/sgm", response_model=SgmResponse)
def search_sgm(request: Request, payload: SgmRequest):
    _require_internal_secret(request)

    # Accept 1-selection payloads so loose-mode SGMs can have a single player
    # per team (each team's request is a full independent SGM; the frontend
    # combines the two teams' weighted outcomes into a loose aggregate).
    if not payload.selections or len(payload.selections) < 1 or len(payload.selections) > 12:
        raise HTTPException(status_code=400, detail="Provide between 1 and 12 selections")

    if payload.bet_mode not in {"over_under", "win_loss"}:
        raise HTTPException(status_code=400, detail="Invalid bet_mode. Must be over_under or win_loss")

    _validate_season_range(payload.season_from, payload.season_to)
    normalized_date_from = _normalize_date(payload.date_from, "date_from")
    normalized_date_to = _normalize_date(payload.date_to, "date_to")
    _validate_date_range(normalized_date_from, normalized_date_to)
    normalized_location = _normalize_location(payload.location)
    normalized_opponent = _normalize_text(payload.opponent)
    normalized_venue = _normalize_text(payload.venue)
    normalized_game_type = _normalize_game_type(payload.game_type)
    if (
        payload.days_rest_min is not None
        and payload.days_rest_max is not None
        and payload.days_rest_min > payload.days_rest_max
    ):
        raise HTTPException(status_code=400, detail="days_rest_min must be less than or equal to days_rest_max")

    with get_connection() as conn:
        resolved: List[Dict[str, Any]] = []
        for selection in payload.selections:
            has_player_id = selection.player_id is not None
            has_player_name = bool(selection.player_name)
            if has_player_id == has_player_name:
                raise HTTPException(
                    status_code=400,
                    detail="Each selection must include exactly one of player_id or player_name",
                )
            if selection.stat not in VALID_STATS:
                raise HTTPException(status_code=400, detail="Invalid stat. Must be one of disposals|goals|tackles|marks|kicks|handballs|clearances|hit_outs")
            resolved_player_id = _resolve_player_id(
                conn, player_id=selection.player_id, player_name=selection.player_name
            )
            resolved.append(
                {
                    "player_id": resolved_player_id,
                    "stat": selection.stat,
                    "threshold": selection.threshold,
                    "strict_over": selection.strict_over,
                }
            )

        result = _fetch_sgm(
            conn,
            selections=resolved,
            season_from=payload.season_from,
            season_to=payload.season_to,
            date_from=normalized_date_from,
            date_to=normalized_date_to,
            location=normalized_location,
            opponent=normalized_opponent,
            venue=normalized_venue,
            game_type=normalized_game_type,
            bet_mode=payload.bet_mode,
            days_rest_min=payload.days_rest_min,
            days_rest_max=payload.days_rest_max,
        )

    return SgmResponse(**result)


@app.post("/search/sgm-game-log", response_model=SgmGameLogResponse)
def search_sgm_game_log(request: Request, payload: SgmRequest):
    """Return game-by-game log for an SGM, grouped by game with per-player stats."""
    _require_internal_secret(request)

    if not payload.selections or len(payload.selections) < 2 or len(payload.selections) > 12:
        raise HTTPException(status_code=400, detail="Provide between 2 and 12 selections")

    _validate_season_range(payload.season_from, payload.season_to)
    normalized_date_from = _normalize_date(payload.date_from, "date_from")
    normalized_date_to = _normalize_date(payload.date_to, "date_to")
    _validate_date_range(normalized_date_from, normalized_date_to)
    normalized_location = _normalize_location(payload.location)
    normalized_opponent = _normalize_text(payload.opponent)
    normalized_venue = _normalize_text(payload.venue)
    normalized_game_type = _normalize_game_type(payload.game_type)

    with get_connection() as conn:
        resolved: List[Dict[str, Any]] = []
        for selection in payload.selections:
            has_player_id = selection.player_id is not None
            has_player_name = bool(selection.player_name)
            if has_player_id == has_player_name:
                raise HTTPException(
                    status_code=400,
                    detail="Each selection must include exactly one of player_id or player_name",
                )
            if selection.stat not in VALID_STATS:
                raise HTTPException(status_code=400, detail="Invalid stat. Must be one of disposals|goals|tackles|marks|kicks|handballs|clearances|hit_outs")
            resolved_player_id = _resolve_player_id(
                conn, player_id=selection.player_id, player_name=selection.player_name
            )
            player_name_display = selection.player_name or ""
            if not player_name_display:
                name_row = conn.execute(
                    "SELECT player_name FROM players WHERE player_id = ? LIMIT 1",
                    (resolved_player_id,),
                ).fetchone()
                player_name_display = name_row["player_name"] if name_row else f"Player #{resolved_player_id}"
            resolved.append(
                {
                    "player_id": resolved_player_id,
                    "player_name": player_name_display,
                    "stat": selection.stat,
                    "threshold": selection.threshold,
                    "strict_over": selection.strict_over,
                }
            )

        result = _fetch_sgm_game_log(
            conn,
            selections=resolved,
            season_from=payload.season_from,
            season_to=payload.season_to,
            date_from=normalized_date_from,
            date_to=normalized_date_to,
            location=normalized_location,
            opponent=normalized_opponent,
            venue=normalized_venue,
            game_type=normalized_game_type,
        )

    return SgmGameLogResponse(**result)


# ============================================================================
# FIXTURES ENDPOINTS
# ============================================================================

@app.get("/fixtures/upcoming", response_model=UpcomingFixturesResponse)
def get_upcoming_fixtures(
    limit: int = Query(10, ge=1, le=50, description="Maximum number of fixtures to return"),
    round_number: Optional[int] = Query(None, ge=0, le=40, description="Filter by specific round number"),
):
    """
    Get the reviewed remaining finals draw, otherwise current-season database fixtures.
    Returns fixtures ordered by date, with TBC dates appearing last.
    """
    from app.afl_fixture_overlay import now_local, remaining_fixtures
    current = now_local()
    with get_connection() as conn:
        try:
            reviewed = remaining_fixtures(conn, now=current)
        except (ValueError, KeyError, TypeError, OSError):
            raise HTTPException(503, 'Reviewed fixtures are temporarily unavailable')
        if reviewed is not None:
            if round_number is not None:
                reviewed = [f for f in reviewed if f['round_number'] == round_number]
            reviewed = reviewed[:limit]
            return UpcomingFixturesResponse(fixtures=reviewed, total=len(reviewed))
        # Build query - get fixtures with team and venue names
        sql = """
            SELECT 
                f.fixture_id,
                f.season_year,
                f.round_name,
                f.round_number,
                f.game_date,
                f.game_time,
                f.home_team_id,
                home.team_name AS home_team_name,
                f.away_team_id,
                away.team_name AS away_team_name,
                f.venue_id,
                v.venue_name
            FROM fixtures f
            JOIN teams home ON f.home_team_id = home.team_id
            JOIN teams away ON f.away_team_id = away.team_id
            JOIN venues v ON f.venue_id = v.venue_id
            WHERE f.season_year = :season
            AND (f.game_date IS NULL OR f.game_date >= :today)
        """
        params: Dict[str, Any] = {'season': current.year, 'today': current.date().isoformat()}

        if round_number is not None:
            sql += " AND f.round_number = :round_number"
            params["round_number"] = round_number
        
        # Order by date (nulls last for TBC), then by fixture_id
        sql += """
            ORDER BY 
                CASE WHEN f.game_date IS NULL THEN 1 ELSE 0 END,
                f.game_date,
                f.fixture_id
            LIMIT :limit
        """
        params["limit"] = limit
        
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
        cur.close()
        
        fixtures = [
            FixtureResponse(
                fixture_id=row["fixture_id"],
                season_year=row["season_year"],
                round_name=row["round_name"],
                round_number=row["round_number"],
                game_date=row["game_date"],
                game_time=row["game_time"],
                home_team_id=row["home_team_id"],
                home_team_name=row["home_team_name"],
                away_team_id=row["away_team_id"],
                away_team_name=row["away_team_name"],
                venue_id=row["venue_id"],
                venue_name=row["venue_name"],
            )
            for row in rows
        ]
        
        return UpcomingFixturesResponse(fixtures=fixtures, total=len(fixtures))


@app.get("/fixtures/{fixture_id}", response_model=FixtureResponse)
def get_fixture(fixture_id: int = Path(..., description="Fixture ID")):
    """Get a single fixture by ID."""
    with get_connection() as conn:
        if fixture_id < 0:
            from app.afl_fixture_overlay import remaining_fixtures
            try:
                reviewed = remaining_fixtures(conn) or []
            except (ValueError, KeyError, TypeError, OSError):
                raise HTTPException(503, 'Reviewed fixtures are temporarily unavailable')
            match = next((f for f in reviewed if f['fixture_id'] == fixture_id), None)
            if match is None:
                raise HTTPException(404, 'Fixture not found')
            return FixtureResponse(**match)
        sql = """
            SELECT 
                f.fixture_id,
                f.season_year,
                f.round_name,
                f.round_number,
                f.game_date,
                f.game_time,
                f.home_team_id,
                home.team_name AS home_team_name,
                f.away_team_id,
                away.team_name AS away_team_name,
                f.venue_id,
                v.venue_name
            FROM fixtures f
            JOIN teams home ON f.home_team_id = home.team_id
            JOIN teams away ON f.away_team_id = away.team_id
            JOIN venues v ON f.venue_id = v.venue_id
            WHERE f.fixture_id = :fixture_id
        """
        cur = conn.execute(sql, {"fixture_id": fixture_id})
        row = cur.fetchone()
        cur.close()
        
        if not row:
            raise HTTPException(status_code=404, detail="Fixture not found")
        
        return FixtureResponse(
            fixture_id=row["fixture_id"],
            season_year=row["season_year"],
            round_name=row["round_name"],
            round_number=row["round_number"],
            game_date=row["game_date"],
            game_time=row["game_time"],
            home_team_id=row["home_team_id"],
            home_team_name=row["home_team_name"],
            away_team_id=row["away_team_id"],
            away_team_name=row["away_team_name"],
            venue_id=row["venue_id"],
            venue_name=row["venue_name"],
        )


# ============================================================================
# PERFORMANCE MONITORING ENDPOINTS
# ============================================================================

class PerformanceStatsResponse(BaseModel):
    """Performance statistics for monitoring and analysis"""
    total_requests: int
    cache_hits: int
    cache_misses: int
    cache_hit_rate: float
    query_times: Dict[str, float]
    player_resolution_times: Dict[str, float]
    timestamp: str


@app.get("/performance/stats", response_model=PerformanceStatsResponse)
def get_performance_stats():
    """
    Get performance statistics for analysis.
    Returns query times, cache performance, and other metrics.
    """
    with _perf_lock:
        query_times = _perf_stats["query_times"]
        player_times = _perf_stats["player_resolution_times"]
        total_requests = _perf_stats["total_requests"]
        cache_hits = _perf_stats["cache_hits"]
        cache_misses = _perf_stats["cache_misses"]
    
    # Calculate statistics
    def calc_stats(times: List[float]) -> Dict[str, float]:
        if not times:
            return {"count": 0, "min": 0, "max": 0, "avg": 0, "p50": 0, "p95": 0, "p99": 0}
        sorted_times = sorted(times)
        n = len(sorted_times)
        return {
            "count": n,
            "min": min(sorted_times),
            "max": max(sorted_times),
            "avg": sum(sorted_times) / n,
            "p50": sorted_times[int(n * 0.50)],
            "p95": sorted_times[int(n * 0.95)] if n > 0 else 0,
            "p99": sorted_times[int(n * 0.99)] if n > 0 else 0,
        }
    
    cache_hit_rate = (cache_hits / total_requests * 100) if total_requests > 0 else 0.0
    
    return PerformanceStatsResponse(
        total_requests=total_requests,
        cache_hits=cache_hits,
        cache_misses=cache_misses,
        cache_hit_rate=round(cache_hit_rate, 2),
        query_times=calc_stats(query_times),
        player_resolution_times=calc_stats(player_times),
        timestamp=datetime.utcnow().isoformat()
    )


# ============================================================================
# SEARCH FEEDBACK ENDPOINT
# ============================================================================

@app.post("/search/feedback", response_model=SearchFeedbackResponse)
def submit_search_feedback(request: SearchFeedbackRequest):
    """
    Submit user feedback about search speed (instant vs bad delay).
    Stores feedback with search parameters and response time for analysis.
    """
    # Validate stat
    if request.stat not in VALID_STATS:
        raise HTTPException(status_code=400, detail="Invalid stat. Must be one of disposals|goals|tackles|marks|kicks|handballs|clearances|hit_outs")
    
    # Validate that at least one identifier is provided
    if not request.player_name and request.player_id is None:
        raise HTTPException(status_code=400, detail="Provide at least one of player_name or player_id")
    
    with get_connection() as conn:
        try:
            cur = conn.execute(
                """INSERT INTO search_feedback 
                   (feedback_type, player_name, player_id, stat, threshold, strict_over,
                    season_from, season_to, location, opponent, venue, game_type, response_time_ms)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    request.feedback_type,
                    request.player_name.strip() if request.player_name else None,
                    request.player_id,
                    request.stat,
                    request.threshold,
                    1 if request.strict_over else 0,
                    request.season_from,
                    request.season_to,
                    request.location,
                    request.opponent.strip() if request.opponent else None,
                    request.venue.strip() if request.venue else None,
                    request.game_type,
                    request.response_time_ms,
                )
            )
            feedback_id = cur.lastrowid
            conn.commit()
            cur.close()
            
            return SearchFeedbackResponse(
                success=True,
                message="Feedback submitted successfully",
                feedback_id=feedback_id
            )
        except sqlite3.Error as e:
            conn.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to save feedback: {e}")
        except Exception as e:
            conn.rollback()
            raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")
