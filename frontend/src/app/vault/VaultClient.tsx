"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import NavbarSection from "@/components/landing/NavbarSection";
import FooterSection from "@/components/landing/FooterSection";
import { landingContent } from "@/content";
import SearchModeToggle from "@/components/SearchModeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Search } from "lucide-react";
import type { PlayerSuggestion } from "@/lib/api/types";
import { getPlayerAutocomplete } from "@/lib/api/client";
import type { SavedPlayer, SavedSearch, SavedWeight } from "@/lib/vault/types";
import {
  deleteSavedPlayer,
  deleteSavedSearch,
  deleteSavedWeights,
  fetchSavedPlayers,
  fetchSavedSearches,
  fetchSavedWeights,
  savePlayer,
  saveWeights,
  updateWeights,
} from "@/lib/vault/client";
import {
  DEFAULT_WEIGHT_MULTIPLIER,
  MAX_WEIGHT_MULTIPLIER,
  applyWeightSliderDetent,
} from "@/lib/weight-sliders";

const PENDING_SEARCH_KEY = "statchecker:pending-search";

const WEIGHT_FIELDS = [
  { key: "base", label: "All games" },
  { key: "location", label: "Home/Away" },
  { key: "venue", label: "Venue" },
  { key: "opponent", label: "Opponent" },
  { key: "lastSeason", label: "Last season" },
  { key: "last30Days", label: "Last 30 days" },
];

