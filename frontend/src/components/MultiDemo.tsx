"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trackEvent } from "@/lib/analytics-client";
import { toast } from "sonner";
import { Plus, Trash2, X, Layers, SlidersHorizontal, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ResultsTemplate, WeightSlider } from "@/components/PlayerStatsDemo";
import { readCart, removeLeg, clearCart, setCart } from "@/lib/multi-cart";
import type { CategoryKey, LegSnapshot } from "@/lib/multi-types";
import {
  CATEGORY_KEYS,
  combineCategory,
  combineWeightedWithMultipliers,
  weightedLegPct,
  categoryAggregates,
  DEFAULT_MULTIPLIERS,
} from "@/lib/multi-combine";
import { MAX_WEIGHT_MULTIPLIER } from "@/lib/weight-sliders";
import { saveSearch } from "@/lib/vault/client";

type Multipliers = Record<CategoryKey, number>;

const legGamesCount = (leg: LegSnapshot): number => {
  const base = leg.categories?.base;
  return base ? base.over + base.under : 0;
};

const PENDING_SEARCH_KEY = "statchecker:pending-search";

const CATEGORY_TITLES: Record<CategoryKey, string> = {
  base: "Overall",
  thisSeason: "This season",
  lastSeason: "Last season",
  last30Days: "Last 30 days",
  opponent: "vs Opponent",
  location: "Home / Away",
  venue: "At Venue",
  daysRest: "Days rest",
};

