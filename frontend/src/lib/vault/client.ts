/**
 * Saved players, searches and weights, stored in this browser's localStorage.
 * Replace these functions with API calls if you add accounts and a database.
 */
import type { SavedPlayer, SavedSearch, SavedWeight } from "@/lib/vault/types";

const KEYS = { players: "statchecker.vault.players", searches: "statchecker.vault.searches", weights: "statchecker.vault.weights" };

function read<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, items: T[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    throw new Error("Browser storage is unavailable.");
  }
}

const newId = () => {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
};

export const fetchSavedPlayers = async (): Promise<SavedPlayer[]> => read<SavedPlayer>(KEYS.players);

export const savePlayer = async (payload: Partial<SavedPlayer>) => {
  const item: SavedPlayer = {
    id: newId(),
    player_id: payload.player_id ?? null,
    player_name: payload.player_name ?? "",
    team_id: payload.team_id ?? null,
    team_name: payload.team_name ?? null,
    created_at: new Date().toISOString(),
  };
  write(KEYS.players, [item, ...read<SavedPlayer>(KEYS.players)]);
  return item;
};

export const deleteSavedPlayer = async (id: string) => {
  write(KEYS.players, read<SavedPlayer>(KEYS.players).filter((item) => item.id !== id));
};

export const fetchSavedSearches = async (): Promise<SavedSearch[]> => read<SavedSearch>(KEYS.searches);

export const saveSearch = async (payload: { type: "single" | "sgm" | "multi"; payload: Record<string, unknown> }) => {
  const item: SavedSearch = { id: newId(), type: payload.type, payload: payload.payload, created_at: new Date().toISOString() };
  write(KEYS.searches, [item, ...read<SavedSearch>(KEYS.searches)]);
  return item;
};

export const deleteSavedSearch = async (id: string) => {
  write(KEYS.searches, read<SavedSearch>(KEYS.searches).filter((item) => item.id !== id));
};

export const fetchSavedWeights = async (): Promise<SavedWeight[]> => read<SavedWeight>(KEYS.weights);

export const saveWeights = async (payload: { name: string; weights: Record<string, number> }) => {
  const item: SavedWeight = { id: newId(), name: payload.name, weights: payload.weights, created_at: new Date().toISOString() };
  write(KEYS.weights, [item, ...read<SavedWeight>(KEYS.weights)]);
  return item;
};

export const updateWeights = async (id: string, payload: { name?: string; weights?: Record<string, number> }) => {
  const items = read<SavedWeight>(KEYS.weights);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("Unable to update weights.");
  items[index] = { ...items[index], ...payload };
  write(KEYS.weights, items);
  return items[index];
};

export const deleteSavedWeights = async (id: string) => {
  write(KEYS.weights, read<SavedWeight>(KEYS.weights).filter((item) => item.id !== id));
};
