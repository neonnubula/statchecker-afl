/**
 * Optional "Top picks" shown before a visitor types. Set
 * NEXT_PUBLIC_FEATURED_PLAYERS to a comma-separated list of player names that
 * exist in your database, e.g. "First Player,Second Player".
 */
export const FEATURED_PLAYER_NAMES: string[] = (process.env.NEXT_PUBLIC_FEATURED_PLAYERS || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
  .slice(0, 10);
