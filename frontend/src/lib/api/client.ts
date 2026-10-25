/**
 * API Client for StatChecker Backend
 * 
 * Provides functions to interact with the FastAPI backend.
 */

import { API_BASE_URL } from './config';
import { analyticsHeaders as currentAnalyticsHeaders } from '../analytics-client';
import type {
  OverUnderParams,
  OverUnderResponse,
  SgmRequest,
  SgmResponse,
  SgmGameLogResponse,
  ApiError,
  SearchFeedbackRequest,
  SearchFeedbackResponse,
  PlayerAutocompleteResponse,
  PlayerSuggestion,
  PlayerCareerAveragesResponse,
  GameLogParams,
  GameLogResponse,
  GameLogEntry,
} from './types';

const SEARCH_API_PREFIX =
  process.env.NEXT_PUBLIC_DEV_MODE === 'true' ? '/dev/api' : '/api';

type SearchPurpose = 'user' | 'probe' | 'prefetch' | 'context';
type RateLimitCallback = (info: { limit?: number; remaining?: number; resetAt?: number; reason?: string }) => void;
export type RequestOptions = {
  analyticsHeaders?: Record<string, string>;
  receipt?: string;
  receiptExpiresAt?: number;
  purpose?: SearchPurpose;
  /** Called with rate-limit metadata on every successful response (not just 429s). */
  onRateLimit?: RateLimitCallback;
};

export const GAME_LOG_RERUN_MESSAGE = 'Run this search again to load its game details.';

export function readGameLogReceiptHeaders(headers: Headers) {
  const token = headers.get('x-search-receipt');
  const expiry = Number(headers.get('x-search-receipt-expires-at'));
  if (!token || !Number.isFinite(expiry) || expiry <= 0) return {};
  return { game_log_receipt: token, game_log_receipt_expires_at: expiry };
}

