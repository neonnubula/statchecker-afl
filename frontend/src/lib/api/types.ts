/**
 * TypeScript types for the StatChecker API
 */

/**
 * Statistic types supported by the API
 */
export type StatType =
  | 'disposals'
  | 'goals'
  | 'tackles'
  | 'marks'
  | 'kicks'
  | 'handballs'
  | 'clearances'
  | 'hit_outs';

/**
 * Request parameters for the over/under endpoint
 */
export interface OverUnderParams {
  /** Player's full name (e.g., "Player Name") */
  player_name?: string;
  /** Player ID number */
  player_id?: number;
  /** Statistic type: "disposals" or "goals" */
  stat: StatType;
  /** The threshold value (e.g., 23.5) */
  threshold: number;
  /** If true: over uses `>`, under uses `<=`. If false: over uses `>=`, under uses `<` */
  strict_over?: boolean;
  /** Filter: start season (e.g., 2018) */
  season_from?: number;
  /** Filter: end season (e.g., 2023) */
  season_to?: number;
  /** Filter: start date (YYYY-MM-DD) */
  date_from?: string;
  /** Filter: end date (YYYY-MM-DD) */
  date_to?: string;
  /** Filter: home/away split */
  location?: 'home' | 'away';
  /** Filter: opponent team name */
  opponent?: string;
  /** Filter: venue name */
  venue?: string;
  /** Filter: regular season or finals */
  game_type?: 'regular' | 'finals' | 'all';
  /** Filter: minimum days since player's last game (inclusive) */
  days_rest_min?: number;
  /** Filter: maximum days since player's last game (inclusive) */
  days_rest_max?: number;
}

/**
 * Response from the over/under endpoint
 */
export interface GameLogReceipt {
  game_log_receipt?: string;
  /** Receipt expiry as Unix milliseconds. */
  game_log_receipt_expires_at?: number;
}

export interface OverUnderResponse extends GameLogReceipt {
  /** Number of games where the stat was over the threshold */
  over: number;
  /** Number of games where the stat was under the threshold */
  under: number;
}

export interface SgmSelection {
  player_id?: number;
  player_name?: string;
  stat: StatType;
  threshold: number;
  strict_over?: boolean;
}

export interface SgmRequest {
  selections: SgmSelection[];
  bet_mode: 'over_under' | 'win_loss';
  season_from?: number;
  season_to?: number;
  date_from?: string;
  date_to?: string;
  location?: 'home' | 'away';
  opponent?: string;
  venue?: string;
  game_type?: 'regular' | 'finals' | 'all';
  days_rest_min?: number;
  days_rest_max?: number;
}

export interface SgmResponse extends GameLogReceipt {
  outcomes: Record<string, number>;
  total: number;
}

/**
 * API error response
 */
export interface ApiError {
  detail: string;
  rateLimit?: {
    reason?: string;
    limit?: number;
    remaining?: number;
    resetAt?: number;
  };
}

/**
 * Search feedback type
 */
export type SearchFeedbackType = 'instant' | 'bad_delay';

/**
 * Request parameters for submitting search feedback
 */
export interface SearchFeedbackRequest {
  feedback_type: SearchFeedbackType;
  player_name?: string;
  player_id?: number;
  stat: StatType;
  threshold: number;
  strict_over?: boolean;
  season_from?: number;
  season_to?: number;
  location?: 'home' | 'away';
  opponent?: string;
  venue?: string;
  game_type?: 'regular' | 'finals' | 'all';
  response_time_ms?: number;
}

/**
 * Response from the feedback endpoint
 */
export interface SearchFeedbackResponse {
  success: boolean;
  message: string;
  feedback_id?: number;
}

// ─── Game Log Types ──────────────────────────────────────────────────────────

export interface GameLogEntry {
  game_date: string;
  season_year: number;
  round_number: number | null;
  game_type: string;
  opponent_name: string;
  venue_name: string;
  location: string;
  game_time: string | null;
  days_since_last_game: number | null;
  disposals: number;
  goals: number;
  marks: number;
  tackles: number;
  kicks: number | null;
  handballs: number | null;
  clearances: number | null;
  hit_outs: number | null;
}

export interface GameLogResponse {
  games: GameLogEntry[];
  total: number;
}

export interface GameLogParams {
  player_id?: number;
  player_name?: string;
  season_from?: number;
  season_to?: number;
  date_from?: string;
  date_to?: string;
  game_type?: string;
  without_player_id?: number;
}

// ─── Career Averages Types ───────────────────────────────────────────────────

export type CareerStatAverages = Record<string, number | null>;

export interface CareerSeasonAverages {
  season_year: number;
  team_name: string;
  games: number;
  averages: CareerStatAverages;
}

export interface PlayerCareerAveragesResponse {
  player_id: number;
  player_name: string;
  seasons: CareerSeasonAverages[];
}

// ─── SGM Game Log Types ─────────────────────────────────────────────────────

export interface SgmGameLogPlayerEntry {
  player_name: string;
  stat: string;
  threshold: number;
  stat_value: number | null;
  hit: boolean;
  disposals: number;
  goals: number;
  marks: number;
  tackles: number;
  kicks: number | null;
  handballs: number | null;
  clearances: number | null;
  hit_outs: number | null;
}

export interface SgmGameLogGame {
  game_date: string;
  season_year: number;
  round_number: number | null;
  game_type: string;
  opponent_name: string;
  venue_name: string;
  location: string;
  all_hit: boolean;
  players: SgmGameLogPlayerEntry[];
}

export interface SgmGameLogResponse {
  games: SgmGameLogGame[];
  total: number;
  all_hit_count: number;
}

/**
 * Player suggestion from autocomplete
 */
export interface PlayerSuggestion {
  player_id: number;
  player_name: string;
  games_played: number;
  games_2025: number;
  avg_disposals_2025: number;
  team_id?: number;
  team_name?: string;
}

/**
 * Response from player autocomplete endpoint
 */
export interface PlayerAutocompleteResponse {
  suggestions: PlayerSuggestion[];
  total: number;
}
