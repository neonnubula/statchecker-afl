/**
 * Team lookups come from your own database through the API. These helpers are
 * kept so components can fall back gracefully; they no longer ship a roster.
 */
export function getPlayerTeam(_playerName: string): string | null {
  return null;
}

export function getTeamPlayers(_teamName: string): string[] {
  return [];
}

export const getPlayerTeam2025 = getPlayerTeam;
export const getTeamPlayers2025 = getTeamPlayers;