/** Only a server receipt permits automatic details; never retry as a paid search. */
export function gameLogRequestHeaders(options: RequestOptions = {}): Record<string, string> {
  const automatic = options.purpose !== undefined && options.purpose !== 'user';
  if ((automatic && !options.receipt) || (options.receipt && options.receiptExpiresAt !== undefined
    && (!Number.isFinite(options.receiptExpiresAt) || options.receiptExpiresAt <= Date.now()))) {
    throw new ApiClientError(GAME_LOG_RERUN_MESSAGE, 403);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Re-read current preferences for every request, including automatic details.
  // A correlation snapshot taken before opt-out cannot turn collection back on.
  const analytics = currentAnalyticsHeaders(options.analyticsHeaders?.['x-analytics-request-id']);
  if (analytics['x-analytics-opt-out'] === '1' || options.analyticsHeaders?.['x-analytics-opt-out'] === '1') {
    headers['x-analytics-opt-out'] = '1';
  } else {
    Object.assign(headers, analytics);
  }
  if (options.purpose) headers['x-search-purpose'] = options.purpose;
  if (options.receipt) headers['x-search-receipt'] = options.receipt;
  return headers;
}

/** Context views require the original successful research receipt. */
export function researchRequestHeaders(options: RequestOptions = {}): Record<string, string> {
  if (options.purpose === 'probe' || options.purpose === 'prefetch') {
    throw new ApiClientError('Choose a search to load its results.', 403);
  }
  return gameLogRequestHeaders(options);
}

export function gameLogRestParams(identity: { player_id?: number; player_name?: string }, now = new Date()): GameLogParams {
  const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Australia/Melbourne', year: 'numeric' }).format(now));
  return {
    ...(identity.player_id !== undefined ? { player_id: identity.player_id } : { player_name: identity.player_name }),
    season_from: year - 1, season_to: year, game_type: 'all',
  };
}

/**
 * Custom error class for API errors
 */
export class ApiClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: ApiError
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

const readRateLimitHeaders = (headers: Headers) => {
  const resetAt = headers.get('x-ratelimit-reset');
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  if (!resetAt && !limit && !remaining) {
    return undefined;
  }
  return {
    reason: headers.get('x-ratelimit-reason') ?? undefined,
    resetAt: resetAt ? Number(resetAt) * 1000 : undefined,
    limit: limit ? Number(limit) : undefined,
    remaining: remaining ? Number(remaining) : undefined,
  };
};

/**
 * Fetches over/under game counts for a player's statistic across their full career history.
 * 
 * @param params - Request parameters
 * @returns Promise resolving to over/under counts
 * @throws {ApiClientError} If the request fails
 * 
 * @example
 * ```typescript
 * const stats = await getPlayerOverUnder({
 *   player_name: 'Player Name',
 *   stat: 'disposals',
 *   threshold: 23.5
 * });
 * console.log(`Over: ${stats.over}, Under: ${stats.under}`);
 * ```
 */
export async function getPlayerOverUnder(
  params: OverUnderParams,
  options: RequestOptions = {}
): Promise<OverUnderResponse> {
  // Validate that exactly one of player_name or player_id is provided
  const hasPlayerName = params.player_name !== undefined && params.player_name !== '';
  const hasPlayerId = params.player_id !== undefined;
  
  if (!hasPlayerName && !hasPlayerId) {
    throw new ApiClientError('Provide exactly one of player_id or player_name');
  }
  
  if (hasPlayerName && hasPlayerId) {
    throw new ApiClientError('Provide exactly one of player_id or player_name');
  }
  
  // Build query parameters
  const queryParams = new URLSearchParams();
  
  if (params.player_name) {
    queryParams.append('player_name', params.player_name);
  }
  
  if (params.player_id !== undefined) {
    queryParams.append('player_id', params.player_id.toString());
  }
  
  queryParams.append('stat', params.stat);
  queryParams.append('threshold', params.threshold.toString());
  
  if (params.strict_over !== undefined) {
    queryParams.append('strict_over', params.strict_over.toString());
  }

  if (params.season_from !== undefined) {
    queryParams.append('season_from', params.season_from.toString());
  }

  if (params.season_to !== undefined) {
    queryParams.append('season_to', params.season_to.toString());
  }

  if (params.date_from) {
    queryParams.append('date_from', params.date_from);
  }

  if (params.date_to) {
    queryParams.append('date_to', params.date_to);
  }

  if (params.location) {
    queryParams.append('location', params.location);
  }

  if (params.opponent) {
    queryParams.append('opponent', params.opponent);
  }

  if (params.venue) {
    queryParams.append('venue', params.venue);
  }

  if (params.game_type) {
    queryParams.append('game_type', params.game_type);
  }

  if (params.days_rest_min !== undefined) {
    queryParams.append('days_rest_min', params.days_rest_min.toString());
  }

  if (params.days_rest_max !== undefined) {
    queryParams.append('days_rest_max', params.days_rest_max.toString());
  }

  const url = `${SEARCH_API_PREFIX}/search/over-under?${queryParams.toString()}`;
  
  // Log the URL in development for debugging
  if (process.env.NODE_ENV === 'development') {
    console.log('API Request URL:', url);
    console.log('API Base URL:', API_BASE_URL);
  }
  
  try {
    const headers = researchRequestHeaders(options);
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });
    
    // Check if response is JSON before parsing
    const contentType = response.headers.get('content-type');
    let data;
    
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error('Non-JSON response received:', text.substring(0, 200));
      console.error('API URL attempted:', url);
      throw new ApiClientError(
        `Expected JSON but received ${contentType || 'unknown content type'}. Check that NEXT_PUBLIC_API_BASE_URL is set correctly. Current API URL: ${url}`,
        response.status
      );
    }
    
    data = await response.json();
    const rateLimit = readRateLimitHeaders(response.headers);
    
    if (!response.ok) {
      const error: ApiError = rateLimit ? { ...data, rateLimit } : data;
      throw new ApiClientError(
        error.detail || 'Request failed',
        response.status,
        error
      );
    }

    if (rateLimit && options.onRateLimit) {
      options.onRateLimit(rateLimit);
    }
    
    return { ...data, ...readGameLogReceiptHeaders(response.headers) } as OverUnderResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    
    // Handle network errors and JSON parse errors
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      throw new ApiClientError(
        `Invalid response from API. Make sure NEXT_PUBLIC_API_BASE_URL is set to your backend URL (currently: ${API_BASE_URL})`,
        undefined
      );
    }
    
    throw new ApiClientError(
      error instanceof Error ? error.message : 'Network error occurred',
      undefined,
      undefined
    );
  }
}

