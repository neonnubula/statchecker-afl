-- StatChecker AFL database schema (SQLite).
--
-- This is the exact structure the backend reads. Create an empty database with:
--   python scripts/init_db.py            (or: sqlite3 database/afl_stats.db < database/schema.sql)
-- Then load your own data. See SCHEMA.md for what every table and column means
-- and how API-Sports AFL responses map onto it.

PRAGMA foreign_keys = ON;

CREATE TABLE players (
    player_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    date_of_birth DATE,
    debut_year INTEGER,             -- Year player debuted (e.g., 2006)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, api_player_id INTEGER);
CREATE INDEX idx_players_name ON players(player_name);
CREATE INDEX idx_players_last_name ON players(last_name);
CREATE TABLE teams (
    team_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_name TEXT NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, api_team_id INTEGER);
CREATE TABLE venues (
    venue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    venue_name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_venues_name ON venues(venue_name);
CREATE TABLE games (
    game_id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_year INTEGER NOT NULL,
    round_number INTEGER,              -- NULL for finals
    game_type TEXT NOT NULL,           -- 'Pre-Season', 'Regular Season', 'Finals'
    game_date DATE NOT NULL,
    game_time TIME,
    venue_id INTEGER NOT NULL,
    home_team_id INTEGER NOT NULL,
    away_team_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, api_game_id INTEGER,
    
    FOREIGN KEY (venue_id) REFERENCES venues(venue_id),
    FOREIGN KEY (home_team_id) REFERENCES teams(team_id),
    FOREIGN KEY (away_team_id) REFERENCES teams(team_id),
    
    CHECK (game_type IN ('Pre-Season', 'Regular Season', 'Finals')),
    CHECK (home_team_id != away_team_id)
);
CREATE INDEX idx_games_date ON games(game_date);
CREATE INDEX idx_games_season ON games(season_year);
CREATE INDEX idx_games_home_team ON games(home_team_id);
CREATE INDEX idx_games_away_team ON games(away_team_id);
CREATE INDEX idx_games_venue ON games(venue_id);
CREATE INDEX idx_games_type ON games(game_type);
CREATE TABLE player_game_stats (
    stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,          -- Team they played for in this game
    opponent_team_id INTEGER NOT NULL, -- Team they played against
    venue_id INTEGER NOT NULL,         -- Where the game was played
    location TEXT NOT NULL,            -- 'Home' or 'Away'
    game_time TEXT,                    -- 'Day', 'Twilight', or 'Night' (based on your time boundaries)
    
    -- Core statistics (simplified - only disposals and goals)
    disposals INTEGER DEFAULT 0,
    goals INTEGER DEFAULT 0,
    
    -- Derived/calculated fields
    days_since_last_game INTEGER,      -- Days since this player's previous game
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, marks INTEGER DEFAULT 0, tackles INTEGER DEFAULT 0, kicks INTEGER, handballs INTEGER, clearances INTEGER, hit_outs INTEGER,
    
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (game_id) REFERENCES games(game_id),
    FOREIGN KEY (team_id) REFERENCES teams(team_id),
    FOREIGN KEY (opponent_team_id) REFERENCES teams(team_id),
    FOREIGN KEY (venue_id) REFERENCES venues(venue_id),
    
    CHECK (location IN ('Home', 'Away')),
    CHECK (game_time IS NULL OR game_time IN ('Day', 'Twilight', 'Night')),
    
    -- Ensure one stat entry per player per game
    UNIQUE(player_id, game_id)
);
CREATE INDEX idx_pgs_player ON player_game_stats(player_id);
CREATE INDEX idx_pgs_game ON player_game_stats(game_id);
CREATE INDEX idx_pgs_team ON player_game_stats(team_id);
CREATE INDEX idx_pgs_opponent ON player_game_stats(opponent_team_id);
CREATE INDEX idx_pgs_venue ON player_game_stats(venue_id);
CREATE INDEX idx_pgs_location ON player_game_stats(location);
CREATE INDEX idx_pgs_game_time ON player_game_stats(game_time);
CREATE INDEX idx_pgs_player_date ON player_game_stats(player_id, game_id);
CREATE TABLE player_team_history (
    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,                     -- NULL if currently with team
    is_current BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX idx_pth_player ON player_team_history(player_id);
CREATE INDEX idx_pth_team ON player_team_history(team_id);
CREATE INDEX idx_pth_current ON player_team_history(is_current);
CREATE TRIGGER update_player_game_stats_timestamp 
AFTER UPDATE ON player_game_stats
BEGIN
    UPDATE player_game_stats 
    SET updated_at = CURRENT_TIMESTAMP 
    WHERE stat_id = NEW.stat_id;
END;
CREATE TRIGGER update_games_timestamp 
AFTER UPDATE ON games
BEGIN
    UPDATE games 
    SET updated_at = CURRENT_TIMESTAMP 
    WHERE game_id = NEW.game_id;
END;
CREATE TRIGGER update_players_timestamp 
AFTER UPDATE ON players
BEGIN
    UPDATE players 
    SET updated_at = CURRENT_TIMESTAMP 
    WHERE player_id = NEW.player_id;
END;
CREATE UNIQUE INDEX idx_players_api_id ON players(api_player_id);
CREATE UNIQUE INDEX idx_games_api_id ON games(api_game_id);
CREATE UNIQUE INDEX idx_teams_api_id ON teams(api_team_id);
CREATE TABLE fixtures (
            fixture_id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_year INTEGER NOT NULL,
            round_name TEXT NOT NULL,
            round_number INTEGER,
            game_date DATE,
            game_time TEXT,
            home_team_id INTEGER NOT NULL,
            away_team_id INTEGER NOT NULL,
            venue_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (home_team_id) REFERENCES teams(team_id),
            FOREIGN KEY (away_team_id) REFERENCES teams(team_id),
            FOREIGN KEY (venue_id) REFERENCES venues(venue_id),
            CHECK (home_team_id != away_team_id)
        );
CREATE INDEX idx_fixtures_date ON fixtures(game_date);
CREATE INDEX idx_fixtures_season ON fixtures(season_year);
CREATE INDEX idx_fixtures_round ON fixtures(round_number);
CREATE INDEX idx_fixtures_home_team ON fixtures(home_team_id);
CREATE INDEX idx_fixtures_away_team ON fixtures(away_team_id);
CREATE INDEX idx_pgs_player_disposals ON player_game_stats(player_id, disposals);
CREATE INDEX idx_pgs_player_goals ON player_game_stats(player_id, goals);
CREATE INDEX idx_pgs_player_marks ON player_game_stats(player_id, marks);
CREATE INDEX idx_pgs_player_tackles ON player_game_stats(player_id, tackles);
CREATE TABLE search_feedback (
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
CREATE INDEX idx_feedback_type ON search_feedback(feedback_type);
CREATE INDEX idx_feedback_created ON search_feedback(created_at);
CREATE INDEX idx_feedback_response_time ON search_feedback(response_time_ms);
CREATE TABLE api_player_id_aliases (
    alias_api_player_id INTEGER PRIMARY KEY,
    canonical_player_id INTEGER NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
);
CREATE INDEX idx_aliases_canonical
    ON api_player_id_aliases(canonical_player_id);
CREATE VIEW vw_complete_game_stats AS
SELECT
    pgs.stat_id,
    pgs.player_id,
    p.player_name,
    p.first_name,
    p.last_name,
    pgs.game_id,
    g.game_date,
    g.season_year,
    g.round_number,
    g.game_type,
    pgs.team_id,
    t.team_name,
    pgs.opponent_team_id,
    opponent.team_name AS opponent_name,
    pgs.venue_id,
    v.venue_name,
    pgs.location,
    pgs.game_time,
    pgs.disposals,
    pgs.goals,
    pgs.marks,
    pgs.tackles,
    pgs.kicks,
    pgs.handballs,
    pgs.clearances,
    pgs.hit_outs,
    pgs.days_since_last_game
FROM player_game_stats pgs
JOIN players p ON pgs.player_id = p.player_id
JOIN games g ON pgs.game_id = g.game_id
JOIN teams t ON pgs.team_id = t.team_id
JOIN teams opponent ON pgs.opponent_team_id = opponent.team_id
JOIN venues v ON pgs.venue_id = v.venue_id;