export default function VaultClient() {
  const router = useRouter();
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [savedWeights, setSavedWeights] = useState<SavedWeight[]>([]);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerSuggestions, setPlayerSuggestions] = useState<PlayerSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [weightsName, setWeightsName] = useState("");
  const [weightsDraft, setWeightsDraft] = useState<Record<string, number>>(() =>
    WEIGHT_FIELDS.reduce((acc, field) => ({ ...acc, [field.key]: DEFAULT_WEIGHT_MULTIPLIER }), {})
  );
  const [isSavingWeights, setIsSavingWeights] = useState(false);

  useEffect(() => {
    Promise.all([fetchSavedPlayers(), fetchSavedSearches(), fetchSavedWeights()]).then(
      ([players, searches, weights]) => {
        setSavedPlayers(players);
        setSavedSearches(searches);
        setSavedWeights(weights);
      }
    );
  }, []);

  useEffect(() => {
    let active = true;
    if (playerQuery.trim().length < 2) {
      setPlayerSuggestions([]);
      return;
    }
    setLoadingSuggestions(true);
    getPlayerAutocomplete(playerQuery.trim(), 8)
      .then((response) => {
        if (!active) return;
        setPlayerSuggestions(response.suggestions);
      })
      .finally(() => {
        if (!active) return;
        setLoadingSuggestions(false);
      });
    return () => {
      active = false;
    };
  }, [playerQuery]);

  const handleAddPlayer = async (suggestion: PlayerSuggestion) => {
    const saved = await savePlayer({
      player_id: suggestion.player_id,
      player_name: suggestion.player_name,
      team_id: suggestion.team_id ?? null,
      team_name: suggestion.team_name ?? null,
    });
    setSavedPlayers((prev) => [saved, ...prev.filter((p) => p.id !== saved.id)]);
    setPlayerQuery("");
    setPlayerSuggestions([]);
  };

  const handleRemovePlayer = async (id: string) => {
    await deleteSavedPlayer(id);
    setSavedPlayers((prev) => prev.filter((item) => item.id !== id));
  };

  const handleRunSearch = (search: SavedSearch) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        PENDING_SEARCH_KEY,
        JSON.stringify({ type: search.type, payload: search.payload })
      );
    }
    router.push(
      search.type === "sgm" ? "/sgm" : search.type === "multi" ? "/multi" : "/single"
    );
  };

  const handleRemoveSearch = async (id: string) => {
    await deleteSavedSearch(id);
    setSavedSearches((prev) => prev.filter((item) => item.id !== id));
  };

  const handleRemoveWeight = async (id: string) => {
    await deleteSavedWeights(id);
    setSavedWeights((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSaveWeights = async () => {
    if (!weightsName.trim()) {
      return;
    }
    setIsSavingWeights(true);
    try {
      const saved = await saveWeights({
        name: weightsName.trim(),
        weights: weightsDraft,
      });
      setSavedWeights((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)]);
      setWeightsName("");
    } finally {
      setIsSavingWeights(false);
    }
  };

  const weightTotal = useMemo(
    () => WEIGHT_FIELDS.reduce((sum, field) => sum + (weightsDraft[field.key] || 0), 0),
    [weightsDraft]
  );

  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground overflow-x-hidden">
      <NavbarSection content={landingContent.navbar} />

      <div className="flex-1 pt-28 pb-16">
        <div className="mx-auto max-w-[1136px] px-6">
          <header className="mb-8">
            <p className="text-[14px] font-normal text-muted-foreground">Vault</p>
            <h1 className="mt-3 text-[36px] md:text-[44px] leading-[1.05] font-medium tracking-[-0.035em]">
              My Vault
            </h1>
            <p className="mt-4 max-w-[640px] text-[17px] leading-[1.55] text-muted-foreground">
              Saved players, searches, and algorithm presets. Ready for next week.
            </p>
          </header>

          <SearchModeToggle className="mb-6" />

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <Card className="border border-border bg-card shadow-card">
              <CardContent className="p-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Saved players</h2>
                  <p className="text-xs text-muted-foreground">Save players to your quick picks for your next betting analysis.</p>
                </div>
                <div className="relative">
                  <Input
                    value={playerQuery}
                    onChange={(e) => setPlayerQuery(e.target.value)}
                    placeholder="Search player name"
                    className="pl-10 bg-card border-border text-foreground placeholder:text-muted-foreground"
                  />
                  <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                </div>
                {playerSuggestions.length > 0 && (
                  <div className="rounded-lg border border-border bg-card">
                    {playerSuggestions.map((player) => (
                      <button
                        key={player.player_id}
                        type="button"
                        className="w-full px-4 py-2 text-left text-sm hover:bg-muted flex items-center justify-between text-foreground"
                        onClick={() => handleAddPlayer(player)}
                      >
                        <span>{player.player_name}</span>
                        <Plus className="h-4 w-4 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                )}
                {loadingSuggestions && (
                  <p className="text-xs text-muted-foreground">Searching players...</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {savedPlayers.length === 0 && (
                    <p className="text-xs text-muted-foreground">No saved players yet.</p>
                  )}
                  {savedPlayers.map((player) => (
                    <Badge
                      key={player.id}
                      className="flex items-center gap-2 bg-muted text-foreground border border-border"
                    >
                      {player.player_name}
                      <button onClick={() => handleRemovePlayer(player.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-border bg-card shadow-card">
              <CardContent className="p-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Saved searches</h2>
                  <p className="text-xs text-muted-foreground">Run any saved search with one click.</p>
                </div>
                <div className="space-y-3">
                  {savedSearches.length === 0 && (
                    <p className="text-xs text-muted-foreground">No saved searches yet.</p>
                  )}
                  {savedSearches.map((search) => (
                    <div
                      key={search.id}
                      className="rounded-lg border border-border bg-card px-3 py-3 text-sm flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium text-foreground">
                          {search.type === "sgm" ? "SGM" : search.type === "multi" ? "Multi" : "Single"} search
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {search.type === "sgm"
                            ? `${Array.isArray((search.payload as any)?.selections) ? (search.payload as any).selections.length : 0} legs saved`
                            : search.type === "multi"
                              ? `${Array.isArray((search.payload as any)?.legs) ? (search.payload as any).legs.length : 0} legs saved`
                              : `${(search.payload as any)?.player_name ?? "Player"} • ${(search.payload as any)?.stat ?? "stat"} • ${(search.payload as any)?.threshold ?? ""}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => handleRunSearch(search)}>
                          Run
                        </Button>
                        <button onClick={() => handleRemoveSearch(search.id)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-6 border border-border bg-card shadow-card">
            <CardContent className="p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Saved weights</h2>
                <p className="text-xs text-muted-foreground">
                  Store up to three algorithm presets and reuse them in Single or SGM searches.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {WEIGHT_FIELDS.map((field) => (
                  <div key={field.key} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{field.label}</span>
                      <span>{weightsDraft[field.key] ?? DEFAULT_WEIGHT_MULTIPLIER}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={MAX_WEIGHT_MULTIPLIER}
                      value={weightsDraft[field.key] ?? DEFAULT_WEIGHT_MULTIPLIER}
                      onChange={(e) =>
                        setWeightsDraft((prev) => ({
                          ...prev,
                          [field.key]: applyWeightSliderDetent(Number(e.target.value)),
                        }))
                      }
                      className="mt-2 w-full accent-pulse-500"
                    />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  value={weightsName}
                  onChange={(e) => setWeightsName(e.target.value)}
                  placeholder="Preset name"
                  className="max-w-xs bg-card border-border text-foreground placeholder:text-muted-foreground"
                />
                <Button onClick={handleSaveWeights} disabled={isSavingWeights || !weightsName.trim()}>
                  Save preset
                </Button>
                <span className="text-xs text-muted-foreground">Total: {weightTotal}%</span>
              </div>
              <div className="space-y-2">
                {savedWeights.length === 0 && (
                  <p className="text-xs text-muted-foreground">No saved presets yet.</p>
                )}
                {savedWeights.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{item.name}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          updateWeights(item.id, { weights: weightsDraft, name: item.name }).then(
                            (updated) =>
                              setSavedWeights((prev) =>
                                prev.map((w) => (w.id === item.id ? updated : w))
                              )
                          )
                        }
                      >
                        Replace with draft
                      </Button>
                      <button onClick={() => handleRemoveWeight(item.id)}>
                        <Trash2 className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      <FooterSection />
    </main>
  );
}