/** Component-local cache: context responses never satisfy a paid submission. */
export function createPlayerStatsLoader() {
  const cache = new Map<string, OverUnderResponse>();
  const inflight = new Map<string, Promise<OverUnderResponse>>();
  return (params: OverUnderParams, options: RequestOptions = {}) => {
    try { researchRequestHeaders(options); }
    catch (error) { return { promise: Promise.reject<OverUnderResponse>(error), fromCache: false }; }
    const context = options.purpose === 'context';
    const scope = context ? `context:${options.receipt}` : 'user';
    const key = `${scope}:${JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))}`;
    const cached = context ? cache.get(key) : undefined;
    if (cached) return { promise: Promise.resolve(cached), fromCache: true };
    let promise = inflight.get(key);
    if (!promise) {
      promise = getPlayerOverUnder(params, options)
        .then((data) => {
          if (context) cache.set(key, data);
          return data;
        })
        .finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
      inflight.set(key, promise);
    }
    return { promise, fromCache: false };
  };
}

export async function getSgmOutcomes(
  payload: SgmRequest,
  options: RequestOptions = {}
): Promise<SgmResponse> {
  const url = `${SEARCH_API_PREFIX}/search/sgm`;

  try {
    const headers = researchRequestHeaders(options);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error('Non-JSON response received:', text.substring(0, 200));
      throw new ApiClientError(
        `Expected JSON but received ${contentType || 'unknown content type'}.`,
        response.status
      );
    }

    const data = await response.json();
    const rateLimit = readRateLimitHeaders(response.headers);

    if (!response.ok) {
      const payload: ApiError = rateLimit ? { ...data, rateLimit } : data;
      throw new ApiClientError(data.detail || 'SGM search failed', response.status, payload);
    }

    if (rateLimit && options.onRateLimit) {
      options.onRateLimit(rateLimit);
    }

    return { ...data, ...readGameLogReceiptHeaders(response.headers) } as SgmResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    throw new ApiClientError(
      error instanceof Error ? error.message : 'Network error occurred',
      undefined,
      undefined
    );
  }
}

/**
 * Fetches game-by-game log for an SGM, grouped by game with per-player stats.
 */
export async function getSgmGameLog(
  payload: SgmRequest,
  options: RequestOptions = {}
): Promise<SgmGameLogResponse> {
  const url = `${SEARCH_API_PREFIX}/search/sgm-game-log`;

  try {
    const headers = gameLogRequestHeaders(options);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error('Non-JSON response received:', text.substring(0, 200));
      throw new ApiClientError(
        `Expected JSON but received ${contentType || 'unknown content type'}.`,
        response.status
      );
    }

    const data = await response.json();

    if (!response.ok) {
      throw new ApiClientError(data.detail || 'SGM game log failed', response.status, data);
    }

    return data as SgmGameLogResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    throw new ApiClientError(
      error instanceof Error ? error.message : 'Network error occurred',
      undefined,
      undefined
    );
  }
}

/**
 * Submits user feedback about search speed (instant vs bad delay).
 * 
 * @param feedback - Feedback data including type, search parameters, and response time
 * @returns Promise resolving to feedback response
 * @throws {ApiClientError} If the request fails
 * 
 * @example
 * ```typescript
 * await submitSearchFeedback({
 *   feedback_type: 'instant',
 *   player_name: 'Player Name',
 *   stat: 'disposals',
 *   threshold: 23.5,
 *   response_time_ms: 45
 * });
 * ```
 */