export function MultiDemo() {
  const router = useRouter();
  const [legs, setLegs] = useState<LegSnapshot[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [weights, setWeights] = useState<Multipliers>({ ...DEFAULT_MULTIPLIERS } as Multipliers);
  const [weightsOpen, setWeightsOpen] = useState(false);

  // Hydrate the cart on mount. If the user ran a saved multi from the vault,
  // a pending-search payload of type 'multi' takes precedence and replaces the
  // cart; otherwise we read whatever is already in the cart. Saved multis may
  // also carry the weight settings used when they were saved.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(PENDING_SEARCH_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.type === "multi" && Array.isArray(parsed?.payload?.legs)) {
          window.localStorage.removeItem(PENDING_SEARCH_KEY);
          if (parsed.payload.weights && typeof parsed.payload.weights === "object") {
            setWeights({ ...DEFAULT_MULTIPLIERS, ...parsed.payload.weights } as Multipliers);
          }
          setLegs(setCart(parsed.payload.legs as LegSnapshot[]));
          return;
        }
      }
    } catch {
      // ignore malformed pending payloads
    }
    setLegs(readCart());
  }, []);

  const combinedPct = useMemo(
    () => combineWeightedWithMultipliers(legs, weights),
    [legs, weights]
  );

  // Per-category aggregate game counts (data depth) and weight shares, for the sliders.
  const aggregates = useMemo(() => categoryAggregates(legs, weights), [legs, weights]);

  const categoryResults = useMemo(
    () =>
      CATEGORY_KEYS.map((cat) => ({
        cat: cat as CategoryKey,
        result: combineCategory(legs, cat),
      })).filter((entry) => entry.result != null),
    [legs]
  );

  const weightsDirty = useMemo(
    () => CATEGORY_KEYS.some((k) => weights[k as CategoryKey] !== DEFAULT_MULTIPLIERS[k as keyof typeof DEFAULT_MULTIPLIERS]),
    [weights]
  );

  const handleRemove = (id: string) => {
    setLegs(removeLeg(id));
  };

  const handleClear = () => {
    setLegs(clearCart());
  };

  const handleSave = async () => {
    if (!legs.length) {
      return;
    }
    setIsSaving(true);
    try {
      await saveSearch({ type: "multi", payload: { legs, weights } });
      trackEvent("feature_used", { product: "afl", feature: "multi", properties: { action: "save" } });
      toast.success("Multi saved to your vault");
    } catch (err) {
      toast.error("Couldn't save multi. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Empty state ───────────────────────────────────────────────────────────
  if (!legs.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-white/70 px-6 py-16 text-center">
        <div className="mb-4 rounded-full bg-gray-100 p-4">
          <Layers className="h-8 w-8 text-gray-500" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900">No legs yet</h2>
        <p className="mt-1 mb-6 max-w-sm text-sm text-gray-600">
          Build a multi by running a player search and adding the result here. Your legs stay
          until you clear them.
        </p>
        <Button
          type="button"
          onClick={() => router.push("/single")}
          className="h-11 bg-gradient-to-r from-green-600 to-green-500 px-6 font-semibold text-white shadow-sm transition-all hover:from-green-700 hover:to-green-600 hover:shadow-md"
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Use single search to add your first leg
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Leg list */}
      <Card className="border border-gray-200 bg-white shadow-sm">
        <CardContent className="p-4 sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">
              Legs ({legs.length})
            </h2>
            <Button
              type="button"
              variant="outline"
              onClick={handleClear}
              className="h-9 px-3 text-xs font-semibold text-red-600 hover:bg-red-50"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Clear all
            </Button>
          </div>
          <ul className="divide-y divide-gray-100">
            {legs.map((leg) => {
              const legPct = weightedLegPct(leg.categories, weights) ?? leg.weightedOverPct;
              const games = legGamesCount(leg);
              return (
                <li key={leg.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900">{leg.label}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-semibold text-violet-700">
                        {legPct.toFixed(1)}% predicted{leg.betMode === "win_loss" ? " (win)" : ""}
                      </span>
                      <span className="text-gray-300">•</span>
                      <span className="text-gray-500">
                        {games} {games === 1 ? "game" : "games"} in filter
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${leg.label}`}
                    onClick={() => handleRemove(leg.id)}
                    className="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex justify-end border-t border-gray-100 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={handleSave}
              disabled={isSaving}
              className="h-10 px-4 text-sm font-semibold"
            >
              {isSaving ? "Saving..." : "Save to Vault"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Combined prediction headline */}
      <ResultsTemplate
        title="Combined prediction"
        loading={false}
        seasonFrom="any"
        seasonTo="any"
        showSeasonMeta={false}
        resultsFormat="both"
        marketLabel={`Multi • ${legs.length} ${legs.length === 1 ? "leg" : "legs"}`}
        isWinLossMode
        positiveLabel="All legs hit"
        negativeLabel="Any leg misses"
        percentageLabel="Combined probability"
        positiveGamesLabel=""
        negativeGamesLabel=""
        overrideOverPercentage={combinedPct}
        sampleLabel={`combined across ${legs.length} ${legs.length === 1 ? "leg" : "legs"}`}
      />

      {/* Weighting controls — recompute each leg's prediction live */}
      <Card className="border border-gray-200 bg-white shadow-sm">
        <CardContent className="p-4 sm:p-6">
          <button
            type="button"
            onClick={() => setWeightsOpen((prev) => !prev)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-gray-900">
              <SlidersHorizontal className="h-4 w-4 text-violet-600" />
              Adjust weights
              {weightsDirty && (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                  Custom
                </span>
              )}
            </span>
            {weightsOpen ? (
              <ChevronUp className="h-4 w-4 text-gray-400" />
            ) : (
              <ChevronDown className="h-4 w-4 text-gray-400" />
            )}
          </button>

          {weightsOpen && (
            <div className="mt-4 space-y-4">
              <p className="text-xs text-gray-500">
                Weights change how much each data set counts toward every leg&apos;s prediction,
                which moves the combined probability above. Game counts show the data depth pooled
                across all legs.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {CATEGORY_KEYS.map((key) => {
                  const cat = key as CategoryKey;
                  const games = aggregates.games[cat] ?? 0;
                  return (
                    <WeightSlider
                      key={cat}
                      label={CATEGORY_TITLES[cat]}
                      value={weights[cat]}
                      onChange={(value) => setWeights((prev) => ({ ...prev, [cat]: value }))}
                      count={games}
                      max={MAX_WEIGHT_MULTIPLIER}
                      disabled={games === 0}
                      percent={aggregates.share[cat]}
                    />
                  );
                })}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setWeights({ ...DEFAULT_MULTIPLIERS } as Multipliers)}
                  disabled={!weightsDirty}
                  className="h-9 px-3 text-xs font-semibold"
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reset weights
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-category combined hit rates */}
      {categoryResults.length > 0 && (
        <div className="space-y-2">
          <p className="px-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Combined hit rate by category
          </p>
          <p className="px-2 text-xs text-gray-400">
            Each card multiplies every leg&apos;s hit rate for that category. Categories where
            not all legs have data are hidden.
          </p>
          {categoryResults.map(({ cat, result }) => (
            <ResultsTemplate
              key={cat}
              title={CATEGORY_TITLES[cat]}
              loading={false}
              seasonFrom="any"
              seasonTo="any"
              showSeasonMeta={false}
              resultsFormat="text"
              marketLabel={`Multi • ${legs.length} ${legs.length === 1 ? "leg" : "legs"}`}
              isWinLossMode
              positiveLabel="All legs hit"
              negativeLabel="Any leg misses"
              percentageLabel="Combined hit rate"
              positiveGamesLabel=""
              negativeGamesLabel=""
              overrideOverPercentage={result!.pct}
              sampleLabel={`combined across ${legs.length} ${legs.length === 1 ? "leg" : "legs"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default MultiDemo;
