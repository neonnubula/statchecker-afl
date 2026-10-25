/**
 * Fixtures API Client
 * 
 * Provides functions to interact with the fixtures endpoints.
 */

import { API_BASE_URL } from './config';

/**
 * Single fixture response from the API
 */
export interface Fixture {
  fixture_id: number;
  season_year: number;
  round_name: string;
  round_number: number | null;
  game_date: string | null;
  game_time: string | null;
  home_team_id: number | null;
  home_team_name: string;
  away_team_id: number | null;
  away_team_name: string;
  venue_id: number | null;
  venue_name: string;
  game_type?: string | null;
  starts_at?: string | null;
  date_window_start?: string | null;
  date_window_end?: string | null;
  schedule_status?: string;
  selectable?: boolean;
  source?: string | null;
  source_urls?: string[];
  checked_at?: string | null;
  note?: string | null;
}

/**
 * Response from the upcoming fixtures endpoint
 */
export interface UpcomingFixturesResponse {
  fixtures: Fixture[];
  total: number;
}

/**
 * Placeholder player data for decorative display
 * Will be replaced with real API data when available
 */
export interface PlaceholderPlayer {
  id: number;
  name: string;
  team: string;
  position: string;
  avgDisposals: number;
  avgGoals: number;
}

/**
 * Custom error class for fixture API errors
 */
export class FixtureApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'FixtureApiError';
  }
}

/**
 * Fetches upcoming fixtures from the API
 * 
 * @param limit - Maximum number of fixtures to return (default: 10)
 * @param roundNumber - Optional filter by round number
 * @returns Promise resolving to upcoming fixtures
 */
export async function getUpcomingFixtures(
  limit: number = 10,
  roundNumber?: number
): Promise<UpcomingFixturesResponse> {
  const params = new URLSearchParams();
  params.append('limit', limit.toString());
  
  if (roundNumber !== undefined) {
    params.append('round_number', roundNumber.toString());
  }
  
  const url = `${API_BASE_URL}/fixtures/upcoming?${params.toString()}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Request failed' }));
      throw new FixtureApiError(error.detail || 'Request failed', response.status);
    }
    
    return await response.json();
  } catch (error) {
    if (error instanceof FixtureApiError) {
      throw error;
    }
    throw new FixtureApiError(
      error instanceof Error ? error.message : 'Network error occurred'
    );
  }
}

/**
 * Fetches a single fixture by ID
 * 
 * @param fixtureId - The fixture ID to fetch
 * @returns Promise resolving to the fixture
 */
export async function getFixture(fixtureId: number): Promise<Fixture> {
  const url = `${API_BASE_URL}/fixtures/${fixtureId}`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Request failed' }));
      throw new FixtureApiError(error.detail || 'Request failed', response.status);
    }
    
    return await response.json();
  } catch (error) {
    if (error instanceof FixtureApiError) {
      throw error;
    }
    throw new FixtureApiError(
      error instanceof Error ? error.message : 'Network error occurred'
    );
  }
}

/**
 * Generate placeholder players for a fixture (decorative only)
 * This will be replaced with real API data when player rosters are available
 */
export function getPlaceholderPlayers(fixture: Fixture): PlaceholderPlayer[] {
  const homeTeamPlayers = fixture.home_team_id == null ? [] : generateTeamPlaceholders(fixture.home_team_name, fixture.home_team_id);
  const awayTeamPlayers = fixture.away_team_id == null ? [] : generateTeamPlaceholders(fixture.away_team_name, fixture.away_team_id);
  
  // Interleave home and away players, sorted by "betting likelihood" (avgDisposals)
  const allPlayers = [...homeTeamPlayers, ...awayTeamPlayers];
  return allPlayers.sort((a, b) => b.avgDisposals - a.avgDisposals);
}

/**
 * Generate placeholder players for a team
 */
function generateTeamPlaceholders(teamName: string, teamId: number): PlaceholderPlayer[] {
  const positions = ['Midfielder', 'Forward', 'Defender', 'Ruck', 'Midfielder', 'Forward'];
  const baseId = teamId * 100;
  
  return positions.map((position, index) => ({
    id: baseId + index,
    name: `Player ${index + 1}`,
    team: teamName,
    position,
    avgDisposals: Math.round(15 + Math.random() * 15), // 15-30 range
    avgGoals: position === 'Forward' ? Math.round(1 + Math.random() * 3) : Math.round(Math.random() * 1.5),
  }));
}

/**
 * Format a fixture date for display
 */
export function formatFixtureDate(dateStr: string | null): string {
  if (!dateStr) return 'TBC';
  
  // A date-only fixture is a local calendar day, not a UTC instant.
  const date = new Date(`${dateStr}T12:00:00`);
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  };
  return date.toLocaleDateString('en-US', options);
}

/**
 * Format a fixture time for display
 */
export function formatFixtureTime(timeStr: string | null): string {
  if (!timeStr) return 'TBC';
  return timeStr;
}

/**
 * Get short team name for compact display
 */
export function getShortTeamName(fullName: string): string {
  const shortNames: Record<string, string> = {
    'Sydney Swans': 'Sydney',
    'Carlton Blues': 'Carlton',
    'Gold Coast Suns': 'Gold Coast',
    'Geelong Cats': 'Geelong',
    'Greater Western Sydney Giants': 'GWS',
    'Hawthorn Hawks': 'Hawthorn',
    'Brisbane Lions': 'Brisbane',
    'Western Bulldogs': 'Bulldogs',
    'St Kilda Saints': 'St Kilda',
    'Collingwood Magpies': 'Collingwood',
    'Adelaide Crows': 'Adelaide',
    'Essendon Bombers': 'Essendon',
    'Fremantle Dockers': 'Fremantle',
    'Melbourne Demons': 'Melbourne',
    'North Melbourne Kangaroos': 'North Melb',
    'Port Adelaide Power': 'Port Adelaide',
    'Richmond Tigers': 'Richmond',
    'West Coast Eagles': 'West Coast',
  };
  
  return shortNames[fullName] || fullName;
}