export async function submitSearchFeedback(
  feedback: SearchFeedbackRequest
): Promise<SearchFeedbackResponse> {
  const url = `${API_BASE_URL}/search/feedback`;
  
  // Log the URL in development for debugging
  if (process.env.NODE_ENV === 'development') {
    console.log('Feedback API Request URL:', url);
  }
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(feedback),
    });
    
    // Check if response is JSON before parsing
    const contentType = response.headers.get('content-type');
    let data;
    
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error('Non-JSON response received:', text.substring(0, 200));
      throw new ApiClientError(
        `Expected JSON but received ${contentType || 'unknown content type'}`,
        response.status
      );
    }
    
    data = await response.json();
    
    if (!response.ok) {
      const error: ApiError = data;
      throw new ApiClientError(
        error.detail || 'Request failed',
        response.status,
        error
      );
    }
    
    return data as SearchFeedbackResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    
    // Handle network errors and JSON parse errors
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      throw new ApiClientError(
        `Invalid response from API. Make sure NEXT_PUBLIC_API_BASE_URL is set correctly (currently: ${API_BASE_URL})`,
        undefined
      );
    }
    
    throw new ApiClientError(
      error instanceof Error ? error.message : 'Network error occurred',
      undefined,
      undefined
    );
  }
}

/**
 * Get player name suggestions for autocomplete.
 * 
 * @param query - Search query (minimum 2 characters)
 * @param limit - Maximum number of suggestions (default 10)
 * @returns Promise resolving to player suggestions
 * @throws {ApiClientError} If the request fails
 * 
 * @example
 * ```typescript
 * const suggestions = await getPlayerAutocomplete('nick', 5);
 * console.log(suggestions.suggestions); // [{ player_name: "Player Name", games_played: 95, ... }]
 * ```
 */
export async function getPlayerAutocomplete(
  query: string,
  limit: number = 10,
  teamId?: number,
  active2025?: boolean
): Promise<PlayerAutocompleteResponse> {
  if (query.length < 2) {
    return { suggestions: [], total: 0 };
  }
  
  const teamParam = teamId ? `&team_id=${teamId}` : '';
  const activeParam = active2025 ? `&active_2025=true` : '';
  const url = `${API_BASE_URL}/players/autocomplete?q=${encodeURIComponent(query)}&limit=${limit}${teamParam}${activeParam}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new ApiClientError('Expected JSON response from autocomplete', response.status);
    }
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new ApiClientError(data.detail || 'Autocomplete failed', response.status, data);
    }
    
    return data as PlayerAutocompleteResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    // Silently return empty results on network errors to not disrupt UX
    console.error('Autocomplete error:', error);
    return { suggestions: [], total: 0 };
  }
}

export async function getTeamPlayers(
  teamId: number,
  limit: number = 30
): Promise<PlayerAutocompleteResponse> {
  const url = `${API_BASE_URL}/teams/${teamId}/players?limit=${limit}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new ApiClientError('Expected JSON response from team players', response.status);
    }

    const data = await response.json();
    if (!response.ok) {
      throw new ApiClientError(data.detail || 'Team players failed', response.status, data);
    }

    return data as PlayerAutocompleteResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    console.error('Team players error:', error);
    return { suggestions: [], total: 0 };
  }
}

export async function getTeamRosterByName(
  teamName: string,
  limit: number = 50
): Promise<PlayerAutocompleteResponse> {
  const url = `${API_BASE_URL}/teams/by-name/${encodeURIComponent(teamName)}/roster?limit=${limit}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new ApiClientError('Expected JSON response from team roster', response.status);
    }

    const data = await response.json();
    if (!response.ok) {
      throw new ApiClientError(data.detail || 'Team roster failed', response.status, data);
    }

    return data as PlayerAutocompleteResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    console.error('Team roster error:', error);
    return { suggestions: [], total: 0 };
  }
}

export async function getFeaturedPlayers(
  names: string[],
  seasonYear: number = 2025
): Promise<PlayerAutocompleteResponse> {
  if (names.length === 0) {
    return { suggestions: [], total: 0 };
  }

  const url = `${API_BASE_URL}/players/featured?names=${encodeURIComponent(
    names.join(',')
  )}&season_year=${seasonYear}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new ApiClientError('Expected JSON response from featured players', response.status);
    }

    const data = await response.json();

    if (!response.ok) {
      throw new ApiClientError(data.detail || 'Featured players failed', response.status, data);
    }

    return data as PlayerAutocompleteResponse;
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error;
    }
    console.error('Featured players error:', error);
    return { suggestions: [], total: 0 };
  }
}

