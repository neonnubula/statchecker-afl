export type SavedPlayer = {
  id: string;
  player_id: number | null;
  player_name: string;
  team_id: number | null;
  team_name: string | null;
  created_at: string;
};

export type SavedSearch = {
  id: string;
  type: "single" | "sgm" | "multi";
  payload: Record<string, unknown>;
  created_at: string;
};

export type SavedWeight = {
  id: string;
  name: string;
  weights: Record<string, number>;
  created_at: string;
};
