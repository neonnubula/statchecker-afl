/**
 * Example Component: PlayerStatsDemo
 * 
 * Demonstrates how to use the usePlayerStats hook to fetch and display
 * player over/under statistics.
 * 
 * This is a reference implementation - you can use this as a starting point
 * for building your own player stats components.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startResearch, trackEvent } from '@/lib/analytics-client';

// Ref interface for external control
export interface PlayerStatsDemoRef {
  setPlayerAndPrepare: (playerName: string, options?: {
    opposition?: string;
    venue?: string;
    location?: 'home' | 'away';
  }) => void;
}
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { User, BarChart3, Target, TrendingUp, TrendingDown, Search, Loader2, CheckCircle2, XCircle, Info, Sparkles, ChevronDown, ChevronUp, Calendar, Users, MapPin, Building2, Trophy, SlidersHorizontal, Plus, Layers } from 'lucide-react';
import type { OverUnderParams, OverUnderResponse, StatType, PlayerSuggestion } from '@/lib/api/types';
import { getPlayerOverUnder, ApiClientError, getPlayerAutocomplete, getFeaturedPlayers, getPlayerGameLog, gameLogRestParams, createPlayerStatsLoader } from '@/lib/api/client';
import { PlayerGameLog } from '@/components/PlayerGameLog';
import { PlayerCareerAverages } from '@/components/PlayerCareerAverages';
import PlayerImpactResearch from '@/components/afl/PlayerImpactPanel';
import { fetchSavedPlayers, fetchSavedWeights, saveSearch, saveWeights } from '@/lib/vault/client';
import type { SavedPlayer, SavedWeight } from '@/lib/vault/types';
import { addLeg, readCart } from '@/lib/multi-cart';
import type { LegSnapshot } from '@/lib/multi-types';
import { toast } from 'sonner';
import type { Fixture } from '@/lib/api/fixtures';
import { getUpcomingFixtures } from '@/lib/api/fixtures';
import { isSelectableFixture, isUpcomingFinalFixture, nextGameType } from '@/lib/fixture-selection';
import { getPlayerTeam2025 } from '@/lib/data/playerTeams2025';
import { FEATURED_PLAYER_NAMES } from '@/lib/featured-players';
import {
  DEFAULT_WEIGHT_MULTIPLIER,
  DEFAULT_LAST_SEASON_MULTIPLIER,
  MAX_WEIGHT_MULTIPLIER,
  applyWeightSliderDetent,
  computeEffectiveWeight,
  toWeightMultiplierFromTarget,
} from '@/lib/weight-sliders';
import {
  SEARCH_DEFINITION_COPY,
  type RateLimitMeta,
} from '@/lib/plan-copy';
import { useScreenshotMode } from '@/context/ScreenshotModeContext';

// AFL Teams List
const AFL_TEAMS = [
  'Adelaide Crows',
  'Brisbane Lions',
  'Carlton Blues',
  'Collingwood Magpies',
  'Essendon Bombers',
  'Fremantle Dockers',
  'Geelong Cats',
  'Gold Coast Suns',
  'Greater Western Sydney Giants',
  'Hawthorn Hawks',
  'Melbourne Demons',
  'North Melbourne Kangaroos',
  'Port Adelaide Power',
  'Richmond Tigers',
  'St Kilda Saints',
  'Sydney Swans',
  'West Coast Eagles',
  'Western Bulldogs'
];

const PENDING_SEARCH_KEY = 'statchecker:pending-search';

// AFL Venues/Stadiums
const AFL_VENUES = [
  'Melbourne Cricket Ground',
  'Marvel Stadium',
  'Adelaide Oval',
  'Optus Stadium',
  'Gabba',
  'SCG',
  'GMHBA Stadium',
  'Metricon Stadium',
  'University of Tasmania Stadium',
  'Mars Stadium',
  'Blundstone Arena',
  'TIO Stadium',
  'People First Stadium',
  'Engie Stadium'
];

const CURRENT_SEASON = '2026';
const BASE_SEASON_OPTIONS = [
  '2026',
  '2025',
  '2024',
  '2023',
  '2022',
  '2021',
  '2020',
  '2019',
  '2018',
  '2017',
];
const SEASON_OPTIONS = [
  'any',
  CURRENT_SEASON,
  ...BASE_SEASON_OPTIONS.filter((season) => season !== CURRENT_SEASON),
];

type BetMode = 'over_under' | 'win_loss';

type GoalLineOption = {
  label: string;
  threshold: string;
  description: string;
};

type QuickSearchOption = {
  label: string;
  stat: StatType;
  threshold: string;
  betMode: BetMode;
  description: string;
};

type NextGameInfo = {
  team: string;
  opponent: string;
  venue: string;
  location: 'home' | 'away';
  fixture: Fixture;
};

type NextGameResults = {
  opponent?: OverUnderResponse;
  location?: OverUnderResponse;
  venue?: OverUnderResponse;
};

type RateLimitInfo = {
  reason?: string;
  bucket: 'sgm' | 'single';
  limit?: number;
  remaining?: number;
  resetAt?: number;
};

type ResultsFormat = 'text' | 'graphs' | 'both';

const formatResetTime = (resetAt?: number) => {
  if (!resetAt) {
    return '11:59 PM Sunday';
  }
  const displayDate = new Date(resetAt - 60_000);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(displayDate);
};

const GOAL_HALF_LINES: GoalLineOption[] = Array.from({ length: 120 }, (_, idx) => {
  const value = (idx + 1) * 0.5;
  const label = value.toFixed(1);
  return {
    label,
    threshold: label,
    description: `Over/Under ${label} goals`,
  };
});

const GOAL_LINE_GROUPS = [
  {
    label: 'Half-line markets',
    options: GOAL_HALF_LINES,
  },
];

const DEFAULT_GOAL_LINE = GOAL_HALF_LINES[0];
const DEFAULT_DISPOSAL_LINE = '23.5';
const LAST_SEASON_YEAR = 2025; // 2025 is correct — it's the *previous* completed season
const LAST_30_DAYS = 30;

const normalizeThresholdValue = (value: number) => Math.round(value * 2) / 2;

const buildQuickSearchKey = (option: { stat: StatType; threshold: string; betMode: BetMode }) =>
  `${option.stat}-${option.threshold}-${option.betMode}`;

const formatHalfLineLabel = (value: string) => {
  if (!value) {
    return '--';
  }
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return value;
  }
  return Number.isInteger(num) ? num.toString() : num.toFixed(1);
};

const QUICK_GOAL_SEARCH: QuickSearchOption[] = [1, 2, 3, 4, 5, 6].map((count) => ({
  label: `${count}+`,
  stat: 'goals',
  threshold: (count - 0.5).toFixed(1),
  betMode: 'win_loss',
  description: `Win market • ${count}+ goals`,
}));

const QUICK_DISPOSAL_VALUES = [15, 20, 25, 30, 35, 40];
const QUICK_DISPOSAL_SEARCH: QuickSearchOption[] = QUICK_DISPOSAL_VALUES.map((value) => ({
  label: `${value}+`,
  stat: 'disposals',
  threshold: (value - 0.5).toFixed(1),
  betMode: 'win_loss',
  description: `Win market • ${value}+ disposals`,
}));

const QUICK_TACKLE_SEARCH: QuickSearchOption[] = [2, 3, 4, 5, 6, 7].map((value) => ({
  label: `${value}+`,
  stat: 'tackles',
  threshold: (value - 0.5).toFixed(1),
  betMode: 'win_loss',
  description: `Win market • ${value}+ tackles`,
}));

const QUICK_MARK_SEARCH: QuickSearchOption[] = [2, 3, 4, 5, 6, 7].map((value) => ({
  label: `${value}+`,
  stat: 'marks',
  threshold: (value - 0.5).toFixed(1),
  betMode: 'win_loss',
  description: `Win market • ${value}+ marks`,
}));

export const PlayerStatsDemo = forwardRef<PlayerStatsDemoRef>(function PlayerStatsDemo(_, ref) {
  const { screenshotMode } = useScreenshotMode();
  const [playerName, setPlayerName] = useState('');
  const [playerSelectedFromGame, setPlayerSelectedFromGame] = useState(false);
  const [stat, setStat] = useState<StatType>('disposals');
  const [threshold, setThreshold] = useState(DEFAULT_DISPOSAL_LINE);
  const [seasonFrom, setSeasonFrom] = useState<string>('2025');
  const [seasonTo, setSeasonTo] = useState<string>(CURRENT_SEASON);
  const [seasonOptions, setSeasonOptions] = useState<string[]>(SEASON_OPTIONS);
  const [opposition, setOpposition] = useState('');
  const [location, setLocation] = useState<'any' | 'home' | 'away'>('any');
  const [venue, setVenue] = useState<string>('any');
  const [gameType, setGameType] = useState<'regular' | 'finals' | 'all'>('regular');
  const [daysRestBucket, setDaysRestBucket] = useState<'any' | '5' | '6' | '7' | '8' | '9' | '10to14' | '15plus'>('any');
  const [disposalLine, setDisposalLine] = useState(DEFAULT_DISPOSAL_LINE);
  const [goalLineSelection, setGoalLineSelection] = useState<GoalLineOption>(
    DEFAULT_GOAL_LINE
  );
  const [goalLineOpen, setGoalLineOpen] = useState(false);
  const [betMode, setBetMode] = useState<BetMode>('over_under');
  const [quickSearchLabel, setQuickSearchLabel] = useState<string | null>(null);
  const [activeQuickSearchKey, setActiveQuickSearchKey] = useState<string | null>(null);
  const [nextGamePreloaded, setNextGamePreloaded] = useState(true);
  const [stats, setStats] = useState<OverUnderResponse | null>(null);
  const [submittedSearch, setSubmittedSearch] = useState<{ params: OverUnderParams; receipt?: string; expiresAt?: number } | null>(null);
  const searchGeneration = useRef(0);
  const contextOptions = useMemo(() => ({ purpose: 'context' as const, receipt: submittedSearch?.receipt, receiptExpiresAt: submittedSearch?.expiresAt }), [submittedSearch]);
  const [manualLoading, setManualLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);
  const [usageInfo, setUsageInfo] = useState<(RateLimitMeta & { reason?: string }) | null>(null);
  const [isSavingSearch, setIsSavingSearch] = useState(false);
  const [multiLegCount, setMultiLegCount] = useState(0);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [isFormExpanded, setIsFormExpanded] = useState(false);
  const [pickMode, setPickMode] = useState<'top' | 'saved'>('top');
  const [savedPicks, setSavedPicks] = useState<SavedPlayer[]>([]);
  const [oppositionOpen, setOppositionOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [nextGameInfo, setNextGameInfo] = useState<NextGameInfo | null>(null);
  const [nextFinalFixture, setNextFinalFixture] = useState<Fixture | null>(null);
  const fixtureGeneration = useRef(0);
  const [nextGameLoading, setNextGameLoading] = useState(false);
  const [nextGameError, setNextGameError] = useState<string | null>(null);
  const [nextGameResults, setNextGameResults] = useState<NextGameResults | null>(null);
  const [nextGameResultsLoading, setNextGameResultsLoading] = useState(false);
  const [nextGameResultsError, setNextGameResultsError] = useState<string | null>(null);
  const [lastSeasonStats, setLastSeasonStats] = useState<OverUnderResponse | null>(null);
  const [lastSeasonLoading, setLastSeasonLoading] = useState(false);
  const [lastSeasonError, setLastSeasonError] = useState<string | null>(null);
  const [last30DaysStats, setLast30DaysStats] = useState<OverUnderResponse | null>(null);
  const [last30DaysLoading, setLast30DaysLoading] = useState(false);
  const [last30DaysError, setLast30DaysError] = useState<string | null>(null);
  const [thisSeasonStats, setThisSeasonStats] = useState<OverUnderResponse | null>(null);
  const [thisSeasonLoading, setThisSeasonLoading] = useState(false);
  const [thisSeasonError, setThisSeasonError] = useState<string | null>(null);
  const [daysRestStats, setDaysRestStats] = useState<OverUnderResponse | null>(null);
  const [daysRestLoading, setDaysRestLoading] = useState(false);
  const [daysRestError, setDaysRestError] = useState<string | null>(null);
  // Career-view toggle: when enabled, non-time-based cards (Base, Home/Away,
  // Venue, Opponent, Days Rest) display career-wide numbers instead of the
  // selected season range. The weighted algorithm ALWAYS uses season-filtered
  // data — this toggle is display-only, for context.
  const [careerViewEnabled, setCareerViewEnabled] = useState(false);
  const [careerBaseStats, setCareerBaseStats] = useState<OverUnderResponse | null>(null);
  const [careerOpponentStats, setCareerOpponentStats] = useState<OverUnderResponse | null>(null);
  const [careerLocationStats, setCareerLocationStats] = useState<OverUnderResponse | null>(null);
  const [careerVenueStats, setCareerVenueStats] = useState<OverUnderResponse | null>(null);
  const [careerDaysRestStats, setCareerDaysRestStats] = useState<OverUnderResponse | null>(null);
  const [careerLoading, setCareerLoading] = useState(false);
  const [weightBase, setWeightBase] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightOpponent, setWeightOpponent] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightLocation, setWeightLocation] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightVenue, setWeightVenue] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightLastSeason, setWeightLastSeason] = useState(DEFAULT_LAST_SEASON_MULTIPLIER);
  const [weightLast30Days, setWeightLast30Days] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightThisSeason, setWeightThisSeason] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightDaysRest, setWeightDaysRest] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [savedWeights, setSavedWeights] = useState<SavedWeight[]>([]);
  const [weightsPresetName, setWeightsPresetName] = useState('');
  const [isSavingWeights, setIsSavingWeights] = useState(false);
  const [resultsFormat, setResultsFormat] = useState<ResultsFormat>('graphs');
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [weightedInfoOpen, setWeightedInfoOpen] = useState(false);
  const weightedInfoCloseTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Autocomplete state
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<PlayerSuggestion[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [selectedPlayerTeam, setSelectedPlayerTeam] = useState<string | null>(null);
  const [showingTopPicks, setShowingTopPicks] = useState(false);
  const [topPickSuggestions, setTopPickSuggestions] = useState<PlayerSuggestion[]>([]);
  const autocompleteDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const playerInputRef = useRef<HTMLInputElement>(null);
  const autoAppliedRef = useRef(false);
  const autocompleteCacheRef = useRef<Map<string, PlayerSuggestion[]>>(new Map());
  const latestAutocompleteQueryRef = useRef<string>('');

  const TOP_PLAYER_NAMES_2025 = FEATURED_PLAYER_NAMES;

  const fallbackTopPicks = useMemo<PlayerSuggestion[]>(
    () =>
      TOP_PLAYER_NAMES_2025.map((playerName, index) => ({
        player_id: -(index + 1),
        player_name: playerName,
        games_played: 0,
        games_2025: 0,
        avg_disposals_2025: 0,
      })),
    [TOP_PLAYER_NAMES_2025]
  );

  useEffect(() => {
    fetchSavedPlayers()
      .then((items) => setSavedPicks(items))
      .catch(() => setSavedPicks([]));
  }, []);

  useEffect(() => {
    fetchSavedWeights()
      .then((items) => setSavedWeights(items))
      .catch(() => setSavedWeights([]));
  }, []);

  const savedPickSuggestions = useMemo<PlayerSuggestion[]>(
    () =>
      savedPicks.map((player, index) => ({
        player_id: player.player_id ?? -(index + 1),
        player_name: player.player_name,
        games_played: 0,
        games_2025: 0,
        avg_disposals_2025: 0,
        team_id: player.team_id ?? undefined,
        team_name: player.team_name ?? undefined,
      })),
    [savedPicks]
  );

  const parsedSeasonFrom = seasonFrom === 'any' ? undefined : Number(seasonFrom);
  const parsedSeasonTo = seasonTo === 'any' ? undefined : Number(seasonTo);
  const todayDate = useMemo(() => new Date().toISOString().split('T')[0], []);
  const locationFilter = location === 'any' ? undefined : location;
  const opponentFilter = opposition.trim() || undefined;
  const venueFilter = venue === 'any' ? undefined : venue;
  const gameTypeFilter = nextGameType(gameType, nextFinalFixture, nextGamePreloaded);
  const nextFinalIncludesAll = nextGamePreloaded && isUpcomingFinalFixture(nextFinalFixture);
  const daysRestFilter = useMemo(() => {
    switch (daysRestBucket) {
      case '5':
        return { min: 5, max: 5 };
      case '6':
        return { min: 6, max: 6 };
      case '7':
        return { min: 7, max: 7 };
      case '8':
        return { min: 8, max: 8 };
      case '9':
        return { min: 9, max: 9 };
      case '10to14':
        return { min: 10, max: 14 };
      case '15plus':
        // Cap at 30 so offseason gaps (~150+ days) don't pollute the bucket.
        return { min: 15, max: 30 };
      default:
        return undefined;
    }
  }, [daysRestBucket]);

  const daysRestLabel = useMemo(() => {
    switch (daysRestBucket) {
      case '5': return '5 days rest';
      case '6': return '6 days rest';
      case '7': return '7 days rest';
      case '8': return '8 days rest';
      case '9': return '9 days rest';
      case '10to14': return '10–14 days rest';
      case '15plus': return '15+ days rest';
      default: return '';
    }
  }, [daysRestBucket]);

  useEffect(() => {
    let isMounted = true;
    const loadFeatured = async () => {
      try {
        const response = await getFeaturedPlayers(TOP_PLAYER_NAMES_2025, 2026);
        if (isMounted && response.suggestions.length > 0) {
          setTopPickSuggestions(response.suggestions);
        }
      } catch {
        if (isMounted) {
          setTopPickSuggestions(fallbackTopPicks);
        }
      }
    };

    loadFeatured();
    return () => {
      isMounted = false;
    };
  }, [TOP_PLAYER_NAMES_2025, fallbackTopPicks]);

  const findNextFixtureForTeam = useCallback((fixtures: Fixture[], teamName: string) => {
    const normalizedTeam = teamName.trim().toLowerCase();
    return fixtures.find((fixture) => isSelectableFixture(fixture) && (
      fixture.home_team_name.toLowerCase() === normalizedTeam ||
      fixture.away_team_name.toLowerCase() === normalizedTeam
    ));
  }, []);

  const loadNextGameForPlayer = useCallback(
    async (name: string, apiTeamName?: string) => {
      const generation = ++fixtureGeneration.current;
      if (!nextGamePreloaded) {
        return;
      }
      const teamName = getPlayerTeam2025(name) ?? apiTeamName ?? null;
      if (!teamName) {
        setNextGameInfo(null);
        setNextFinalFixture(null);
        setNextGameError('Team mapping pending for this player (2026 list).');
        setNextGameLoading(false);
        return;
      }
      setNextGameLoading(true);
      setNextGameError(null);
      setNextGameInfo(null);
      setNextFinalFixture(null);
      try {
        const response = await getUpcomingFixtures(50);
        if (generation !== fixtureGeneration.current) return;
        const phaseFixture = response.fixtures.find((f) =>
          f.home_team_name.toLowerCase() === teamName.trim().toLowerCase() ||
          f.away_team_name.toLowerCase() === teamName.trim().toLowerCase());
        setNextFinalFixture(phaseFixture ?? null);
        const fixture = findNextFixtureForTeam(response.fixtures, teamName);
        if (!fixture) {
          setNextGameError(isUpcomingFinalFixture(phaseFixture) ? 'Final confirmed; opponent or match time is still TBC.' : 'No upcoming fixtures found for this team.');
          return;
        }
        const isHome = fixture.home_team_name === teamName;
        setNextGameInfo({
          team: teamName,
          opponent: isHome ? fixture.away_team_name : fixture.home_team_name,
          venue: fixture.venue_name,
          location: isHome ? 'home' : 'away',
          fixture,
        });
      } catch (err) {
        if (generation !== fixtureGeneration.current) return;
        setNextGameError(err instanceof Error ? err.message : 'Unable to load next game.');
      } finally {
        if (generation === fixtureGeneration.current) setNextGameLoading(false);
      }
    },
    [findNextFixtureForTeam, nextGamePreloaded]
  );

  const clearNextGameState = useCallback(() => {
    fixtureGeneration.current += 1;
    setNextGameInfo(null);
    setNextFinalFixture(null);
    setNextGameError(null);
    setNextGameLoading(false);
    setNextGameResults(null);
    setNextGameResultsError(null);
    setNextGameResultsLoading(false);
  }, []);

  // Expose setPlayerAndPrepare method via ref
  useImperativeHandle(
    ref,
    () => ({
      setPlayerAndPrepare: (name: string, _options) => {
        // Set the player name
        setPlayerName(name);
        setPlayerSelectedFromGame(true);
        setSelectedPlayerId(-1);
        setSelectedPlayerTeam(null);
        setAutocompleteOpen(false);
        setSuggestions([]);
        setShowingTopPicks(false);
        clearNextGameState();

        // Reset all filters to defaults (same as New Search)
        setStat('disposals');
        setThreshold(DEFAULT_DISPOSAL_LINE);
        setDisposalLine(DEFAULT_DISPOSAL_LINE);
        setGoalLineSelection(DEFAULT_GOAL_LINE);
        setGoalLineOpen(false);
        setBetMode('over_under');
        setSeasonFrom('2025');
        setSeasonTo(CURRENT_SEASON);
        setSeasonOptions(SEASON_OPTIONS);
        setOpposition('');
        setOppositionOpen(false);
        setVenue('any');
        setLocation('any');
        setGameType('regular');
        setDaysRestBucket('any');
        setActiveQuickSearchKey(null);
        setQuickSearchLabel(null);

        // Reset any existing results and prepare form for quick search
        setHasSubmitted(false);
        setStats(null);
        setSubmittedSearch(null);
        searchGeneration.current += 1;
        setError(null);
        setIsFormExpanded(false); // Collapse form, ready to show Quick Search

        if (nextGamePreloaded) {
          void loadNextGameForPlayer(name);
        }

        // Close any lingering autocomplete dropdown
        setTimeout(() => playerInputRef.current?.blur(), 50);

      },
    }),
    [clearNextGameState, loadNextGameForPlayer, nextGamePreloaded]
  );

  useEffect(() => {
    if (stat !== 'goals') {
      setGoalLineOpen(false);
      setGoalLineSelection((prev) => prev || DEFAULT_GOAL_LINE);
    }
  }, [stat]);

  const resetResults = useCallback(() => {
    setHasSubmitted(false);
    setStats(null);
    setSubmittedSearch(null);
    searchGeneration.current += 1;
    setError(null);
    setManualLoading(false);
    setLastSeasonStats(null);
    setLastSeasonError(null);
    setLastSeasonLoading(false);
    setLast30DaysStats(null);
    setLast30DaysError(null);
    setLast30DaysLoading(false);
    setDaysRestStats(null);
    setDaysRestError(null);
    setDaysRestLoading(false);
  }, []);

  const applyTopPickSuggestions = useCallback(
    (query?: string) => {
      const normalizedQuery = query?.trim().toLowerCase();
      const topSource = topPickSuggestions.length > 0 ? topPickSuggestions : fallbackTopPicks;
      const source = pickMode === 'saved' ? savedPickSuggestions : topSource;
      const filtered = normalizedQuery
        ? source.filter((player) =>
            player.player_name.toLowerCase().includes(normalizedQuery)
          )
        : source;

      setSuggestions(filtered);
      setAutocompleteOpen(filtered.length > 0);
      setShowingTopPicks(true);
    },
    [topPickSuggestions, fallbackTopPicks, pickMode, savedPickSuggestions]
  );

  useEffect(() => {
    if (playerName.trim().length === 0 && selectedPlayerId === null) {
      applyTopPickSuggestions();
    }
  }, [applyTopPickSuggestions, pickMode, savedPickSuggestions, playerName, selectedPlayerId]);

  // Autocomplete: fetch suggestions when player name changes
  useEffect(() => {
    // Clear any pending debounce
    if (autocompleteDebounceRef.current) {
      clearTimeout(autocompleteDebounceRef.current);
    }
    
    const trimmedName = playerName.trim();
    
    // Don't search if too short or if player was just selected
    if (trimmedName.length < 2 || selectedPlayerId !== null) {
      if (trimmedName.length === 0 && selectedPlayerId === null) {
        applyTopPickSuggestions();
      } else {
        setSuggestions([]);
        setAutocompleteOpen(false);
        setShowingTopPicks(false);
      }
      return;
    }

    const normalizedQuery = trimmedName.toLowerCase();
    const cachedResults = autocompleteCacheRef.current.get(normalizedQuery);
    if (cachedResults) {
      setSuggestions(cachedResults);
      setAutocompleteOpen(cachedResults.length > 0);
      setShowingTopPicks(false);
      return;
    }

    let bestPrefixKey = '';
    for (const key of autocompleteCacheRef.current.keys()) {
      if (normalizedQuery.startsWith(key) && key.length > bestPrefixKey.length) {
        bestPrefixKey = key;
      }
    }
    if (bestPrefixKey) {
      const prefixResults = autocompleteCacheRef.current.get(bestPrefixKey) || [];
      const filtered = prefixResults.filter((player) =>
        player.player_name.toLowerCase().includes(normalizedQuery)
      );
      if (filtered.length > 0) {
        setSuggestions(filtered);
        setAutocompleteOpen(true);
        setShowingTopPicks(false);
      }
    }

    // Show top picks that match immediately while waiting for network
    applyTopPickSuggestions(trimmedName);
    latestAutocompleteQueryRef.current = normalizedQuery;
    
    // Debounce the autocomplete request (75ms)
    autocompleteDebounceRef.current = setTimeout(async () => {
      setIsLoadingSuggestions(true);
      try {
        const response = await getPlayerAutocomplete(trimmedName, 8);
        if (latestAutocompleteQueryRef.current !== normalizedQuery) {
          return;
        }
        autocompleteCacheRef.current.set(normalizedQuery, response.suggestions);
        setSuggestions(response.suggestions);
        setAutocompleteOpen(response.suggestions.length > 0);
        setShowingTopPicks(false);
      } catch {
        setSuggestions([]);
        setShowingTopPicks(false);
      } finally {
        setIsLoadingSuggestions(false);
      }
    }, 75);
    
    return () => {
      if (autocompleteDebounceRef.current) {
        clearTimeout(autocompleteDebounceRef.current);
      }
    };
  }, [playerName, selectedPlayerId, applyTopPickSuggestions]);

  // Handle selecting a player from autocomplete
  const handleSelectPlayer = useCallback((suggestion: PlayerSuggestion) => {
    setPlayerName(suggestion.player_name);
    const playerId = suggestion.player_id > 0 ? suggestion.player_id : undefined;
    setSelectedPlayerId(playerId ?? -1);
    setSelectedPlayerTeam(suggestion.team_name ?? null);
    setAutocompleteOpen(false);
    setSuggestions([]);
    setShowingTopPicks(false);
    setActiveQuickSearchKey(null);
    resetResults();
    clearNextGameState();
    
    if (nextGamePreloaded) {
      void loadNextGameForPlayer(suggestion.player_name, suggestion.team_name ?? undefined);
    }

    // Focus back on input briefly then blur to close keyboard on mobile
    playerInputRef.current?.focus();
    setTimeout(() => playerInputRef.current?.blur(), 50);
  }, [clearNextGameState, loadNextGameForPlayer, nextGamePreloaded, resetResults]);

  const handleNextGameToggle = useCallback(
    (nextValue: boolean) => {
      setNextGamePreloaded(nextValue);
      if (!nextValue) {
        clearNextGameState();
      } else if (playerName.trim()) {
        void loadNextGameForPlayer(playerName, selectedPlayerTeam ?? undefined);
      }
    },
    [clearNextGameState, loadNextGameForPlayer, playerName, selectedPlayerTeam]
  );

  // Clear selected player ID when user starts typing again
  const handlePlayerInputChange = useCallback((value: string) => {
    setPlayerName(value);
    setSelectedPlayerId(null); // Allow autocomplete to show again
    setSelectedPlayerTeam(null);
    setPlayerSelectedFromGame(false);
    setActiveQuickSearchKey(null);
    resetResults();
    clearNextGameState();
  }, [clearNextGameState, resetResults]);

  const applyThreshold = (value: string) => {
    const numValue = parseFloat(value);
    if (!Number.isNaN(numValue) && numValue > 0) {
      const rounded = Math.round(numValue * 2) / 2;
      const formatted = Number.isInteger(rounded) ? rounded.toFixed(1) : rounded.toFixed(1);
      setThreshold(formatted);
      return formatted;
    }
    setThreshold(value);
    return value;
  };

  const filterConfig = useMemo(
    () => ({
      season_from: parsedSeasonFrom,
      season_to: parsedSeasonTo,
      location: locationFilter,
      opponent: opponentFilter,
      venue: venueFilter,
      game_type: gameTypeFilter,
    }),
    [parsedSeasonFrom, parsedSeasonTo, locationFilter, opponentFilter, venueFilter, gameTypeFilter]
  );

  const buildOverUnderParams = useCallback(
    (
      statValue: StatType,
      thresholdInput: string | number,
      playerNameOverride?: string,
      contextOverride?: { opponent?: string; venue?: string; location?: 'home' | 'away' }
    ): OverUnderParams | null => {
      const trimmedName = (playerNameOverride ?? playerName).trim();
      if (!trimmedName) {
        return null;
      }
      const numericThreshold =
        typeof thresholdInput === 'number' ? thresholdInput : parseFloat(thresholdInput);
      if (!Number.isFinite(numericThreshold) || numericThreshold <= 0) {
        return null;
      }
      const normalizedThreshold = normalizeThresholdValue(numericThreshold);
      const params: OverUnderParams = {
        player_name: trimmedName,
        stat: statValue,
        threshold: normalizedThreshold,
      };
      if (filterConfig.season_from !== undefined) {
        params.season_from = filterConfig.season_from;
      }
      if (filterConfig.season_to !== undefined) {
        params.season_to = filterConfig.season_to;
      }
      if (contextOverride?.location) {
        params.location = contextOverride.location;
      } else if (filterConfig.location) {
        params.location = filterConfig.location;
      }
      if (contextOverride?.opponent) {
        params.opponent = contextOverride.opponent;
      } else if (filterConfig.opponent) {
        params.opponent = filterConfig.opponent;
      }
      if (contextOverride?.venue) {
        params.venue = contextOverride.venue;
      } else if (filterConfig.venue) {
        params.venue = filterConfig.venue;
      }
      if (filterConfig.game_type) {
        params.game_type = filterConfig.game_type;
      }
      return params;
    },
    [playerName, filterConfig]
  );

  const stripContextFilters = useCallback((params: OverUnderParams): OverUnderParams => {
    const { opponent: _opponent, venue: _venue, location: _location, ...rest } = params;
    return rest;
  }, []);

  const stripSeasonFilters = useCallback((params: OverUnderParams): OverUnderParams => {
    const { season_from: _seasonFrom, season_to: _seasonTo, date_from: _dateFrom, date_to: _dateTo, ...rest } = params;
    return rest;
  }, []);

  const requestParams = useMemo(
    () => buildOverUnderParams(stat, threshold),
    [buildOverUnderParams, stat, threshold]
  );

  const displayedResearch = useRef<{ tracker: ReturnType<typeof startResearch>; result: OverUnderResponse; cached: boolean } | null>(null);
  useEffect(() => {
    const pending = displayedResearch.current;
    if (pending && stats === pending.result) {
      pending.tracker.viewed(stats.over + stats.under, pending.cached);
      displayedResearch.current = null;
    }
  }, [stats]);

  const [loadStats] = useState(() => createPlayerStatsLoader());

  const performSearch = useCallback(
    async (params: OverUnderParams) => {
      const normalizedThreshold = params.threshold;
      const thresholdLabel = normalizedThreshold.toFixed(1);
      setThreshold(thresholdLabel);
      if (params.stat === 'disposals') {
        setDisposalLine(thresholdLabel);
      }
      setIsFormExpanded(false);
      setHasSubmitted(true);
      setError(null);
      setRateLimitInfo(null);
      setUsageInfo(null);
      setStats(null);
      setSubmittedSearch(null);
      searchGeneration.current += 1;

      const generation = searchGeneration.current;
      const submittedParams = { ...params };

      const research = startResearch('single');

      const { promise, fromCache } = loadStats(params, {
        analyticsHeaders: research.headers,
        onRateLimit: (info) => { if (generation === searchGeneration.current) setUsageInfo(info); },
      });
      if (!fromCache) {
        setManualLoading(true);
      }
      try {
        const result = await promise;
        if (generation !== searchGeneration.current) return;
        displayedResearch.current = { tracker: research, result, cached: fromCache };
        setStats(result);
        setSubmittedSearch({ params: submittedParams, receipt: result.game_log_receipt, expiresAt: result.game_log_receipt_expires_at });
      } catch (err) {
        if (generation !== searchGeneration.current) return;
        research.failed(err instanceof ApiClientError ? err.statusCode : undefined);
        setHasSubmitted(false);
        setIsFormExpanded(true);
        if (err instanceof ApiClientError && err.statusCode === 429) {
          setRateLimitInfo({
            bucket: 'single',
            limit: err.response?.rateLimit?.limit,
            remaining: err.response?.rateLimit?.remaining,
            resetAt: err.response?.rateLimit?.resetAt,
            reason: err.response?.rateLimit?.reason,
          });
        } else if (err instanceof ApiClientError) {
          setError(err.message);
        } else {
          setError(err instanceof Error ? err.message : 'An unexpected error occurred');
        }
      } finally {
        if (generation === searchGeneration.current && !fromCache) {
          setManualLoading(false);
        }
      }
    },
    [loadStats]
  );

  useEffect(() => {
    if (autoAppliedRef.current) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    const raw = window.localStorage.getItem(PENDING_SEARCH_KEY);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.type !== 'single') {
        return;
      }
      const payload = parsed.payload ?? {};
      const player = String(payload.player_name ?? '').trim();
      const statValue = (payload.stat as StatType) ?? 'disposals';
      const thresholdValue = Number(payload.threshold ?? 0);
      const betModeValue = payload.bet_mode === 'win_loss' ? 'win_loss' : 'over_under';
      if (!player || !Number.isFinite(thresholdValue) || thresholdValue <= 0) {
        return;
      }
      autoAppliedRef.current = true;
      window.localStorage.removeItem(PENDING_SEARCH_KEY);
      setPlayerName(player);
      setPlayerSelectedFromGame(false);
      setSelectedPlayerId(null);
      setStat(statValue);
      setBetMode(betModeValue);
      if (statValue === 'goals') {
        const matchingHalf =
          GOAL_HALF_LINES.find((line) => line.threshold === thresholdValue.toFixed(1)) ??
          DEFAULT_GOAL_LINE;
        setGoalLineSelection(matchingHalf);
        setGoalLineOpen(false);
      } else {
        setGoalLineSelection((prev) => prev || DEFAULT_GOAL_LINE);
        setDisposalLine(thresholdValue.toFixed(1));
      }
      setThreshold(thresholdValue.toFixed(1));
      setQuickSearchLabel(payload.quick_label ?? null);
      setIsFormExpanded(false);
      setTimeout(() => {
        const params = buildOverUnderParams(statValue, thresholdValue, player);
        if (params) {
          void performSearch(params);
        }
      }, 50);
    } catch {
      // Ignore malformed payloads
    }
  }, [buildOverUnderParams, performSearch]);

  const handleSaveSearch = async () => {
    if (!requestParams) {
      return;
    }
    setIsSavingSearch(true);
    try {
      await saveSearch({
        type: 'single',
        payload: {
          ...requestParams,
          bet_mode: isWinLossMode ? 'win_loss' : 'over_under',
          quick_label: quickSearchLabel ?? null,
        },
      });
    } finally {
      setIsSavingSearch(false);
    }
  };

  const handleQuickSearch = useCallback(
    (option: QuickSearchOption) => {
      if (nextGamePreloaded && nextGameLoading) {
        setError('Checking the next fixture. Please try again in a moment.');
        return;
      }
      const params = buildOverUnderParams(option.stat, option.threshold);
      if (!params) {
        setIsFormExpanded(true);
        setError('Enter a player name to run a quick search.');
        return;
      }


      setStat(option.stat);
      setBetMode(option.betMode);
      setQuickSearchLabel(option.label);
      setActiveQuickSearchKey(buildQuickSearchKey(option));

      if (option.stat === 'goals') {
        const matchingHalf =
          GOAL_HALF_LINES.find((line) => line.threshold === option.threshold) ?? DEFAULT_GOAL_LINE;
        setGoalLineSelection(matchingHalf);
        setGoalLineOpen(false);
      } else {
        setGoalLineSelection((prev) => prev || DEFAULT_GOAL_LINE);
        setDisposalLine(option.threshold);
      }

      setThreshold(option.threshold);
      resetResults();
      setIsFormExpanded(false);
      void performSearch(params);
    },
    [buildOverUnderParams, performSearch, resetResults, nextGamePreloaded, nextGameLoading]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nextGamePreloaded && nextGameLoading) return;
    if (!requestParams) {
      return;
    }
    await performSearch(requestParams);
  };

  const handleNewSearch = () => {
    fixtureGeneration.current += 1;
    setNextGameLoading(false);
    setPlayerName('');
    setSelectedPlayerId(null);
    setPlayerSelectedFromGame(false);
    setStat('disposals');
    setThreshold(DEFAULT_DISPOSAL_LINE);
    setDisposalLine(DEFAULT_DISPOSAL_LINE);
    setGoalLineSelection(DEFAULT_GOAL_LINE);
    setGoalLineOpen(false);
    setBetMode('over_under');
    setSeasonFrom('2025');
    setSeasonTo(CURRENT_SEASON);
    setSeasonOptions(SEASON_OPTIONS);
    setOpposition('');
    setOppositionOpen(false);
    setLocation('any');
    setVenue('any');
    setGameType('regular');
    setDaysRestBucket('any');
    setActiveQuickSearchKey(null);
    setQuickSearchLabel(null);
    setNextGamePreloaded(true);
    setNextGameInfo(null);
    setNextFinalFixture(null);
    setNextGameError(null);
    setNextGameResults(null);
    setNextGameResultsLoading(false);
    setNextGameResultsError(null);
    setStats(null);
    setSubmittedSearch(null);
    searchGeneration.current += 1;
    setError(null);
    setManualLoading(false);
    setHasSubmitted(false);
    setLastSeasonStats(null);
    setLastSeasonLoading(false);
    setLastSeasonError(null);
    setLast30DaysStats(null);
    setLast30DaysLoading(false);
    setLast30DaysError(null);
    setDaysRestStats(null);
    setDaysRestLoading(false);
    setDaysRestError(null);
    setWeightBase(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightOpponent(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightLocation(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightVenue(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightLastSeason(DEFAULT_LAST_SEASON_MULTIPLIER);
    setWeightLast30Days(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightDaysRest(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightsOpen(false);
    setWeightedInfoOpen(false);
    setResultsFormat('graphs');
    setMoreFiltersOpen(false);
    setPickMode('top');
    setIsFormExpanded(true);
    applyTopPickSuggestions();
  };

  const handleAdjustSearch = () => {
    setIsFormExpanded(true);
    setActiveQuickSearchKey(null);
    setTimeout(() => playerInputRef.current?.focus(), 50);
  };

  const openWeightedInfo = () => {
    if (weightedInfoCloseTimeout.current) {
      clearTimeout(weightedInfoCloseTimeout.current);
      weightedInfoCloseTimeout.current = null;
    }
    setWeightedInfoOpen(true);
  };

  const toggleWeightsOpen = () => {
    setWeightsOpen((prev) => !prev);
  };

  const scheduleWeightedInfoClose = () => {
    if (weightedInfoCloseTimeout.current) {
      clearTimeout(weightedInfoCloseTimeout.current);
    }
    weightedInfoCloseTimeout.current = setTimeout(() => {
      setWeightedInfoOpen(false);
      weightedInfoCloseTimeout.current = null;
    }, 150);
  };

  const loading = manualLoading;
  const hasResults = Boolean(stats && hasSubmitted && !loading);
  const showResults = hasSubmitted;

  useEffect(() => {
    return () => {
      if (weightedInfoCloseTimeout.current) {
        clearTimeout(weightedInfoCloseTimeout.current);
        weightedInfoCloseTimeout.current = null;
      }
    };
  }, []);
  const statLabel = stat === 'disposals' ? 'Disposals' : stat === 'goals' ? 'Goals' : stat === 'tackles' ? 'Tackles' : 'Marks';
  const isGoalStat = stat === 'goals';
  const goalLineLabel = isGoalStat && goalLineSelection ? goalLineSelection.label : null;
  const displayLineLabel =
    betMode === 'win_loss' && quickSearchLabel
      ? quickSearchLabel
      : goalLineLabel || formatHalfLineLabel(threshold);
  const isWinLossMode = betMode === 'win_loss';
  const positiveLabel = isWinLossMode ? 'Win' : 'Over';
  const negativeLabel = isWinLossMode ? 'Loss' : 'Under';
  const percentageLabel = isWinLossMode ? 'Hit Rate' : 'Percentage';
  const positiveGamesLabel = isWinLossMode ? 'Wins' : 'Games';
  const negativeGamesLabel = isWinLossMode ? 'Losses' : 'Games';
  const marketLabel = isWinLossMode
    ? `Win/Loss (${displayLineLabel ?? '--'})`
    : `Over/Under (${displayLineLabel ?? '--'})`;
  const positiveAccentClass = isWinLossMode ? 'bg-emerald-700' : 'bg-blue-500';
  const negativeAccentClass = isWinLossMode ? 'bg-red-600' : 'bg-blue-700';
  const positiveBarGradient = isWinLossMode
    ? 'bg-gradient-to-r from-emerald-400 to-green-600'
    : 'bg-gradient-to-r from-blue-400 to-blue-600';
  const negativeBarGradient = isWinLossMode
    ? 'bg-gradient-to-r from-rose-400 to-red-600'
    : 'bg-gradient-to-r from-slate-400 to-slate-600';

  // Use current stats if available, otherwise use previous stats while loading
  const displayStats = stats;
  const totalGames = displayStats ? displayStats.over + displayStats.under : 0;
  const fullResultsSeasonLabel =
    seasonFrom === 'any' && seasonTo === 'any'
      ? 'All seasons'
      : `${seasonFrom === 'any' ? 'Any' : seasonFrom}–${seasonTo === 'any' ? 'Any' : seasonTo}`;
  const fullResultsGamesLabel = `${totalGames} ${totalGames === 1 ? 'game' : 'games'}`;
  const playerTeamLabel = playerName ? (getPlayerTeam2025(playerName) ?? selectedPlayerTeam) : null;
  const playerDisplayName =
    playerName && playerTeamLabel ? `${playerName}, ${playerTeamLabel}` : playerName;
  const overPercentage = totalGames > 0 ? ((displayStats?.over || 0) / totalGames) * 100 : 0;
  const underPercentage = totalGames > 0 ? ((displayStats?.under || 0) / totalGames) * 100 : 0;
  const overBreakEven = overPercentage > 0 ? (100 / overPercentage).toFixed(2) : '0.00';
  const underBreakEven = underPercentage > 0 ? (100 / underPercentage).toFixed(2) : '0.00';
  const baseStats = displayStats;
  const opponentStats = nextGameResults?.opponent ?? null;
  const locationStats = nextGameResults?.location ?? null;
  const venueStats = nextGameResults?.venue ?? null;
  const lastSeasonInRange = useMemo(() => {
    const from = submittedSearch?.params.season_from ?? -Infinity;
    const to = submittedSearch?.params.season_to ?? Infinity;
    return LAST_SEASON_YEAR >= from && LAST_SEASON_YEAR <= to;
  }, [submittedSearch]);

  const last30DaysInRange = useMemo(() => {
    const currentYear = Number(CURRENT_SEASON);
    const from = submittedSearch?.params.season_from ?? -Infinity;
    const to = submittedSearch?.params.season_to ?? Infinity;
    return currentYear >= from && currentYear <= to;
  }, [submittedSearch]);

  const lastSeasonStatsData = lastSeasonInRange ? lastSeasonStats : null;
  const last30DaysStatsData = last30DaysInRange ? last30DaysStats : null;
  const thisSeasonInRange = last30DaysInRange; // both require current season (2026) to be in range
  const thisSeasonStatsData = thisSeasonInRange ? thisSeasonStats : null;
  const daysRestStatsData = daysRestBucket === 'any' ? null : daysRestStats;

  const baseTotal = baseStats ? baseStats.over + baseStats.under : 0;
  const opponentTotal = opponentStats ? opponentStats.over + opponentStats.under : 0;
  const locationTotal = locationStats ? locationStats.over + locationStats.under : 0;
  const venueTotal = venueStats ? venueStats.over + venueStats.under : 0;
  const lastSeasonTotal = lastSeasonStatsData
    ? lastSeasonStatsData.over + lastSeasonStatsData.under
    : 0;
  const last30DaysTotal = last30DaysStatsData
    ? last30DaysStatsData.over + last30DaysStatsData.under
    : 0;
  const thisSeasonTotal = thisSeasonStatsData
    ? thisSeasonStatsData.over + thisSeasonStatsData.under
    : 0;
  const daysRestTotal = daysRestStatsData
    ? daysRestStatsData.over + daysRestStatsData.under
    : 0;
  const maxWeight = MAX_WEIGHT_MULTIPLIER;
  const effectiveWeightBase = computeEffectiveWeight(baseStats ? baseTotal : 0, weightBase);
  const effectiveWeightOpponent = computeEffectiveWeight(opponentStats ? opponentTotal : 0, weightOpponent);
  const effectiveWeightLocation = computeEffectiveWeight(locationStats ? locationTotal : 0, weightLocation);
  const effectiveWeightVenue = computeEffectiveWeight(venueStats ? venueTotal : 0, weightVenue);
  const effectiveWeightLastSeason = computeEffectiveWeight(
    lastSeasonStatsData ? lastSeasonTotal : 0,
    weightLastSeason
  );
  const effectiveWeightLast30Days = computeEffectiveWeight(
    last30DaysStatsData ? last30DaysTotal : 0,
    weightLast30Days
  );
  const effectiveWeightThisSeason = computeEffectiveWeight(
    thisSeasonStatsData ? thisSeasonTotal : 0,
    weightThisSeason
  );
  const effectiveWeightDaysRest = computeEffectiveWeight(
    daysRestStatsData ? daysRestTotal : 0,
    weightDaysRest
  );
  const totalWeightForPercent = useMemo(() => {
    const candidates = [
      effectiveWeightBase,
      effectiveWeightOpponent,
      effectiveWeightLocation,
      effectiveWeightVenue,
      effectiveWeightLastSeason,
      effectiveWeightLast30Days,
      effectiveWeightThisSeason,
      effectiveWeightDaysRest,
    ];
    return candidates.reduce((sum, item) => sum + item, 0);
  }, [
    effectiveWeightBase,
    effectiveWeightOpponent,
    effectiveWeightLocation,
    effectiveWeightVenue,
    effectiveWeightLastSeason,
    effectiveWeightLast30Days,
    effectiveWeightThisSeason,
    effectiveWeightDaysRest,
  ]);

  const buildWeightPercentages = useCallback(() => {
    if (totalWeightForPercent <= 0) {
      return {
        base: 0,
        opponent: 0,
        location: 0,
        venue: 0,
        lastSeason: 0,
        last30Days: 0,
        thisSeason: 0,
        daysRest: 0,
      };
    }
    return {
      base: (effectiveWeightBase / totalWeightForPercent) * 100,
      opponent: (effectiveWeightOpponent / totalWeightForPercent) * 100,
      location: (effectiveWeightLocation / totalWeightForPercent) * 100,
      venue: (effectiveWeightVenue / totalWeightForPercent) * 100,
      lastSeason: (effectiveWeightLastSeason / totalWeightForPercent) * 100,
      last30Days: (effectiveWeightLast30Days / totalWeightForPercent) * 100,
      thisSeason: (effectiveWeightThisSeason / totalWeightForPercent) * 100,
      daysRest: (effectiveWeightDaysRest / totalWeightForPercent) * 100,
    };
  }, [
    totalWeightForPercent,
    effectiveWeightBase,
    effectiveWeightOpponent,
    effectiveWeightLocation,
    effectiveWeightVenue,
    effectiveWeightLastSeason,
    effectiveWeightLast30Days,
    effectiveWeightThisSeason,
    effectiveWeightDaysRest,
  ]);

  const applyWeightPreset = useCallback(
    (preset: SavedWeight) => {
      const counts = {
        base: baseTotal,
        opponent: opponentTotal,
        location: locationTotal,
        venue: venueTotal,
        lastSeason: lastSeasonTotal,
        last30Days: last30DaysTotal,
        thisSeason: thisSeasonTotal,
        daysRest: daysRestTotal,
      };
      const availableKeys = Object.keys(counts).filter((key) => counts[key as keyof typeof counts] > 0);
      const totalAvailable = availableKeys.reduce(
        (sum, key) => sum + counts[key as keyof typeof counts],
        0
      );
      if (totalAvailable === 0) {
        return;
      }
      const totalPreset = availableKeys.reduce(
        (sum, key) => sum + (preset.weights?.[key] ?? 0),
        0
      );
      if (totalPreset <= 0) {
        return;
      }
      const scale = totalAvailable / totalPreset;
      const targetBase = (preset.weights?.base ?? 0) * scale;
      const targetOpponent = (preset.weights?.opponent ?? 0) * scale;
      const targetLocation = (preset.weights?.location ?? 0) * scale;
      const targetVenue = (preset.weights?.venue ?? 0) * scale;
      const targetLastSeason = (preset.weights?.lastSeason ?? 0) * scale;
      const targetLast30Days = (preset.weights?.last30Days ?? 0) * scale;
      const targetThisSeason = (preset.weights?.thisSeason ?? 0) * scale;
      const targetDaysRest = (preset.weights?.daysRest ?? 0) * scale;

      setWeightBase(toWeightMultiplierFromTarget(targetBase, baseTotal));
      setWeightOpponent(
        toWeightMultiplierFromTarget(targetOpponent, opponentTotal)
      );
      setWeightLocation(
        toWeightMultiplierFromTarget(targetLocation, locationTotal)
      );
      setWeightVenue(toWeightMultiplierFromTarget(targetVenue, venueTotal));
      setWeightLastSeason(
        toWeightMultiplierFromTarget(targetLastSeason, lastSeasonTotal)
      );
      setWeightLast30Days(
        toWeightMultiplierFromTarget(targetLast30Days, last30DaysTotal)
      );
      setWeightThisSeason(
        toWeightMultiplierFromTarget(targetThisSeason, thisSeasonTotal)
      );
      setWeightDaysRest(
        toWeightMultiplierFromTarget(targetDaysRest, daysRestTotal)
      );
    },
    [baseTotal, opponentTotal, locationTotal, venueTotal, lastSeasonTotal, last30DaysTotal, thisSeasonTotal, daysRestTotal]
  );

  const handleSaveWeightsPreset = async () => {
    if (!weightsPresetName.trim()) {
      return;
    }
    setIsSavingWeights(true);
    try {
      const saved = await saveWeights({
        name: weightsPresetName.trim(),
        weights: buildWeightPercentages(),
      });
      setSavedWeights((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)]);
      setWeightsPresetName('');
    } finally {
      setIsSavingWeights(false);
    }
  };

  const getOverPct = (stats?: OverUnderResponse | null) => {
    if (!stats) {
      return null;
    }
    const total = stats.over + stats.under;
    if (!total) {
      return null;
    }
    return (stats.over / total) * 100;
  };

  const weightedMetrics = useMemo(() => {
    const candidates = [
      { weight: effectiveWeightBase, overPct: getOverPct(baseStats) },
      { weight: effectiveWeightOpponent, overPct: getOverPct(opponentStats) },
      { weight: effectiveWeightLocation, overPct: getOverPct(locationStats) },
      { weight: effectiveWeightVenue, overPct: getOverPct(venueStats) },
      { weight: effectiveWeightLastSeason, overPct: getOverPct(lastSeasonStatsData) },
      { weight: effectiveWeightLast30Days, overPct: getOverPct(last30DaysStatsData) },
      { weight: effectiveWeightThisSeason, overPct: getOverPct(thisSeasonStatsData) },
      { weight: effectiveWeightDaysRest, overPct: getOverPct(daysRestStatsData) },
    ].filter((item) => item.overPct !== null && item.weight > 0);

    if (!candidates.length) {
      return null;
    }

    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    const weightedOverPct =
      candidates.reduce((sum, item) => sum + item.weight * (item.overPct ?? 0), 0) / totalWeight;

    const weightedUnderPct = 100 - weightedOverPct;
    const weightedOverBreakEven = weightedOverPct > 0 ? (100 / weightedOverPct).toFixed(2) : '0.00';
    const weightedUnderBreakEven = weightedUnderPct > 0 ? (100 / weightedUnderPct).toFixed(2) : '0.00';

    return {
      weightedOverPct,
      weightedUnderPct,
      weightedOverBreakEven,
      weightedUnderBreakEven,
      totalWeight,
    };
  }, [
    baseStats,
    opponentStats,
    locationStats,
    venueStats,
    lastSeasonStatsData,
    last30DaysStatsData,
    thisSeasonStatsData,
    daysRestStatsData,
    effectiveWeightBase,
    effectiveWeightOpponent,
    effectiveWeightLocation,
    effectiveWeightVenue,
    effectiveWeightLastSeason,
    effectiveWeightLast30Days,
    effectiveWeightThisSeason,
    effectiveWeightDaysRest,
  ]);

  const router = useRouter();

  // Reflect the current Multi cart size on mount so the "View Multi" button
  // appears when the user already has legs queued from a previous session.
  useEffect(() => {
    setMultiLegCount(readCart().length);
  }, []);

  // Snapshot the current single-search result as a Multi leg. No API call:
  // we capture the per-category counts and weighted prediction already in
  // state, so combining legs in the Multi tab costs zero rate-limit tokens.
  const handleAddToMulti = () => {
    if (!requestParams || !weightedMetrics) {
      return;
    }
    const label =
      quickSearchLabel ??
      `${requestParams.player_name ?? 'Player'} • ${requestParams.stat} • ${requestParams.threshold}`;
    const leg: LegSnapshot = {
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `leg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label,
      params: requestParams,
      betMode: isWinLossMode ? 'win_loss' : 'over_under',
      weightedOverPct: weightedMetrics.weightedOverPct,
      categories: {
        base: baseStats ?? null,
        opponent: opponentStats ?? null,
        location: locationStats ?? null,
        venue: venueStats ?? null,
        lastSeason: lastSeasonStatsData ?? null,
        last30Days: last30DaysStatsData ?? null,
        thisSeason: thisSeasonStatsData ?? null,
        daysRest: daysRestStatsData ?? null,
      },
    };
    const cart = addLeg(leg);
    setMultiLegCount(cart.length);
    trackEvent('feature_used', { product: 'afl', feature: 'multi', properties: { action: 'add' } });
    toast.success(`Added to Multi — ${cart.length} ${cart.length === 1 ? 'leg' : 'legs'}`);
  };

  useEffect(() => {
    if (!hasSubmitted) {
      return;
    }
    setWeightBase(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightOpponent(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightLocation(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightVenue(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightLastSeason(DEFAULT_LAST_SEASON_MULTIPLIER);
    setWeightLast30Days(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightThisSeason(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightDaysRest(DEFAULT_WEIGHT_MULTIPLIER);
  }, [
    hasSubmitted,
    baseTotal,
    opponentTotal,
    locationTotal,
    venueTotal,
    lastSeasonTotal,
    last30DaysTotal,
    thisSeasonTotal,
  ]);


  // Never combine a new parent result with context from the previous search.
  useEffect(() => {
    setNextGameResults(null);
    setNextGameResultsLoading(false);
    setNextGameResultsError(null);
    setLastSeasonStats(null);
    setLastSeasonLoading(false);
    setLastSeasonError(null);
    setLast30DaysStats(null);
    setLast30DaysLoading(false);
    setLast30DaysError(null);
    setThisSeasonStats(null);
    setThisSeasonLoading(false);
    setThisSeasonError(null);
    setDaysRestStats(null);
    setDaysRestLoading(false);
    setDaysRestError(null);
  }, [submittedSearch]);

  useEffect(() => {
    let cancelled = false;
    if (!hasSubmitted || !submittedSearch?.receipt || !nextGameInfo || !nextGamePreloaded) {
      return;
    }
    const baseParams = stripContextFilters(submittedSearch.params);
    setNextGameResults(null);
    setNextGameResultsLoading(true);
    setNextGameResultsError(null);
    Promise.all([
      getPlayerOverUnder(
        {
          ...baseParams,
          opponent: nextGameInfo.opponent,
        },
        contextOptions
      ),
      getPlayerOverUnder(
        {
          ...baseParams,
          location: nextGameInfo.location,
        },
        contextOptions
      ),
      getPlayerOverUnder(
        {
          ...baseParams,
          venue: nextGameInfo.venue,
        },
        contextOptions
      ),
    ])
      .then(([opponentStats, locationStats, venueStats]) => {
        if (cancelled) return;
        setNextGameResults({
          opponent: opponentStats,
          location: locationStats,
          venue: venueStats,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setNextGameResults(null);
        setNextGameResultsError(
          err instanceof Error ? err.message : 'Failed to load next game results.'
        );
      })
      .finally(() => {
        if (cancelled) return;
        setNextGameResultsLoading(false);
      });
    return () => { cancelled = true; };
  }, [
    hasSubmitted,
    nextGameInfo,
    nextGamePreloaded,
    submittedSearch,
    contextOptions,
    stripContextFilters,
  ]);

  // Auto-derive the days-rest bucket from the upcoming fixture so the rest
  // card appears by default in every search (same ergonomics as Last 30 Days /
  // This Season / Home-Away). User can still override via the More Filters
  // dropdown; the manual selection wins until the fixture changes.
  useEffect(() => {
    const fixtureDateStr = nextGameInfo?.fixture.game_date;
    if (!hasSubmitted || !submittedSearch?.receipt || submittedSearch.params.player_name !== playerName.trim() || !fixtureDateStr) {
      return;
    }
    const fixtureDate = new Date(fixtureDateStr);
    if (Number.isNaN(fixtureDate.getTime())) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const log = await getPlayerGameLog(
          gameLogRestParams(submittedSearch.params),
          { purpose: 'context', receipt: submittedSearch.receipt, receiptExpiresAt: submittedSearch.expiresAt }
        );
        if (cancelled || log.games.length === 0) return;

        // Most recent game before the fixture date.
        const priorGames = log.games
          .filter((g) => new Date(g.game_date) < fixtureDate)
          .sort((a, b) => (a.game_date < b.game_date ? 1 : -1));
        if (!priorGames.length) return;

        const lastGameDate = new Date(priorGames[0].game_date);
        const msPerDay = 1000 * 60 * 60 * 24;
        const diffDays = Math.round((fixtureDate.getTime() - lastGameDate.getTime()) / msPerDay);

        let bucket: 'any' | '5' | '6' | '7' | '8' | '9' | '10to14' | '15plus' = 'any';
        if (diffDays === 5) bucket = '5';
        else if (diffDays === 6) bucket = '6';
        else if (diffDays === 7) bucket = '7';
        else if (diffDays === 8) bucket = '8';
        else if (diffDays === 9) bucket = '9';
        else if (diffDays >= 10 && diffDays <= 14) bucket = '10to14';
        else if (diffDays >= 15 && diffDays <= 30) bucket = '15plus';

        if (!cancelled && bucket !== 'any') {
          setDaysRestBucket(bucket);
        }
      } catch {
        // Silent fail — auto-derive is best-effort; manual bucket still works.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasSubmitted, nextGameInfo, playerName, submittedSearch]);

  useEffect(() => {
    if (!hasSubmitted || !submittedSearch?.receipt) {
      return;
    }

    let cancelled = false;
    const baseParams = stripContextFilters(submittedSearch.params);

    if (lastSeasonInRange) {
      const lastSeasonParams: OverUnderParams = {
        ...baseParams,
        season_from: LAST_SEASON_YEAR,
        season_to: LAST_SEASON_YEAR,
      };

      setLastSeasonLoading(true);
      setLastSeasonError(null);

      const lastSeasonResult = loadStats(lastSeasonParams, contextOptions);

      if (!lastSeasonResult.fromCache) {
        setLastSeasonLoading(true);
      }

      lastSeasonResult.promise
        .then((data) => {
          if (!cancelled) {
            setLastSeasonStats(data);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setLastSeasonError(err instanceof Error ? err.message : 'Unable to load last season stats.');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLastSeasonLoading(false);
          }
        });
    } else {
      setLastSeasonStats(null);
      setLastSeasonLoading(false);
      setLastSeasonError(null);
    }

    if (last30DaysInRange) {
      const today = new Date();
      const dateTo = today.toISOString().split('T')[0];
      const dateFromDate = new Date(today);
      dateFromDate.setDate(today.getDate() - LAST_30_DAYS);
      const dateFrom = dateFromDate.toISOString().split('T')[0];

      const last30Params: OverUnderParams = {
        ...stripSeasonFilters(baseParams),
        date_from: dateFrom,
        date_to: dateTo,
      };

      setLast30DaysLoading(true);
      setLast30DaysError(null);

      const last30Result = loadStats(last30Params, contextOptions);

      if (!last30Result.fromCache) {
        setLast30DaysLoading(true);
      }

      last30Result.promise
        .then((data) => {
          if (!cancelled) {
            setLast30DaysStats(data);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setLast30DaysError(err instanceof Error ? err.message : 'Unable to load last 30 days stats.');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLast30DaysLoading(false);
          }
        });
    } else {
      setLast30DaysStats(null);
      setLast30DaysLoading(false);
      setLast30DaysError(null);
    }

    if (thisSeasonInRange) {
      const thisSeasonParams: OverUnderParams = {
        ...baseParams,
        season_from: Number(CURRENT_SEASON),
        season_to: Number(CURRENT_SEASON),
      };

      setThisSeasonLoading(true);
      setThisSeasonError(null);

      const thisSeasonResult = loadStats(thisSeasonParams, contextOptions);

      if (!thisSeasonResult.fromCache) {
        setThisSeasonLoading(true);
      }

      thisSeasonResult.promise
        .then((data) => {
          if (!cancelled) {
            setThisSeasonStats(data);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setThisSeasonError(err instanceof Error ? err.message : 'Unable to load this season stats.');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setThisSeasonLoading(false);
          }
        });
    } else {
      setThisSeasonStats(null);
      setThisSeasonLoading(false);
      setThisSeasonError(null);
    }

    if (daysRestFilter) {
      const daysRestParams: OverUnderParams = {
        ...baseParams,
        days_rest_min: daysRestFilter.min,
        days_rest_max: daysRestFilter.max,
      };

      setDaysRestLoading(true);
      setDaysRestError(null);

      const daysRestResult = loadStats(daysRestParams, contextOptions);

      if (!daysRestResult.fromCache) {
        setDaysRestLoading(true);
      }

      daysRestResult.promise
        .then((data) => {
          if (!cancelled) {
            setDaysRestStats(data);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setDaysRestError(err instanceof Error ? err.message : 'Unable to load days-rest stats.');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setDaysRestLoading(false);
          }
        });
    } else {
      setDaysRestStats(null);
      setDaysRestLoading(false);
      setDaysRestError(null);
    }

    return () => {
      cancelled = true;
    };
  }, [hasSubmitted, submittedSearch, contextOptions, stripContextFilters, stripSeasonFilters, loadStats, lastSeasonInRange, last30DaysInRange, thisSeasonInRange, daysRestFilter]);

  // Career-view fetch: when the user flips the toggle on, fetch all
  // non-time-based cards (base, opponent, location, venue, days-rest) with
  // the season filter stripped so they show lifetime numbers. Weighted algo
  // is NOT affected — it continues to use the season-filtered data above.
  useEffect(() => {
    if (!careerViewEnabled || !hasSubmitted || !submittedSearch?.receipt) {
      return;
    }

    let cancelled = false;
    const careerBaseParams = stripSeasonFilters(stripContextFilters(submittedSearch.params));

    setCareerLoading(true);

    const basePromise = loadStats(careerBaseParams, contextOptions).promise;
    const opponentPromise = nextGameInfo
      ? loadStats({ ...careerBaseParams, opponent: nextGameInfo.opponent }, contextOptions).promise
      : Promise.resolve(null as OverUnderResponse | null);
    const locationPromise = nextGameInfo
      ? loadStats({ ...careerBaseParams, location: nextGameInfo.location }, contextOptions).promise
      : Promise.resolve(null as OverUnderResponse | null);
    const venuePromise = nextGameInfo
      ? loadStats({ ...careerBaseParams, venue: nextGameInfo.venue }, contextOptions).promise
      : Promise.resolve(null as OverUnderResponse | null);
    const daysRestPromise = daysRestFilter
      ? loadStats(
          {
            ...careerBaseParams,
            days_rest_min: daysRestFilter.min,
            days_rest_max: daysRestFilter.max,
          },
          contextOptions
        ).promise
      : Promise.resolve(null as OverUnderResponse | null);

    Promise.all([basePromise, opponentPromise, locationPromise, venuePromise, daysRestPromise])
      .then(([base, opponent, location, venue, daysRest]) => {
        if (cancelled) return;
        setCareerBaseStats(base ?? null);
        setCareerOpponentStats(opponent ?? null);
        setCareerLocationStats(location ?? null);
        setCareerVenueStats(venue ?? null);
        setCareerDaysRestStats(daysRest ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        // Silent fail — default season-filtered view still shows correctly.
      })
      .finally(() => {
        if (!cancelled) setCareerLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    careerViewEnabled,
    hasSubmitted,
    submittedSearch,
    contextOptions,
    nextGameInfo,
    daysRestFilter,
    stripContextFilters,
    stripSeasonFilters,
    loadStats,
  ]);

  // When search params change, invalidate career cache so toggling re-fetches.
  useEffect(() => {
    setCareerBaseStats(null);
    setCareerOpponentStats(null);
    setCareerLocationStats(null);
    setCareerVenueStats(null);
    setCareerDaysRestStats(null);
  }, [submittedSearch]);

  // Derived display values: when toggle is on and career data is loaded,
  // show career numbers; otherwise show season-filtered numbers.
  const displayBaseStats = careerViewEnabled && careerBaseStats ? careerBaseStats : displayStats;
  const displayOpponentStats = careerViewEnabled && careerOpponentStats ? careerOpponentStats : nextGameResults?.opponent ?? null;
  const displayLocationStats = careerViewEnabled && careerLocationStats ? careerLocationStats : nextGameResults?.location ?? null;
  const displayVenueStats = careerViewEnabled && careerVenueStats ? careerVenueStats : nextGameResults?.venue ?? null;
  const displayDaysRestStats = careerViewEnabled && careerDaysRestStats ? careerDaysRestStats : daysRestStatsData;

  return (
    <div className="relative w-full max-w-4xl mx-auto">
      <Card className="relative w-full bg-white border border-gray-200 shadow-elegant overflow-hidden">
        {/* Simple top border */}
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-green-500 via-green-600 to-green-700"></div>
        
        <CardContent className="space-y-6 px-6 sm:px-8 py-6">
          {/* Results Display - Show immediately when loading or results exist */}
          {showResults && !isFormExpanded && (
              <div className="space-y-6 animate-fade-in">
                {/* Action Buttons - Above criteria */}
                <div className="flex items-center gap-1 sm:gap-2 justify-end pb-3 border-b border-gray-100">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleAdjustSearch}
                    title="Adjust search"
                    aria-label="Adjust search"
                    className="h-10 px-2 sm:px-4 text-sm font-semibold"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">Adjust Search</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSaveSearch}
                    title="Save search to Vault"
                    aria-label="Save search to Vault"
                    disabled={isSavingSearch}
                    className="h-10 px-2 sm:px-4 text-sm font-semibold"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">{isSavingSearch ? 'Saving...' : 'Save to Vault'}</span>
                  </Button>
                  <Button
                    type="button"
                    onClick={handleAddToMulti}
                    title="Add this leg to your Multi"
                    aria-label="Add to Multi"
                    disabled={!requestParams || !weightedMetrics}
                    className="h-10 px-2 sm:px-4 text-sm font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-sm transition-all hover:from-violet-700 hover:to-indigo-700 hover:shadow-md disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">Add to Multi</span>
                  </Button>
                  {multiLegCount >= 2 && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => router.push('/multi')}
                      title={`View Multi (${multiLegCount} legs)`}
                      aria-label={`View Multi (${multiLegCount} legs)`}
                      className="h-10 px-2 sm:px-4 text-sm font-semibold border-violet-300 text-violet-700 hover:bg-violet-50"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline ml-1.5">View Multi ({multiLegCount})</span>
                      <span className="sm:hidden ml-1">{multiLegCount}</span>
                    </Button>
                  )}
                  <Button
                    type="button"
                    onClick={handleNewSearch}
                    title="Start a new search"
                    aria-label="Start a new search"
                    className="h-10 px-2 sm:px-5 bg-gradient-to-r from-green-600 to-green-500 hover:from-green-700 hover:to-green-600 text-white font-semibold rounded transition-all shadow-sm hover:shadow-md"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">New Search</span>
                  </Button>
                </div>

                {/* Bet Criteria - Sticky bar */}
                <div className="sticky top-0 z-20 bg-green-50 border border-green-200 border-l-4 border-l-green-600 rounded-lg p-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-green-600 rounded text-white">
                      <BarChart3 className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Bet Criteria</p>
                      <p className="text-sm font-semibold text-gray-900 flex flex-wrap items-center gap-1">
                        <span className="text-green-600">{playerDisplayName}</span>
                        <span>• {statLabel}</span>
                        <span>• {marketLabel}</span>
                        {isWinLossMode && (
                          <span className="text-xs font-medium text-gray-500">• Win market</span>
                        )}
                        <span className="text-xs font-medium text-gray-500">• {fullResultsSeasonLabel}</span>
                      </p>
                    </div>
                  </div>
                </div>

                {/* Career Averages */}
                {selectedPlayerId !== null && selectedPlayerId > 0 && (
                  <PlayerCareerAverages
                    playerId={selectedPlayerId}
                    playerName={playerDisplayName}
                    size="md"
                    className="pt-1 pl-1"
                  />
                )}

                {/* Weighted Results (collapsed by default) */}
                {showResults && (
                  <div
                    id="weighted-results"
                    className="mb-8 rounded-xl border border-green-900/20 overflow-hidden shadow-lg"
                  >
                    {/* Algorithm Banner */}
                    <div className="bg-gradient-to-br from-green-950 via-green-900 to-green-800 px-5 py-4 sm:py-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[10px] font-bold text-green-400 uppercase tracking-[0.2em] mb-1">
                            StatChecker
                          </p>
                          <h2 className="text-2xl sm:text-3xl font-extrabold text-white leading-tight tracking-tight">
                            Algorithm
                          </h2>
                          <Popover open={weightedInfoOpen} onOpenChange={setWeightedInfoOpen}>
                            <PopoverTrigger asChild>
                              <button
                                className="inline-flex items-center gap-1.5 text-xs text-green-300 hover:text-green-100 mt-2 transition-colors"
                                onMouseEnter={openWeightedInfo}
                                onMouseLeave={scheduleWeightedInfoClose}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    setWeightedInfoOpen((prev) => !prev);
                                  }
                                }}
                              >
                                <Info className="h-3 w-3" />
                                Weighted by venue, opposition, form &amp; more
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              className="w-72 text-xs text-gray-600"
                              onMouseEnter={openWeightedInfo}
                              onMouseLeave={scheduleWeightedInfoClose}
                            >
                              Results are weighted based on the factors most relevant to the next game — venue, opposition, recent form, home/away record and more.
                            </PopoverContent>
                          </Popover>
                        </div>
                        <div className="flex flex-col items-end gap-2.5 shrink-0">
                          <div className="p-2.5 bg-white/10 rounded-xl">
                            <CheckCircle2 className="w-6 h-6 text-green-300" />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={toggleWeightsOpen}
                            className="h-7 px-3 text-[11px] font-bold text-white bg-white/15 hover:bg-white/25 rounded-full border-0"
                          >
                            {weightsOpen ? 'Hide Sliders' : 'Customize'}
                          </Button>
                        </div>
                      </div>
                    </div>
                    <div className="bg-green-50/60 border-t border-green-900/20">
                    <div className="px-4 pt-4 pb-4 space-y-4">
                      {weightedMetrics ? (
                        <div className="space-y-4">
                          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                            <div className="space-y-3">
                              <div>
                                <div className="flex items-center justify-between text-xs font-semibold text-gray-600">
                                  <span>{positiveLabel}</span>
                                  <span>{weightedMetrics.weightedOverPct.toFixed(1)}%</span>
                                </div>
                                <div className="mt-2 h-4 w-full rounded-full bg-gray-100 overflow-hidden">
                                  <div
                                    className={`${positiveBarGradient} h-full rounded-full`}
                                    style={{ width: `${weightedMetrics.weightedOverPct}%` }}
                                  ></div>
                                </div>
                                {!screenshotMode && (
                                  <div className="mt-1 text-xs text-gray-500">
                                    Break-even: ${weightedMetrics.weightedOverBreakEven}
                                  </div>
                                )}
                              </div>
                              <div>
                                <div className="flex items-center justify-between text-xs font-semibold text-gray-600">
                                  <span>{negativeLabel}</span>
                                  <span>{weightedMetrics.weightedUnderPct.toFixed(1)}%</span>
                                </div>
                                <div className="mt-2 h-4 w-full rounded-full bg-gray-100 overflow-hidden">
                                  <div
                                    className={`${negativeBarGradient} h-full rounded-full`}
                                    style={{ width: `${weightedMetrics.weightedUnderPct}%` }}
                                  ></div>
                                </div>
                                {!screenshotMode && (
                                  <div className="mt-1 text-xs text-gray-500">
                                    Break-even: ${weightedMetrics.weightedUnderBreakEven}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-500">
                          Add weights to see weighted results.
                        </p>
                      )}

                      {weightedMetrics && (
                        <div className="text-xs text-gray-500 text-right">
                          Total weight: {weightedMetrics.totalWeight}
                        </div>
                      )}

                      <div className="space-y-4">
                        {weightsOpen && (
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                              <WeightSlider
                                label="Overall games"
                                value={weightBase}
                                onChange={setWeightBase}
                                count={baseTotal}
                              max={maxWeight}
                              disabled={!baseStats}
                              percent={
                                baseStats && totalWeightForPercent > 0
                                  ? (effectiveWeightBase / totalWeightForPercent) * 100
                                  : null
                              }
                            />
                            <WeightSlider
                              label="Home/Away"
                              value={weightLocation}
                              onChange={setWeightLocation}
                              count={locationTotal}
                              max={maxWeight}
                              disabled={!locationStats}
                              percent={
                                locationStats && totalWeightForPercent > 0
                                  ? (effectiveWeightLocation / totalWeightForPercent) * 100
                                  : null
                              }
                            />
                            <WeightSlider
                              label="Venue"
                              value={weightVenue}
                              onChange={setWeightVenue}
                              count={venueTotal}
                              max={maxWeight}
                              disabled={!venueStats}
                              percent={
                                venueStats && totalWeightForPercent > 0
                                  ? (effectiveWeightVenue / totalWeightForPercent) * 100
                                  : null
                              }
                            />
                            <WeightSlider
                              label="Opponent"
                              value={weightOpponent}
                              onChange={setWeightOpponent}
                              count={opponentTotal}
                              max={maxWeight}
                              disabled={!opponentStats}
                              percent={
                                opponentStats && totalWeightForPercent > 0
                                  ? (effectiveWeightOpponent / totalWeightForPercent) * 100
                                  : null
                              }
                            />
                            {thisSeasonInRange && (
                              <WeightSlider
                                label={`This season (${CURRENT_SEASON})`}
                                value={weightThisSeason}
                                onChange={setWeightThisSeason}
                                count={thisSeasonTotal}
                                max={maxWeight}
                                disabled={!thisSeasonStatsData}
                                percent={
                                  thisSeasonStatsData && totalWeightForPercent > 0
                                    ? (effectiveWeightThisSeason / totalWeightForPercent) * 100
                                    : null
                                }
                              />
                            )}
                            {lastSeasonInRange && (
                              <WeightSlider
                                label={`Last season (${LAST_SEASON_YEAR})`}
                                value={weightLastSeason}
                                onChange={setWeightLastSeason}
                                count={lastSeasonTotal}
                                max={maxWeight}
                                disabled={!lastSeasonStatsData}
                                percent={
                                  lastSeasonStatsData && totalWeightForPercent > 0
                                    ? (effectiveWeightLastSeason / totalWeightForPercent) * 100
                                    : null
                                }
                              />
                            )}
                            {last30DaysInRange && (
                              <WeightSlider
                                label={`Last ${LAST_30_DAYS} days`}
                                value={weightLast30Days}
                                onChange={setWeightLast30Days}
                                count={last30DaysTotal}
                                max={maxWeight}
                                disabled={!last30DaysStatsData}
                                  percent={
                                    last30DaysStatsData && totalWeightForPercent > 0
                                      ? (effectiveWeightLast30Days / totalWeightForPercent) * 100
                                      : null
                                  }
                                />
                            )}
                            {daysRestBucket !== 'any' && (
                              <WeightSlider
                                label={daysRestLabel}
                                value={weightDaysRest}
                                onChange={setWeightDaysRest}
                                count={daysRestTotal}
                                max={maxWeight}
                                disabled={!daysRestStatsData}
                                percent={
                                  daysRestStatsData && totalWeightForPercent > 0
                                    ? (effectiveWeightDaysRest / totalWeightForPercent) * 100
                                    : null
                                }
                              />
                            )}
                            </div>
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="flex flex-wrap items-center gap-3">
                                <Select
                                  onValueChange={(value) => {
                                    const preset = savedWeights.find((item) => item.id === value);
                                    if (preset) {
                                      applyWeightPreset(preset);
                                    }
                                  }}
                                >
                                  <SelectTrigger className="h-9 w-[220px] text-xs">
                                    <SelectValue placeholder="Apply saved weights" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {savedWeights.length === 0 && (
                                      <SelectItem value="none" disabled>
                                        No saved presets
                                      </SelectItem>
                                    )}
                                    {savedWeights.map((item) => (
                                      <SelectItem key={item.id} value={item.id}>
                                        {item.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <div className="flex items-center gap-2">
                                  <Input
                                    value={weightsPresetName}
                                    onChange={(event) => setWeightsPresetName(event.target.value)}
                                    placeholder="Preset name"
                                    className="h-9 w-[180px] text-xs"
                                  />
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={handleSaveWeightsPreset}
                                    disabled={!weightsPresetName.trim() || isSavingWeights}
                                  >
                                    Save preset
                                  </Button>
                                </div>
                              </div>
                              <span className="text-xs text-gray-500">
                                Total weight: {totalWeightForPercent.toFixed(0)}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    </div>
                  </div>
                )}

                {hasSubmitted && submittedSearch && (
                  <PlayerImpactResearch
                    key={JSON.stringify(submittedSearch.params)}
                    params={submittedSearch.params}
                    receipt={submittedSearch.receipt}
                  />
                )}

                {/* Game Log */}
                {hasSubmitted && !isFormExpanded && submittedSearch && (
                  <PlayerGameLog
                    receipt={submittedSearch.receipt}
                    receiptExpiresAt={submittedSearch.expiresAt}
                    player_id={submittedSearch.params.player_id}
                    player_name={submittedSearch.params.player_name}
                    season_from={submittedSearch.params.season_from}
                    season_to={submittedSearch.params.season_to}
                    activeStat={submittedSearch.params.stat}
                    threshold={submittedSearch.params.threshold}
                    todayDate={todayDate}
                  />
                )}

                {/* Results breakdown */}
                {showResults && (
                  <div className="mt-8 space-y-8">
                    <div className="flex flex-col gap-3">
                      <div className="rounded-xl bg-gradient-to-r from-green-700 via-green-600 to-green-500 p-4 sm:p-5 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-bold text-green-100 uppercase tracking-[0.15em] mb-1">
                              Season Analysis
                            </p>
                            <h2 className="text-xl sm:text-2xl font-bold text-white leading-tight">
                              Detailed Hit Rates
                            </h2>
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                              <span className="inline-flex items-center gap-1 text-xs font-semibold bg-white/20 text-white px-2.5 py-1 rounded-full">
                                {fullResultsSeasonLabel}
                              </span>
                              <span className="inline-flex items-center gap-1 text-xs font-semibold bg-white/20 text-white px-2.5 py-1 rounded-full">
                                {fullResultsGamesLabel}
                              </span>
                            </div>
                          </div>
                          <div className="p-2.5 bg-white/15 rounded-xl">
                            <BarChart3 className="w-6 h-6 text-white" />
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                        <Tabs
                          value={resultsFormat}
                          onValueChange={(value) => {
                            if (value === 'text' || value === 'graphs' || value === 'both') {
                              setResultsFormat(value);
                            }
                          }}
                        >
                          <TabsList className="h-8 bg-white">
                            <TabsTrigger value="graphs" className="text-xs">
                              Graphs
                            </TabsTrigger>
                            <TabsTrigger value="text" className="text-xs">
                              Text
                            </TabsTrigger>
                            <TabsTrigger value="both" className="text-xs">
                              Graphs + Text
                            </TabsTrigger>
                          </TabsList>
                        </Tabs>
                      </div>
                    </div>
                    {/* Career-view toggle — flips non-time-based cards to show
                        lifetime numbers instead of the selected season range.
                        Segmented buttons (not a subtle switch) so both options
                        are visible; info icon with hover tooltip explains the
                        feature. Accent ring draws the eye on first render. */}
                    <div
                      className={`flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 transition-all ${
                        careerViewEnabled
                          ? 'border-emerald-400 bg-emerald-50/70 shadow-[0_0_0_4px_rgba(16,185,129,0.08)]'
                          : 'border-emerald-300 bg-white shadow-[0_0_0_4px_rgba(16,185,129,0.06)]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-emerald-600 shrink-0" />
                        <span className="text-sm font-bold text-gray-900">Context view</span>
                        <Tooltip delayDuration={100}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="About the Context view toggle"
                              className="inline-flex items-center justify-center w-5 h-5 rounded-full text-gray-400 hover:text-emerald-600 hover:bg-emerald-100 transition-colors"
                            >
                              <Info className="w-4 h-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-xs text-xs leading-snug">
                            <p className="font-semibold mb-1">What this does</p>
                            <p className="mb-2">
                              Flips the <strong>All games</strong>, <strong>Home/Away</strong>,
                              <strong> Venue</strong>, <strong>Opponent</strong> and
                              <strong> Days rest</strong> cards between your selected season range
                              and the player&apos;s whole career.
                            </p>
                            <p className="mb-2">
                              Useful for spotting long-term patterns (e.g.
                              &ldquo;career record at the MCG&rdquo;) while keeping a recent
                              season range on the weighted prediction.
                            </p>
                            <p className="text-[10px] text-gray-500">
                              Time-based cards (This season, Last season, Last 30 days) and
                              the weighted algorithm both stay anchored to your season filter.
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <div
                        role="group"
                        aria-label="Context view mode"
                        className="inline-flex items-center rounded-lg bg-gray-100 p-1 gap-1 w-full sm:w-auto"
                      >
                        <button
                          type="button"
                          onClick={() => setCareerViewEnabled(false)}
                          aria-pressed={!careerViewEnabled}
                          className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                            !careerViewEnabled
                              ? 'bg-white text-emerald-700 shadow-sm'
                              : 'text-gray-600 hover:text-gray-900'
                          }`}
                        >
                          {seasonFrom === 'any' && seasonTo === 'any'
                            ? 'All seasons'
                            : seasonFrom === seasonTo
                              ? `${seasonFrom} only`
                              : `${seasonFrom}–${seasonTo}`}
                        </button>
                        <button
                          type="button"
                          onClick={() => setCareerViewEnabled(true)}
                          aria-pressed={careerViewEnabled}
                          className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                            careerViewEnabled
                              ? 'bg-emerald-600 text-white shadow-sm'
                              : 'text-gray-600 hover:text-gray-900'
                          }`}
                        >
                          All career
                        </button>
                      </div>
                    </div>
                    <ResultsTemplate
                      title={careerViewEnabled ? 'All games (career)' : 'All games'}
                      loading={loading || (careerViewEnabled && careerLoading && !careerBaseStats)}
                      stats={displayBaseStats}
                      seasonFrom={seasonFrom}
                      seasonTo={seasonTo}
                      resultsFormat={resultsFormat}
                      marketLabel={marketLabel}
                      isWinLossMode={isWinLossMode}
                      positiveLabel={positiveLabel}
                      negativeLabel={negativeLabel}
                      percentageLabel={percentageLabel}
                      positiveGamesLabel={positiveGamesLabel}
                      negativeGamesLabel={negativeGamesLabel}
                    />
                    {thisSeasonInRange && (
                      <ResultsTemplate
                        title={`This season (${CURRENT_SEASON}) results`}
                        loading={thisSeasonLoading}
                        stats={thisSeasonStatsData}
                        seasonFrom={CURRENT_SEASON}
                        seasonTo={CURRENT_SEASON}
                        seasonLabel={CURRENT_SEASON}
                        resultsFormat={resultsFormat}
                        marketLabel={marketLabel}
                        isWinLossMode={isWinLossMode}
                        positiveLabel={positiveLabel}
                        negativeLabel={negativeLabel}
                        percentageLabel={percentageLabel}
                        positiveGamesLabel={positiveGamesLabel}
                        negativeGamesLabel={negativeGamesLabel}
                      />
                    )}
                    {nextGameInfo && !nextGameError && (
                      <>
                        <ResultsTemplate
                          title={`${nextGameInfo.location === 'home' ? 'Home' : 'Away'} results${careerViewEnabled ? ' (career)' : ''}`}
                          loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerLocationStats)}
                          stats={displayLocationStats}
                          seasonFrom={seasonFrom}
                          seasonTo={seasonTo}
                          showSeasonMeta={false}
                          resultsFormat={resultsFormat}
                          marketLabel={marketLabel}
                          isWinLossMode={isWinLossMode}
                          positiveLabel={positiveLabel}
                          negativeLabel={negativeLabel}
                          percentageLabel={percentageLabel}
                          positiveGamesLabel={positiveGamesLabel}
                          negativeGamesLabel={negativeGamesLabel}
                        />
                        <ResultsTemplate
                          title={`Results at ${nextGameInfo.venue}${careerViewEnabled ? ' (career)' : ''}`}
                          loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerVenueStats)}
                          stats={displayVenueStats}
                          seasonFrom={seasonFrom}
                          seasonTo={seasonTo}
                          showSeasonMeta={false}
                          resultsFormat={resultsFormat}
                          marketLabel={marketLabel}
                          isWinLossMode={isWinLossMode}
                          positiveLabel={positiveLabel}
                          negativeLabel={negativeLabel}
                          percentageLabel={percentageLabel}
                          positiveGamesLabel={positiveGamesLabel}
                          negativeGamesLabel={negativeGamesLabel}
                        />
                        <ResultsTemplate
                          title={`Results vs ${nextGameInfo.opponent}${careerViewEnabled ? ' (career)' : ''}`}
                          loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerOpponentStats)}
                          stats={displayOpponentStats}
                          seasonFrom={seasonFrom}
                          seasonTo={seasonTo}
                          showSeasonMeta={false}
                          resultsFormat={resultsFormat}
                          marketLabel={marketLabel}
                          isWinLossMode={isWinLossMode}
                          positiveLabel={positiveLabel}
                          negativeLabel={negativeLabel}
                          percentageLabel={percentageLabel}
                          positiveGamesLabel={positiveGamesLabel}
                          negativeGamesLabel={negativeGamesLabel}
                        />
                      </>
                    )}
                    {last30DaysInRange && (
                      <ResultsTemplate
                        title={`Last ${LAST_30_DAYS} days results`}
                        loading={last30DaysLoading}
                        stats={last30DaysStatsData}
                        seasonFrom={seasonFrom}
                        seasonTo={seasonTo}
                        seasonLabel={`Last ${LAST_30_DAYS} days`}
                        resultsFormat={resultsFormat}
                        marketLabel={marketLabel}
                        isWinLossMode={isWinLossMode}
                        positiveLabel={positiveLabel}
                        negativeLabel={negativeLabel}
                        percentageLabel={percentageLabel}
                        positiveGamesLabel={positiveGamesLabel}
                        negativeGamesLabel={negativeGamesLabel}
                      />
                    )}
                    {daysRestBucket !== 'any' && (
                      <ResultsTemplate
                        title={`${daysRestLabel} results${careerViewEnabled ? ' (career)' : ''}`}
                        loading={daysRestLoading || (careerViewEnabled && careerLoading && !careerDaysRestStats)}
                        stats={displayDaysRestStats}
                        seasonFrom={seasonFrom}
                        seasonTo={seasonTo}
                        showSeasonMeta={false}
                        resultsFormat={resultsFormat}
                        marketLabel={marketLabel}
                        isWinLossMode={isWinLossMode}
                        positiveLabel={positiveLabel}
                        negativeLabel={negativeLabel}
                        percentageLabel={percentageLabel}
                        positiveGamesLabel={positiveGamesLabel}
                        negativeGamesLabel={negativeGamesLabel}
                      />
                    )}
                    {lastSeasonInRange && (
                      <ResultsTemplate
                        title={`Last season (${LAST_SEASON_YEAR}) results`}
                        loading={lastSeasonLoading}
                        stats={lastSeasonStatsData}
                        seasonFrom={LAST_SEASON_YEAR.toString()}
                        seasonTo={LAST_SEASON_YEAR.toString()}
                        seasonLabel={`${LAST_SEASON_YEAR}`}
                        resultsFormat={resultsFormat}
                        marketLabel={marketLabel}
                        isWinLossMode={isWinLossMode}
                        positiveLabel={positiveLabel}
                        negativeLabel={negativeLabel}
                        percentageLabel={percentageLabel}
                        positiveGamesLabel={positiveGamesLabel}
                        negativeGamesLabel={negativeGamesLabel}
                      />
                    )}

                    {nextGameResultsError && (
                      <p className="text-xs text-red-600">{nextGameResultsError}</p>
                    )}
                    <div className="flex justify-center pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-10 px-5 text-sm font-semibold"
                        onClick={() => {
                          document
                            .getElementById('weighted-results')
                            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        Back to weighting
                      </Button>
                    </div>
                  </div>
                )}

                {/* Disclaimer */}
                {!loading && displayStats && !screenshotMode && (
                  <Alert className="mt-6 border border-yellow-200 bg-yellow-50">
                    <Info className="h-5 w-5 text-yellow-600" />
                    <AlertTitle className="text-sm font-bold text-gray-900 mb-2">
                      Important Note: Historical Break-Even Odds
                    </AlertTitle>
                    <AlertDescription className="text-sm text-gray-700 leading-relaxed space-y-2">
                      <p>
                        Historical break-even odds are calculated based on all results for this player in the selected games and are <strong>not meant as betting advice</strong>.
                      </p>
                      <p>
                        Please note that many factors can change a player's odds over the years, including:
                      </p>
                      <ul className="list-disc list-inside ml-2 space-y-1 text-gray-700">
                        <li>Their role in the team</li>
                        <li>Injuries and fitness levels</li>
                        <li>Opposition strength</li>
                        <li>Home vs away games</li>
                        <li>Team dynamics and coaching changes</li>
                      </ul>
                      <p className="pt-2 font-semibold text-gray-900">
                        Please think carefully before placing any bet.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}

                {/* Bottom Action Buttons */}
                <div className="flex items-center gap-1 sm:gap-2 justify-end pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleAdjustSearch}
                    title="Adjust search"
                    aria-label="Adjust search"
                    className="h-10 px-2 sm:px-4 text-sm font-semibold"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">Adjust Search</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSaveSearch}
                    title="Save search to Vault"
                    aria-label="Save search to Vault"
                    disabled={isSavingSearch}
                    className="h-10 px-2 sm:px-4 text-sm font-semibold"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">{isSavingSearch ? 'Saving...' : 'Save to Vault'}</span>
                  </Button>
                  <Button
                    type="button"
                    onClick={handleAddToMulti}
                    title="Add this leg to your Multi"
                    aria-label="Add to Multi"
                    disabled={!requestParams || !weightedMetrics}
                    className="h-10 px-2 sm:px-4 text-sm font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-sm transition-all hover:from-violet-700 hover:to-indigo-700 hover:shadow-md disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">Add to Multi</span>
                  </Button>
                  {multiLegCount >= 2 && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => router.push('/multi')}
                      title={`View Multi (${multiLegCount} legs)`}
                      aria-label={`View Multi (${multiLegCount} legs)`}
                      className="h-10 px-2 sm:px-4 text-sm font-semibold border-violet-300 text-violet-700 hover:bg-violet-50"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline ml-1.5">View Multi ({multiLegCount})</span>
                      <span className="sm:hidden ml-1">{multiLegCount}</span>
                    </Button>
                  )}
                  <Button
                    type="button"
                    onClick={handleNewSearch}
                    title="Start a new search"
                    aria-label="Start a new search"
                    className="h-10 px-2 sm:px-5 bg-gradient-to-r from-green-600 to-green-500 hover:from-green-700 hover:to-green-600 text-white font-semibold rounded transition-all shadow-sm hover:shadow-md"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline ml-1.5">New Search</span>
                  </Button>
                </div>
              </div>
            )}

          {/* Search Form (shown until user submits, or when expanded) */}
          {(!hasSubmitted || isFormExpanded) && (
            <div className={`space-y-6 transition-all duration-500 ${isFormExpanded ? 'animate-fade-in' : ''}`}>
              {isFormExpanded && hasResults && (
                <div className="flex items-center justify-between p-4 rounded-lg bg-muted/30 border border-border/30 mb-4">
                  <p className="text-sm font-medium text-muted-foreground">New Search</p>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setIsFormExpanded(false)}
                    className="h-9 px-4 text-sm"
                  >
                    Cancel
                  </Button>
                </div>
              )}
              <form onSubmit={handleSubmit} className="space-y-6">
            {/* Player Field - Full Width with Smart Autocomplete */}
            <div className="space-y-3 group">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="playerName" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <User className="w-4 h-4 text-gray-600" />
                  Player
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex items-center rounded-full border border-gray-200 bg-white p-1 text-[10px] font-semibold uppercase tracking-wide">
                    <button
                      type="button"
                      onClick={() => setPickMode('top')}
                      className={`rounded-full px-3 py-1 transition-colors ${pickMode === 'top' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      Top picks
                    </button>
                    <button
                      type="button"
                      onClick={() => setPickMode('saved')}
                      className={`rounded-full px-3 py-1 transition-colors ${pickMode === 'saved' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      Saved
                    </button>
                  </div>
                  {playerSelectedFromGame && (
                    <span className="text-xs text-green-600 font-medium animate-fade-in flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Selected from upcoming game
                    </span>
                  )}
                </div>
              </div>
              <div className="relative">
                <div className={`absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none transition-colors z-10 ${
                  playerSelectedFromGame ? 'text-green-600' : 'text-muted-foreground'
                }`}>
                  {isLoadingSuggestions ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <User className="w-5 h-5" />
                  )}
                </div>
                <Input
                  ref={playerInputRef}
                  id="playerName"
                  type="text"
                  value={playerName}
                  onChange={(e) => handlePlayerInputChange(e.target.value)}
                  onFocus={() => {
                    if (playerName.trim().length === 0 && !selectedPlayerId) {
                      applyTopPickSuggestions();
                      return;
                    }
                    if (suggestions.length > 0 && !selectedPlayerId) {
                      setAutocompleteOpen(true);
                    }
                  }}
                  onBlur={() => {
                    // Delay closing to allow click on suggestion
                    setTimeout(() => setAutocompleteOpen(false), 200);
                  }}
                  placeholder="Type a player name or tap a top/saved pick..."
                  autoComplete="off"
                  className={`h-12 pl-12 pr-4 rounded border bg-white text-base transition-all duration-200 focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-0 focus-visible:border-green-600 hover:border-gray-400 ${
                    playerSelectedFromGame
                      ? 'border-green-500 bg-green-50/50 ring-2 ring-green-200' 
                      : 'border-gray-300'
                  }`}
                />
                
                {/* Autocomplete Dropdown */}
                {autocompleteOpen && suggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white rounded-lg border border-gray-200 shadow-lg overflow-hidden animate-fade-in">
                    {showingTopPicks && (
                      <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-100">
                        {pickMode === 'saved' ? 'Saved picks' : 'Top picks (2025)'}
                      </div>
                    )}
                    <div className="py-1 max-h-64 overflow-y-auto">
                      {suggestions.map((suggestion, index) => (
                        <button
                          key={suggestion.player_id}
                          type="button"
                          className={`w-full px-4 py-2.5 text-left hover:bg-green-50 transition-colors flex items-center justify-between ${
                            index === 0 ? 'bg-green-50/50' : ''
                          }`}
                          onMouseDown={(e) => {
                            e.preventDefault(); // Prevent input blur
                            handleSelectPlayer(suggestion);
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                              <User className="w-4 h-4 text-green-600" />
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">{suggestion.player_name}</p>
                              {(suggestion.games_2025 > 0 ||
                                suggestion.games_played > 0) && (
                                <p className="text-xs text-gray-500">
                                  {suggestion.games_2025 > 0 ? (
                                    <>
                                      <span className="text-green-600 font-medium">
                                        {suggestion.games_2025} games 2025
                                      </span>
                                      {suggestion.games_played > 0 && (
                                        <> · {suggestion.games_played} career</>
                                      )}
                                    </>
                                  ) : (
                                    suggestion.games_played > 0 && <>{suggestion.games_played} career games</>
                                  )}
                                </p>
                              )}
                            </div>
                          </div>
                          {index === 0 && (
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded font-medium">
                              Best match
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Career Averages — shown once a player is selected */}
              {selectedPlayerId !== null && selectedPlayerId > 0 && (
                <PlayerCareerAverages
                  playerId={selectedPlayerId}
                  playerName={playerName}
                  size="md"
                  className="pt-1 pl-1"
                />
              )}
          </div>

            {/* From Season and To Season - Same Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Season From Field */}
              <div className="space-y-3 group">
                <Label htmlFor="seasonFrom" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-gray-600" />
                  From Season
                </Label>
                <Select
                  value={seasonFrom}
                  onValueChange={(value) => {
                    setSeasonFrom(value);
                    setActiveQuickSearchKey(null);
                    resetResults();
                  }}
                >
                  <SelectTrigger 
                    id="seasonFrom" 
                    className="h-12 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus:ring-2 focus:ring-green-600 focus:ring-offset-0 focus:border-green-600 hover:border-gray-400"
                  >
                    <SelectValue placeholder="Select season" />
                  </SelectTrigger>
                  <SelectContent>
                    {seasonOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option === 'any' ? 'Any' : option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Season To Field */}
              <div className="space-y-3 group">
                <Label htmlFor="seasonTo" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-gray-600" />
                  To Season
                </Label>
                <Select
                  value={seasonTo}
                  onValueChange={(value) => {
                    setSeasonTo(value);
                    setActiveQuickSearchKey(null);
                    resetResults();
                  }}
                >
                  <SelectTrigger 
                    id="seasonTo" 
                    className="h-12 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus:ring-2 focus:ring-green-600 focus:ring-offset-0 focus:border-green-600 hover:border-gray-400"
                  >
                    <SelectValue placeholder="Select season" />
                  </SelectTrigger>
                  <SelectContent>
                    {seasonOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option === 'any' ? 'Any' : option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
          </div>

            {/* Quick Search Section */}
          <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Label className="text-sm font-semibold text-gray-700">One Tap Search</Label>
                <span className="text-xs text-gray-500">(tap for instant results)</span>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                {([
                  { label: 'Goals', options: QUICK_GOAL_SEARCH },
                  { label: 'Disposals', options: QUICK_DISPOSAL_SEARCH },
                  { label: 'Tackles', options: QUICK_TACKLE_SEARCH },
                  { label: 'Marks', options: QUICK_MARK_SEARCH },
                ] as { label: string; options: QuickSearchOption[] }[]).map(({ label, options }) => (
                  <div key={label} className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold uppercase text-gray-500">{label}:</span>
                    <div className="flex flex-wrap gap-2">
                      {options.map((option) => {
                        const optionKey = buildQuickSearchKey(option);
                        const isActive = activeQuickSearchKey === optionKey;
                        return (
                          <Button
                            key={`${label.toLowerCase()}-${option.label}`}
                            type="button"
                            variant={isActive ? 'default' : 'outline'}
                            className={`h-8 px-3 text-xs font-semibold ${
                              isActive
                                ? 'bg-green-600 hover:bg-green-700 text-white border-green-600'
                                : 'text-gray-700 hover:border-green-500'
                            }`}
                            onClick={() => handleQuickSearch(option)}
                          >
                            {option.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Stat Type and Betting Line - Same Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Statistic Field */}
              <div className="space-y-3 group">
                <Label htmlFor="stat" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-gray-600" />
                  Statistic Type
                </Label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none z-10">
                    <BarChart3 className="w-5 h-5" />
                  </div>
            <Select
              value={stat}
              onValueChange={(value) => {
                      const nextStat = value as StatType;
                      setStat(nextStat);
                      setActiveQuickSearchKey(null);
                      setQuickSearchLabel(null);
                      if (nextStat === 'goals') {
                        const nextLine = goalLineSelection ?? DEFAULT_GOAL_LINE;
                        setGoalLineSelection(nextLine);
                        setThreshold(nextLine.threshold);
                        setBetMode('over_under');
                        setQuickSearchLabel(null);
                      } else if (nextStat === 'tackles') {
                        setThreshold('3.5');
                        setBetMode('over_under');
                        setQuickSearchLabel(null);
                      } else if (nextStat === 'marks') {
                        setThreshold('3.5');
                        setBetMode('over_under');
                        setQuickSearchLabel(null);
                      } else {
                        const nextLine = disposalLine || DEFAULT_DISPOSAL_LINE;
                        setThreshold(nextLine);
                        setDisposalLine(nextLine);
                        setBetMode('over_under');
                        setQuickSearchLabel(null);
                      }
                      resetResults();
                    }}
                  >
                    <SelectTrigger 
                      id="stat" 
                      className="h-12 pl-12 pr-10 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus:ring-2 focus:ring-green-600 focus:ring-offset-0 focus:border-green-600 hover:border-gray-400 [&>svg]:right-3"
                    >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disposals">Disposals</SelectItem>
                <SelectItem value="goals">Goals</SelectItem>
                <SelectItem value="tackles">Tackles</SelectItem>
                <SelectItem value="marks">Marks</SelectItem>
                <SelectItem value="kicks">Kicks</SelectItem>
                <SelectItem value="handballs">Handballs</SelectItem>
                <SelectItem value="clearances">Clearances</SelectItem>
                <SelectItem value="hit_outs">Hit-outs</SelectItem>
              </SelectContent>
            </Select>
                </div>
          </div>

              {/* Betting Line Field */}
              <div className="space-y-3 group">
                <Label htmlFor="threshold" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <Target className="w-4 h-4 text-gray-600" />
                  Betting Line
                </Label>
                {stat === 'goals' ? (
                  <Popover open={goalLineOpen} onOpenChange={setGoalLineOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        role="combobox"
                        aria-expanded={goalLineOpen}
                        className="h-12 w-full justify-between rounded border border-gray-300 bg-white text-base font-normal transition-all duration-200 hover:border-gray-400 focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-0 focus-visible:border-green-600"
                      >
                        <div className="flex flex-col items-start text-left">
                          <span className="text-sm font-semibold text-gray-900">
                            {goalLineSelection?.label ?? 'Select goal line'}
                          </span>
                          <span className="text-xs text-gray-500">
                            Over/Under line (0.5 increments)
                          </span>
                        </div>
                        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-60" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search goal lines..." />
                        <CommandList>
                          <CommandEmpty>No goal line found.</CommandEmpty>
                          {GOAL_LINE_GROUPS.map((group) => (
                            <CommandGroup key={group.label} heading={group.label}>
                              {group.options.map((option) => (
                                <CommandItem
                                  key={option.label}
                                  value={option.label}
                                  onSelect={() => {
                                    setGoalLineSelection(option);
                                    setThreshold(option.threshold);
                                    setBetMode('over_under');
                                    setActiveQuickSearchKey(null);
                                    setGoalLineOpen(false);
                                    resetResults();
                                  }}
                                >
                                  <div className="flex flex-col">
                                    <span className="text-sm font-semibold text-gray-900">{option.label}</span>
                                    <span className="text-xs text-muted-foreground">{option.description}</span>
                                  </div>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          ))}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                ) : (
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
                      <Target className="w-5 h-5" />
                    </div>
            <Input
              id="threshold"
              type="number"
              step="0.5"
                      min="0.5"
              value={threshold}
              onChange={(e) => {
                        const value = e.target.value;
                        setThreshold(value);
                        setDisposalLine(value);
                        setBetMode('over_under');
                        setQuickSearchLabel(null);
                        setActiveQuickSearchKey(null);
                        resetResults();
                      }}
                      onBlur={(e) => {
                        const formatted = applyThreshold(e.target.value);
                        setDisposalLine(formatted);
                        setBetMode('over_under');
                        setQuickSearchLabel(null);
                        setActiveQuickSearchKey(null);
              }}
              placeholder="e.g., 23.5"
                      className="h-12 pl-12 pr-4 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-0 focus-visible:border-green-600 hover:border-gray-400"
            />
                  </div>
                )}
              </div>
          </div>

            {/* Primary Submit Button */}
            <Button 
              type="submit" 
              disabled={nextGamePreloaded && nextGameLoading}
              className="w-full h-12 bg-green-600 hover:bg-green-700 text-white font-semibold rounded transition-colors"
              size="lg"
            >
              <span className="flex items-center justify-center gap-2">
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Searching...
                  </>
                ) : (
                  <>
                    <Search className="w-5 h-5" />
                    Search
                  </>
                )}
              </span>
            </Button>

            {/* More Filters Section */}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              {/* More Filters Header with Next Game Toggle - Same Row */}
              <div className="flex items-center justify-between p-3 bg-gray-50">
                {/* Clickable area for expand/collapse - takes up all space except Next Game toggle */}
                <button
                  type="button"
                  onClick={() => setMoreFiltersOpen(!moreFiltersOpen)}
                  className="flex-1 flex items-center gap-2 hover:bg-gray-100 rounded px-2 py-1 -ml-2 mr-3 transition-colors cursor-pointer"
                >
                  <SlidersHorizontal className="w-4 h-4 text-gray-600" />
                  <span className="text-sm font-semibold text-gray-700">More Filters</span>
                  <span className="text-xs text-gray-500">(Location, Venue, Opposition, Game Type)</span>
                  {moreFiltersOpen ? (
                    <ChevronUp className="w-4 h-4 text-gray-500 ml-auto" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-gray-500 ml-auto" />
                  )}
                </button>
                
                {/* Next Game Toggle - Right Side */}
                <div 
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border border-green-100 cursor-pointer flex-shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNextGameToggle(!nextGamePreloaded);
                  }}
                >
                  <span className="text-xs font-medium text-gray-700">Next Game</span>
                  <Switch
                    checked={nextGamePreloaded}
                    onCheckedChange={handleNextGameToggle}
                    aria-label="Toggle next game focus filters"
                    className="data-[state=checked]:bg-green-600 data-[state=unchecked]:bg-gray-300 scale-90"
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              </div>

              {nextFinalIncludesAll && <p className="px-4 py-2 text-xs text-emerald-800 bg-emerald-50">Next game is a final: results include regular season + finals. The player impact panel compares finals with the same-season regular-season baseline.</p>}
              {/* Collapsible Content */}
              {moreFiltersOpen && (
                <div className="p-4 space-y-4 border-t border-gray-200 animate-fade-in">
                  {/* Location and Venue - Same Row */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Location Field */}
                    <div className="space-y-3 group">
                      <Label htmlFor="location" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-gray-600" />
                        Location
                      </Label>
                      <Select
                        value={location}
                        onValueChange={(value: 'any' | 'home' | 'away') => {
                          setLocation(value);
                          setActiveQuickSearchKey(null);
                          setNextGamePreloaded(false);
                          resetResults();
                        }}
                      >
                        <SelectTrigger 
                          id="location" 
                          className="h-12 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus:ring-2 focus:ring-green-600 focus:ring-offset-0 focus:border-green-600 hover:border-gray-400"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">Any</SelectItem>
                          <SelectItem value="home">Home</SelectItem>
                          <SelectItem value="away">Away</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Venue Field */}
                    <div className="space-y-3 group">
                      <Label htmlFor="venue" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-gray-600" />
                        Venue
                      </Label>
                      <Select
                        value={venue}
                        onValueChange={(value) => {
                          setVenue(value);
                          setActiveQuickSearchKey(null);
                          setNextGamePreloaded(false);
                          resetResults();
                        }}
                      >
                        <SelectTrigger 
                          id="venue" 
                          className="h-12 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus:ring-2 focus:ring-green-600 focus:ring-offset-0 focus:border-green-600 hover:border-gray-400"
                        >
                          <SelectValue placeholder="Select venue" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">Any</SelectItem>
                          {AFL_VENUES.map((venueName) => (
                            <SelectItem key={venueName} value={venueName}>
                              {venueName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Opposition and Game Type - Same Row */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Opposition Field */}
                    <div className="space-y-3 group">
                      <Label htmlFor="opposition" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                        <Users className="w-4 h-4 text-gray-600" />
                        Opposition
                      </Label>
                      <Popover open={oppositionOpen} onOpenChange={setOppositionOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            aria-expanded={oppositionOpen}
                            className="h-12 w-full justify-between rounded border border-gray-300 bg-white text-base font-normal transition-all duration-200 hover:border-gray-400"
                          >
                            <span className={opposition ? "text-foreground" : "text-muted-foreground"}>
                              {opposition || "Select opposition team..."}
                            </span>
                            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search teams..." />
                            <CommandList>
                              <CommandEmpty>No team found.</CommandEmpty>
                              <CommandGroup>
                                <CommandItem
                                  value="any"
                                  onSelect={() => {
                                    setOpposition('');
                                    setActiveQuickSearchKey(null);
                                    setNextGamePreloaded(false);
                                    resetResults();
                                    setOppositionOpen(false);
                                  }}
                                >
                                  Any
                                </CommandItem>
                                {AFL_TEAMS.map((team) => (
                                  <CommandItem
                                    key={team}
                                    value={team}
                                    onSelect={() => {
                                      setOpposition(team);
                                      setActiveQuickSearchKey(null);
                                      setNextGamePreloaded(false);
                                      resetResults();
                                      setOppositionOpen(false);
                                    }}
                                  >
                                    {team}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>

                    {/* Game Type Field */}
                    <div className="space-y-3 group">
                      <Label htmlFor="gameType" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                        <Trophy className="w-4 h-4 text-gray-600" />
                        Game Type
                      </Label>
                      <Select
                        value={gameTypeFilter}
                        onValueChange={(value: 'regular' | 'finals' | 'all') => {
                          setGameType(value);
                          setActiveQuickSearchKey(null);
                          setNextGamePreloaded(false);
                          resetResults();
                        }}
                      >
                        <SelectTrigger
                          id="gameType"
                          className="h-12 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus:ring-2 focus:ring-green-600 focus:ring-offset-0 focus:border-green-600 hover:border-gray-400"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="regular">Regular Season (default)</SelectItem>
                          <SelectItem value="finals">Finals Only</SelectItem>
                          <SelectItem value="all">All (Regular + Finals)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Days Rest Field */}
                    <div className="space-y-3 group">
                      <Label htmlFor="daysRest" className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-gray-600" />
                        Days Rest
                      </Label>
                      <Select
                        value={daysRestBucket}
                        onValueChange={(value: 'any' | '5' | '6' | '7' | '8' | '9' | '10to14' | '15plus') => {
                          setDaysRestBucket(value);
                          setActiveQuickSearchKey(null);
                          setNextGamePreloaded(false);
                          resetResults();
                        }}
                      >
                        <SelectTrigger
                          id="daysRest"
                          className="h-12 rounded border border-gray-300 bg-white text-base transition-all duration-200 focus:ring-2 focus:ring-green-600 focus:ring-offset-0 focus:border-green-600 hover:border-gray-400"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="any">Any (default)</SelectItem>
                          <SelectItem value="5">5 days</SelectItem>
                          <SelectItem value="6">6 days</SelectItem>
                          <SelectItem value="7">7 days</SelectItem>
                          <SelectItem value="8">8 days</SelectItem>
                          <SelectItem value="9">9 days</SelectItem>
                          <SelectItem value="10to14">10–14 days</SelectItem>
                          <SelectItem value="15plus">15+ days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Secondary Submit Button inside More Filters */}
                  <Button 
                    type="submit" 
                    disabled={nextGamePreloaded && nextGameLoading}
                    className="w-full h-10 bg-green-600 hover:bg-green-700 text-white font-semibold rounded transition-colors"
                  >
                    <span className="flex items-center justify-center gap-2">
                      {loading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Searching...
                        </>
                      ) : (
                        <>
                          <Search className="w-4 h-4" />
                          Search
                        </>
                      )}
                    </span>
                  </Button>
                </div>
              )}
            </div>
              </form>
          </div>
        )}

          {rateLimitInfo && (
            <div className="mt-6 rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-amber-50 p-5 shadow-sm animate-fade-in">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="flex-1 space-y-2">
                  <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-600">
                    Too many searches at once
                  </p>
                  <h3 className="text-lg font-semibold text-gray-900">
                    Please wait before searching again.
                  </h3>
                  <p className="text-sm text-gray-600">
                    {rateLimitInfo.resetAt ? `Your next window starts ${formatResetTime(rateLimitInfo.resetAt)} (Melbourne time).` : 'Please wait a moment, then try again.'}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {SEARCH_DEFINITION_COPY}
                  </p>

                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <Alert variant="destructive" className="mt-6 animate-fade-in border-2 shadow-lg">
              <XCircle className="h-5 w-5" />
              <AlertTitle className="font-semibold">Error</AlertTitle>
              <AlertDescription className="mt-1 text-sm">{error}</AlertDescription>
            </Alert>
          )}

      </CardContent>
    </Card>
    </div>
  );
});

type ResultsTemplateProps = {
  title: string;
  loading: boolean;
  stats?: OverUnderResponse | null;
  seasonFrom: string;
  seasonTo: string;
  seasonLabel?: string;
  showSeasonMeta?: boolean;
  resultsFormat: ResultsFormat;
  marketLabel: string;
  isWinLossMode: boolean;
  positiveLabel: string;
  negativeLabel: string;
  percentageLabel: string;
  positiveGamesLabel: string;
  negativeGamesLabel: string;
  /**
   * When set, render this precomputed over/positive percentage instead of
   * deriving it from `stats` counts (used by the Multi tool, which combines
   * leg probabilities and has no single game count). Suppresses the raw-count
   * blocks since they would be meaningless for a combined probability.
   */
  overrideOverPercentage?: number;
  /** Replaces the "Sample Size: N Games" line (e.g. "combined across 3 legs"). */
  sampleLabel?: string;
};

export function ResultsTemplate({
  title,
  loading,
  stats,
  seasonFrom,
  seasonTo,
  seasonLabel,
  showSeasonMeta = true,
  resultsFormat,
  marketLabel,
  isWinLossMode,
  positiveLabel,
  negativeLabel,
  percentageLabel,
  positiveGamesLabel,
  negativeGamesLabel,
  overrideOverPercentage,
  sampleLabel,
}: ResultsTemplateProps) {
  const { screenshotMode } = useScreenshotMode();
  const hasOverride = overrideOverPercentage != null;
  // `ready` = there is something to render (real counts or a precomputed %).
  const ready = hasOverride || !!stats;
  // Raw game-count blocks only make sense for a real single search.
  const showCounts = !hasOverride;
  const totalGames = stats ? stats.over + stats.under : 0;
  const overPercentage = hasOverride
    ? (overrideOverPercentage as number)
    : totalGames > 0
      ? ((stats?.over || 0) / totalGames) * 100
      : 0;
  const underPercentage = hasOverride ? 100 - overPercentage : totalGames > 0 ? ((stats?.under || 0) / totalGames) * 100 : 0;
  const overBreakEven = overPercentage > 0 ? (100 / overPercentage).toFixed(2) : '0.00';
  const underBreakEven = underPercentage > 0 ? (100 / underPercentage).toFixed(2) : '0.00';
  const positiveAccentClass = isWinLossMode ? 'bg-emerald-700' : 'bg-blue-500';
  const negativeAccentClass = isWinLossMode ? 'bg-red-600' : 'bg-blue-700';
  const positiveGradient = isWinLossMode
    ? 'bg-gradient-to-r from-emerald-400 to-green-600'
    : 'bg-gradient-to-r from-blue-400 to-blue-600';
  const negativeGradient = isWinLossMode
    ? 'bg-gradient-to-r from-rose-400 to-red-600'
    : 'bg-gradient-to-r from-slate-400 to-slate-600';
  const showText = resultsFormat !== 'graphs';
  const showGraphs = resultsFormat !== 'text';
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-center gap-3 my-6">
        <div className="h-px flex-1 bg-gray-200"></div>
        <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 border border-gray-200 rounded">
          <CheckCircle2 className="w-4 h-4 text-green-600" />
          <span className="text-sm font-bold text-gray-900 uppercase tracking-wide">{title}</span>
        </div>
        <div className="h-px flex-1 bg-gray-200"></div>
      </div>

      <div className="flex items-center justify-between mb-6 px-2">
        <div className="text-sm text-gray-600 space-y-1">
          {showSeasonMeta && (
            <div>
              <span className="font-medium">Season:</span>{' '}
              {seasonLabel
                ? seasonLabel
                : `${seasonFrom === 'any' ? 'Any' : seasonFrom} to ${seasonTo === 'any' ? 'Any' : seasonTo}`}
            </div>
          )}
          <div>
            <span className="font-medium">Market:</span> {marketLabel}
            {isWinLossMode && <span className="text-xs text-gray-500 ml-1">(Win market)</span>}
          </div>
        </div>
        <div className="text-sm font-semibold text-gray-900">
          {loading && !stats ? (
            <Skeleton className="h-5 w-32" />
          ) : sampleLabel ? (
            <>{sampleLabel}</>
          ) : (
            <>Sample Size: {totalGames} {totalGames === 1 ? 'Game' : 'Games'}</>
          )}
        </div>
      </div>

      {showText && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <Card className="relative overflow-hidden border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow">
            <div className={`absolute top-0 left-0 right-0 h-1 ${positiveAccentClass}`}></div>
            <CardContent className="p-6 sm:p-8 relative z-10">
              <div className="flex items-center justify-between mb-4">
                <div className={`p-2 ${positiveAccentClass} rounded text-white`}>
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-gray-600 uppercase tracking-wider">
                    {positiveLabel}
                  </p>
                </div>
              </div>
              <div className="text-center mb-6 space-y-6">
                <div>
                  {loading && !stats ? (
                    <>
                      <Skeleton className="h-14 w-32 mx-auto mb-2" />
                      <Skeleton className="h-4 w-20 mx-auto" />
                    </>
                  ) : ready ? (
                    <>
                      <p className="text-4xl sm:text-5xl font-bold text-gray-900 mb-1">
                        {overPercentage.toFixed(1)}%
                      </p>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {percentageLabel}
                      </p>
                    </>
                  ) : null}
                </div>

                <div
                  className={`pt-4 border-t border-gray-200 bg-gray-50 rounded p-4 ${
                    screenshotMode ? 'invisible' : ''
                  }`}
                >
                  {loading && !stats ? (
                    <>
                      <Skeleton className="h-3 w-24 mx-auto mb-2" />
                      <Skeleton className="h-10 w-20 mx-auto mb-1" />
                      <Skeleton className="h-3 w-28 mx-auto" />
                    </>
                  ) : ready ? (
                    <>
                      <p className="text-xs font-bold text-gray-600 uppercase tracking-wider mb-2">
                        Break-Even Odds
                      </p>
                      <p className="text-2xl sm:text-3xl font-bold text-gray-900">
                        ${overBreakEven}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">Historical value</p>
                    </>
                  ) : null}
                </div>

                {showCounts && (
                  <div className="pt-4 border-t border-gray-200">
                    {loading && !stats ? (
                      <>
                        <Skeleton className="h-10 w-20 mx-auto mb-2" />
                        <Skeleton className="h-4 w-16 mx-auto" />
                      </>
                    ) : stats ? (
                      <>
                        <p className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1">
                          {stats.over}
                        </p>
                        <p className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                          {positiveGamesLabel}
                        </p>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="relative overflow-hidden border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow">
            <div className={`absolute top-0 left-0 right-0 h-1 ${negativeAccentClass}`}></div>
            <CardContent className="p-6 sm:p-8 relative z-10">
              <div className="flex items-center justify-between mb-4">
                <div className={`p-2 ${negativeAccentClass} rounded text-white`}>
                  <TrendingDown className="w-5 h-5" />
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-gray-600 uppercase tracking-wider">
                    {negativeLabel}
                  </p>
                </div>
              </div>
              <div className="text-center mb-6 space-y-6">
                <div>
                  {loading && !stats ? (
                    <>
                      <Skeleton className="h-14 w-32 mx-auto mb-2" />
                      <Skeleton className="h-4 w-20 mx-auto" />
                    </>
                  ) : ready ? (
                    <>
                      <p className="text-4xl sm:text-5xl font-bold text-gray-900 mb-1">
                        {underPercentage.toFixed(1)}%
                      </p>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {percentageLabel}
                      </p>
                    </>
                  ) : null}
                </div>

                <div
                  className={`pt-4 border-t border-gray-200 bg-gray-50 rounded p-4 ${
                    screenshotMode ? 'invisible' : ''
                  }`}
                >
                  {loading && !stats ? (
                    <>
                      <Skeleton className="h-3 w-24 mx-auto mb-2" />
                      <Skeleton className="h-10 w-20 mx-auto mb-1" />
                      <Skeleton className="h-3 w-28 mx-auto" />
                    </>
                  ) : ready ? (
                    <>
                      <p className="text-xs font-bold text-gray-600 uppercase tracking-wider mb-2">
                        Break-Even Odds
                      </p>
                      <p className="text-2xl sm:text-3xl font-bold text-gray-900">
                        ${underBreakEven}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">Historical value</p>
                    </>
                  ) : null}
                </div>

                {showCounts && (
                  <div className="pt-4 border-t border-gray-200">
                    {loading && !stats ? (
                      <>
                        <Skeleton className="h-10 w-20 mx-auto mb-2" />
                        <Skeleton className="h-4 w-16 mx-auto" />
                      </>
                    ) : stats ? (
                      <>
                        <p className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1">
                          {stats.under}
                        </p>
                        <p className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                          {negativeGamesLabel}
                        </p>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {showGraphs && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 sm:p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-[0.15em]">Result Distribution</p>
            {stats ? (
              <span className="text-xs font-medium text-gray-400">{totalGames} games</span>
            ) : sampleLabel ? (
              <span className="text-xs font-medium text-gray-400">{sampleLabel}</span>
            ) : null}
          </div>
          {loading && !stats ? (
            <div className="space-y-5">
              <Skeleton className="h-7 w-full rounded-xl" />
              <Skeleton className="h-7 w-full rounded-xl" />
            </div>
          ) : ready ? (
            <div className="space-y-6">
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-600">{positiveLabel}</span>
                  <span className="text-3xl font-black text-gray-900 tabular-nums leading-none">
                    {overPercentage.toFixed(1)}<span className="text-base font-semibold text-gray-400 ml-0.5">%</span>
                  </span>
                </div>
                <div className="h-7 w-full rounded-xl bg-gray-100 overflow-hidden">
                  <div className={`h-full rounded-xl ${positiveGradient}`} style={{ width: `${overPercentage}%` }} />
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  {showCounts ? (
                    <span className="text-xs text-gray-400">{stats?.over} {positiveGamesLabel}</span>
                  ) : (
                    <span />
                  )}
                  {!screenshotMode && <span className="text-xs text-gray-400">Break-even: ${overBreakEven}</span>}
                </div>
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-600">{negativeLabel}</span>
                  <span className="text-3xl font-black text-gray-900 tabular-nums leading-none">
                    {underPercentage.toFixed(1)}<span className="text-base font-semibold text-gray-400 ml-0.5">%</span>
                  </span>
                </div>
                <div className="h-7 w-full rounded-xl bg-gray-100 overflow-hidden">
                  <div className={`h-full rounded-xl ${negativeGradient}`} style={{ width: `${underPercentage}%` }} />
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  {showCounts ? (
                    <span className="text-xs text-gray-400">{stats?.under} {negativeGamesLabel}</span>
                  ) : (
                    <span />
                  )}
                  {!screenshotMode && <span className="text-xs text-gray-400">Break-even: ${underBreakEven}</span>}
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs text-gray-500">No stats yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

type WeightSliderProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  count: number;
  max: number;
  disabled?: boolean;
  percent?: number | null;
};

export function WeightSlider({ label, value, onChange, count, max, disabled, percent }: WeightSliderProps) {
  const percentLabel = percent === null || percent === undefined ? '--' : percent.toFixed(1);
  return (
    <div className={`rounded-lg border bg-white p-4 transition-colors ${disabled ? 'opacity-60 border-gray-200' : 'border-gray-200 hover:border-green-300'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-700">{label}</p>
          <p className="text-xs text-gray-500">{count} games</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Weight multiplier</p>
          <p className="text-sm font-bold text-gray-900">{value}%</p>
          <p className="text-xs text-gray-500">{percentLabel}% share</p>
        </div>
      </div>
      <div className="mt-3 h-2 w-full rounded-full bg-gray-100">
        <div
          className="h-2 rounded-full bg-green-600"
          style={{ width: `${Math.min(Math.max(percent ?? 0, 0), 100)}%` }}
        ></div>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(max, DEFAULT_WEIGHT_MULTIPLIER)}
        step={1}
        value={value}
        onChange={(e) => onChange(applyWeightSliderDetent(Number(e.target.value)))}
        disabled={disabled}
        className="mt-3 w-full accent-green-600"
      />
    </div>
  );
}