/**
 * Preload all quick search stats for a player.
 * This fires off multiple requests in parallel to warm the cache.
 * 
 * @param playerName - Player name to preload stats for
 * @param playerId - Optional player ID (faster if provided)
 * @returns Promise that resolves when all preloads are initiated
 */
export async function preloadPlayerQuickStats(
  playerName: string,
  playerId?: number
): Promise<void> {
  // Quick search thresholds to preload
  const goalThresholds = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]; // 1+, 2+, 3+, 4+, 5+, 6+
  const disposalThresholds = [14.5, 19.5, 24.5, 29.5, 34.5, 39.5]; // 15+, 20+, 25+, 30+, 35+, 40+
  
  const requests: Promise<OverUnderResponse>[] = [];
  
  // Build base params
  const baseParams: Partial<OverUnderParams> = playerId 
    ? { player_id: playerId }
    : { player_name: playerName };
  
  // Preload goal stats
  for (const threshold of goalThresholds) {
    requests.push(
      getPlayerOverUnder({
        ...baseParams,
        stat: 'goals',
        threshold,
      } as OverUnderParams, { purpose: 'prefetch' }).catch(() => ({ over: 0, under: 0 }))
    );
  }
  
  // Preload disposal stats
  for (const threshold of disposalThresholds) {
    requests.push(
      getPlayerOverUnder({
        ...baseParams,
        stat: 'disposals',
        threshold,
      } as OverUnderParams, { purpose: 'prefetch' }).catch(() => ({ over: 0, under: 0 }))
    );
  }
  
  // Fire all requests in parallel (don't await - just initiate)
  Promise.all(requests).catch(() => {
    // Silently ignore errors - this is just preloading
  });
}

/**
 * Get career averages for a player (year-by-year breakdown).
 */
export async function getPlayerCareerAverages(
  playerId: number
): Promise<PlayerCareerAveragesResponse | null> {
  const url = `${SEARCH_API_PREFIX}/players/${playerId}/career-averages`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as PlayerCareerAveragesResponse;
  } catch {
    return null;
  }
}

/**
 * Get game-by-game log for a player.
 *
 * Automatic details require the successful parent search's receipt. Missing or
 * expired receipts never fall back to a separately charged standalone request.
 */
export async function getPlayerGameLog(
  params: GameLogParams,
  options: RequestOptions = {}
): Promise<GameLogResponse> {
  const queryParams = new URLSearchParams();

  if (params.player_id !== undefined) queryParams.append('player_id', params.player_id.toString());
  if (params.player_name) queryParams.append('player_name', params.player_name);
  if (params.season_from !== undefined) queryParams.append('season_from', params.season_from.toString());
  if (params.season_to !== undefined) queryParams.append('season_to', params.season_to.toString());
  if (params.date_from) queryParams.append('date_from', params.date_from);
  if (params.date_to) queryParams.append('date_to', params.date_to);
  if (params.game_type) queryParams.append('game_type', params.game_type);
  if (params.without_player_id !== undefined) queryParams.append('without_player_id', params.without_player_id.toString());

  const url = `${SEARCH_API_PREFIX}/search/game-log?${queryParams.toString()}`;

  const headers = gameLogRequestHeaders(options);

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: 'Game log request failed' }));
    throw new ApiClientError(data.detail || 'Game log request failed', response.status, data);
  }

  return (await response.json()) as GameLogResponse;
}

// Re-export types for convenience
export type { PlayerSuggestion, PlayerAutocompleteResponse, GameLogEntry };
