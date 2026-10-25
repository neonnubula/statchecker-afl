import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { startResearch } from '@/lib/analytics-client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Plus,
  Search,
  Users,
  XCircle,
  Sparkles,
} from 'lucide-react';
import type { PlayerSuggestion, SgmRequest, SgmResponse, StatType } from '@/lib/api/types';
import { getSmartDefaultStat, isPartialSelection, shouldAutoAdvance } from '@/lib/sgm-selections.js';
import { ApiClientError, getFeaturedPlayers, getPlayerAutocomplete, getPlayerGameLog, gameLogRestParams, getSgmOutcomes, getTeamPlayers } from '@/lib/api/client';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { BarChart3, Calendar } from 'lucide-react';
import { SgmGameLog } from '@/components/SgmGameLog';
import SgmPlayerImpactResearch from '@/components/afl/SgmPlayerImpactResearch';
import { PlayerCareerAverages } from '@/components/PlayerCareerAverages';
import { fetchSavedPlayers, fetchSavedWeights, saveSearch, saveWeights } from '@/lib/vault/client';
import type { SavedPlayer, SavedWeight } from '@/lib/vault/types';
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

const CURRENT_SEASON = '2026';
const BASE_SEASON_OPTIONS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017'];
const SEASON_OPTIONS = [
  'any',
  CURRENT_SEASON,
  ...BASE_SEASON_OPTIONS.filter((season) => season !== CURRENT_SEASON),
];
const LAST_SEASON_YEAR = 2025;
const LAST_30_DAYS = 30;
const TOP_PLAYER_NAMES_2025 = FEATURED_PLAYER_NAMES;
const QUICK_GOAL_OPTIONS = [1, 2, 3, 4, 5, 6].map((count) => ({
  label: `${count}+`,
  threshold: count.toString(),
}));
const QUICK_DISPOSAL_OPTIONS = [15, 20, 25, 30, 35, 40].map((value) => ({
  label: `${value}+`,
  threshold: value.toString(),
}));
const QUICK_TACKLE_OPTIONS = [2, 3, 4, 5, 6, 7].map((value) => ({
  label: `${value}+`,
  threshold: value.toString(),
}));
const QUICK_MARK_OPTIONS = [2, 3, 4, 5, 6, 7].map((value) => ({
  label: `${value}+`,
  threshold: value.toString(),
}));
const MAX_SGM_SELECTIONS = 12;

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
  'Western Bulldogs',
];

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
  'Engie Stadium',
];

type SelectionRow = {
  id: string;
  playerName: string;
  playerId: number | null;
  teamId?: number | null;
  teamName?: string | null;
  stat: StatType | null;
  threshold: string;
  useQuickPicks: boolean;
};

type WeightedOutcome = {
  key: string;
  label: string;
  percent: number;
  count?: number;
  breakEven: string;
};

type NextGameInfo = {
  team: string;
  opponent: string;
  venue: string;
  location: 'home' | 'away';
  fixture: Fixture;
};

type RateLimitInfo = {
  reason?: string;
  bucket: 'sgm' | 'single';
  limit?: number;
  remaining?: number;
  resetAt?: number;
};

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

const PENDING_SEARCH_KEY = 'statchecker:pending-search';

const defaultSelection = (): SelectionRow => ({
  id: Math.random().toString(36).slice(2),
  playerName: '',
  playerId: null,
  teamId: null,
  teamName: null,
  stat: null,
  threshold: '23.5',
  useQuickPicks: true,
});

const formatOutcomeLines = (
  key: string,
  selections: SelectionRow[],
  betMode: 'over_under' | 'win_loss'
) => {
  if (betMode === 'win_loss') {
    return [key === 'win' ? 'All selections hit' : 'At least one miss'];
  }
  const parts = key.split('_');
  return parts.map((part, index) => {
    const selection = selections[index];
    if (!selection) {
      return part === 'over' ? 'Over' : 'Under';
    }
    const label = selection.stat === 'goals' ? 'Goals' : selection.stat === 'tackles' ? 'Tackles' : selection.stat === 'marks' ? 'Marks' : 'Disposals';
    const side = part === 'over' ? 'Over' : 'Under';
    return `${selection.playerName} ${side} ${selection.threshold} ${label}`;
  });
};

const formatOutcomeLabel = (
  key: string,
  selections: SelectionRow[],
  betMode: 'over_under' | 'win_loss'
) => {
  return formatOutcomeLines(key, selections, betMode).join(' / ');
};

const formatSelectionSummaryLabel = (selection: SelectionRow) => {
  const statLabel = selection.stat === 'goals' ? 'Goals' : selection.stat === 'tackles' ? 'Tackles' : selection.stat === 'marks' ? 'Marks' : 'Disposals';
  const nameLabel = selection.teamName
    ? `${selection.playerName}, ${selection.teamName}`
    : selection.playerName;
  const thresholdLabel = selection.threshold.trim();
  if (!thresholdLabel) {
    return nameLabel;
  }
  const thresholdValue = Number(thresholdLabel);
  const displayThreshold =
    Number.isFinite(thresholdValue) && Number.isInteger(thresholdValue)
      ? `${thresholdValue}+`
      : thresholdLabel;

  return `${nameLabel} (${displayThreshold} ${statLabel})`;
};

const getQuickOptions = (stat: StatType | null) => {
  if (!stat) return [];
  if (stat === 'goals') return QUICK_GOAL_OPTIONS;
  if (stat === 'tackles') return QUICK_TACKLE_OPTIONS;
  if (stat === 'marks') return QUICK_MARK_OPTIONS;
  return QUICK_DISPOSAL_OPTIONS;
};

export interface TeammateSgmDemoRef {
  addPlayerSelection: (playerName: string, teamId?: number, teamName?: string) => void;
}

export const TeammateSgmDemo = forwardRef<TeammateSgmDemoRef>(function TeammateSgmDemo(_, ref) {
  const { screenshotMode } = useScreenshotMode();
  const [selections, setSelections] = useState<SelectionRow[]>([
    defaultSelection(),
    defaultSelection(),
  ]);
  const [seasonFrom, setSeasonFrom] = useState('2025');
  const [seasonTo, setSeasonTo] = useState(CURRENT_SEASON);
  const [seasonOptions, setSeasonOptions] = useState<string[]>(SEASON_OPTIONS);
  const [location, setLocation] = useState<'any' | 'home' | 'away'>('any');
  const [opponent, setOpponent] = useState('any');
  const [venue, setVenue] = useState('any');
  const [gameType, setGameType] = useState<'regular' | 'finals' | 'all'>('regular');
  const [resultsFormat, setResultsFormat] = useState<'graphs' | 'text' | 'both'>('graphs');
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [weightedInfoOpen, setWeightedInfoOpen] = useState(false);
  const weightedInfoCloseTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoAppliedRef = useRef(false);

  const [stats, setStats] = useState<SgmResponse | null>(null);
  const [submittedSearch, setSubmittedSearch] = useState<{ request: SgmRequest; receipt?: string; expiresAt?: number } | null>(null);
  const [submittedTeamBSearch, setSubmittedTeamBSearch] = useState<{ request: SgmRequest; receipt?: string; expiresAt?: number } | null>(null);
  const searchGeneration = useRef(0);
  const contextOptions = useMemo(() => ({ purpose: 'context' as const, receipt: submittedSearch?.receipt, receiptExpiresAt: submittedSearch?.expiresAt }), [submittedSearch]);
  const teamBContextOptions = useMemo(() => ({ purpose: 'context' as const, receipt: submittedTeamBSearch?.receipt, receiptExpiresAt: submittedTeamBSearch?.expiresAt }), [submittedTeamBSearch]);
  const submittedLogSelections = useMemo(() => submittedSearch?.request.selections.map((selection) => ({
    playerName: selection.player_name ?? `Player #${selection.player_id}`,
    playerId: selection.player_id,
    stat: selection.stat,
    threshold: selection.threshold,
    strictOver: selection.strict_over,
  })) ?? [], [submittedSearch]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);
  const [usageInfo, setUsageInfo] = useState<(RateLimitMeta & { reason?: string }) | null>(null);
  const [isSavingSearch, setIsSavingSearch] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [isFormExpanded, setIsFormExpanded] = useState(false);
  const [pickMode, setPickMode] = useState<'top' | 'saved'>('top');
  const [savedPicks, setSavedPicks] = useState<SavedPlayer[]>([]);

  const [nextGameInfo, setNextGameInfo] = useState<NextGameInfo | null>(null);
  const [nextFinalFixture, setNextFinalFixture] = useState<Fixture | null>(null);
  const fixtureGeneration = useRef(0);
  const [nextGameLoading, setNextGameLoading] = useState(false);
  const [nextGameError, setNextGameError] = useState<string | null>(null);
  const [nextGamePreloaded, setNextGamePreloaded] = useState(true);
  const [nextGameResults, setNextGameResults] = useState<{
    opponent?: SgmResponse;
    location?: SgmResponse;
    venue?: SgmResponse;
  } | null>(null);
  const [nextGameResultsLoading, setNextGameResultsLoading] = useState(false);

  const [lastSeasonStats, setLastSeasonStats] = useState<SgmResponse | null>(null);
  const [lastSeasonLoading, setLastSeasonLoading] = useState(false);
  const [last30DaysStats, setLast30DaysStats] = useState<SgmResponse | null>(null);
  const [last30DaysLoading, setLast30DaysLoading] = useState(false);
  const [thisSeasonStats, setThisSeasonStats] = useState<SgmResponse | null>(null);
  const [thisSeasonLoading, setThisSeasonLoading] = useState(false);
  // Days-rest + career-view (precise mode). Days-rest is a contextual
  // bucket (e.g. "7 days rest") that contributes to the weighted blend.
  // Career view flips non-time-based cards to show lifetime numbers —
  // weighted algo still uses the season filter.
  const [daysRestBucket, setDaysRestBucket] = useState<'any' | '5' | '6' | '7' | '8' | '9' | '10to14' | '15plus'>('any');
  const [daysRestStats, setDaysRestStats] = useState<SgmResponse | null>(null);
  const [daysRestLoading, setDaysRestLoading] = useState(false);
  const [careerViewEnabled, setCareerViewEnabled] = useState(false);
  const [careerBaseStats, setCareerBaseStats] = useState<SgmResponse | null>(null);
  const [careerOpponentStats, setCareerOpponentStats] = useState<SgmResponse | null>(null);
  const [careerLocationStats, setCareerLocationStats] = useState<SgmResponse | null>(null);
  const [careerVenueStats, setCareerVenueStats] = useState<SgmResponse | null>(null);
  const [careerDaysRestStats, setCareerDaysRestStats] = useState<SgmResponse | null>(null);
  const [careerLoading, setCareerLoading] = useState(false);

  const [suggestions, setSuggestions] = useState<PlayerSuggestion[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [activeAutocompleteIndex, setActiveAutocompleteIndex] = useState<number | null>(null);
  const autocompleteDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const autocompleteCacheRef = useRef<Map<string, PlayerSuggestion[]>>(new Map());
  const [teamSuggestions, setTeamSuggestions] = useState<PlayerSuggestion[]>([]);
  const [isLoadingTeamSuggestions, setIsLoadingTeamSuggestions] = useState(false);
  const [teamBSuggestions, setTeamBSuggestions] = useState<PlayerSuggestion[]>([]);

  const [topPickSuggestions, setTopPickSuggestions] = useState<PlayerSuggestion[]>([]);
  const [isLoadingTopPicks, setIsLoadingTopPicks] = useState(false);
  const [showingTopPicks, setShowingTopPicks] = useState(false);

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

  const [sgmMode, setSgmMode] = useState<'precise' | 'loose'>('precise');

  // Team B (loose mode) state
  const [teamBStats, setTeamBStats] = useState<SgmResponse | null>(null);
  const [teamBNextGameInfo, setTeamBNextGameInfo] = useState<NextGameInfo | null>(null);
  const [teamBNextGameResults, setTeamBNextGameResults] = useState<{
    opponent?: SgmResponse;
    location?: SgmResponse;
    venue?: SgmResponse;
  } | null>(null);
  const [teamBNextGameResultsLoading, setTeamBNextGameResultsLoading] = useState(false);
  const [teamBLastSeasonStats, setTeamBLastSeasonStats] = useState<SgmResponse | null>(null);
  const [teamBLastSeasonLoading, setTeamBLastSeasonLoading] = useState(false);
  const [teamBLast30DaysStats, setTeamBLast30DaysStats] = useState<SgmResponse | null>(null);
  const [teamBLast30DaysLoading, setTeamBLast30DaysLoading] = useState(false);
  const [teamBThisSeasonStats, setTeamBThisSeasonStats] = useState<SgmResponse | null>(null);
  const [teamBThisSeasonLoading, setTeamBThisSeasonLoading] = useState(false);
  const [weightBBase, setWeightBBase] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightBOpponent, setWeightBOpponent] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightBLocation, setWeightBLocation] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightBVenue, setWeightBVenue] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightBLastSeason, setWeightBLastSeason] = useState(DEFAULT_LAST_SEASON_MULTIPLIER);
  const [weightBLast30Days, setWeightBLast30Days] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [weightBThisSeason, setWeightBThisSeason] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  // Team B days-rest + career-view state (loose mode). Each team derives its
  // own rest bucket from its own fixture, because Team A and Team B can have
  // different upcoming fixture dates. careerViewEnabled is shared across both
  // teams (one global toggle flips all non-time-based cards).
  const [daysRestBucketB, setDaysRestBucketB] = useState<'any' | '5' | '6' | '7' | '8' | '9' | '10to14' | '15plus'>('any');
  const [daysRestStatsB, setDaysRestStatsB] = useState<SgmResponse | null>(null);
  const [daysRestLoadingB, setDaysRestLoadingB] = useState(false);
  const [weightDaysRestB, setWeightDaysRestB] = useState(DEFAULT_WEIGHT_MULTIPLIER);
  const [careerBaseStatsB, setCareerBaseStatsB] = useState<SgmResponse | null>(null);
  const [careerOpponentStatsB, setCareerOpponentStatsB] = useState<SgmResponse | null>(null);
  const [careerLocationStatsB, setCareerLocationStatsB] = useState<SgmResponse | null>(null);
  const [careerVenueStatsB, setCareerVenueStatsB] = useState<SgmResponse | null>(null);
  const [careerDaysRestStatsB, setCareerDaysRestStatsB] = useState<SgmResponse | null>(null);
  const [careerLoadingB, setCareerLoadingB] = useState(false);

  const cleanupWeightedInfoTimeout = useCallback(() => {
    if (weightedInfoCloseTimeout.current) {
      clearTimeout(weightedInfoCloseTimeout.current);
      weightedInfoCloseTimeout.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cleanupWeightedInfoTimeout();
  }, [cleanupWeightedInfoTimeout]);

  useEffect(() => {
    let isMounted = true;
    const loadTopPicks = async () => {
      setIsLoadingTopPicks(true);
      try {
        const response = await getFeaturedPlayers(TOP_PLAYER_NAMES_2025, 2026);
        if (isMounted && response.suggestions.length > 0) {
          setTopPickSuggestions(response.suggestions);
          setShowingTopPicks(true);
        }
      } catch {
        if (isMounted) {
          setTopPickSuggestions(
            TOP_PLAYER_NAMES_2025.map((playerName, index) => ({
              player_id: -1 - index,
              player_name: playerName,
              games_played: 0,
              games_2025: 0,
              avg_disposals_2025: 0,
            }))
          );
          setShowingTopPicks(true);
        }
      } finally {
        if (isMounted) {
          setIsLoadingTopPicks(false);
        }
      }
    };

    loadTopPicks();
    return () => {
      isMounted = false;
    };
  }, []);

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

  useEffect(() => {
    if (pickMode === 'saved' && savedPickSuggestions.length === 0) {
      setShowingTopPicks(false);
      return;
    }
    if (pickMode === 'top' && topPickSuggestions.length === 0 && !isLoadingTopPicks) {
      setShowingTopPicks(false);
      return;
    }
    setShowingTopPicks(true);
  }, [pickMode, savedPickSuggestions.length, topPickSuggestions.length, isLoadingTopPicks]);

  const teamFilter = useMemo(() => {
    const withTeam = selections.find(
      (selection) => selection.teamId || selection.teamName || getPlayerTeam2025(selection.playerName)
    );
    return {
      id: withTeam?.teamId ?? null,
      name: withTeam?.teamName ?? getPlayerTeam2025(withTeam?.playerName ?? '') ?? null,
    };
  }, [selections]);

  const normalizeTeamName = useCallback((value?: string | null) => {
    return value ? value.trim().toLowerCase() : '';
  }, []);

  const teamBFilter = useMemo(() => {
    if (sgmMode !== 'loose' || !nextGameInfo) return { id: null, name: null };
    return { id: null, name: nextGameInfo.opponent };
  }, [sgmMode, nextGameInfo]);

  const teamBId = useMemo(() => {
    if (sgmMode !== 'loose' || !nextGameInfo) return null;
    const { fixture } = nextGameInfo;
    const isHome = fixture.home_team_name === nextGameInfo.team;
    return isHome ? fixture.away_team_id : fixture.home_team_id;
  }, [sgmMode, nextGameInfo]);

  const isSameTeam = useCallback(
    (teamId?: number | null, teamName?: string | null) => {
      if (!teamFilter.id && !teamFilter.name) {
        return true;
      }
      if (teamFilter.id && teamId && teamFilter.id === teamId) {
        return true;
      }
      if (teamFilter.name && teamName) {
        if (normalizeTeamName(teamFilter.name) === normalizeTeamName(teamName)) return true;
      }
      // Loose mode: also allow Team B (opponent) players
      if (sgmMode === 'loose' && teamBFilter.name && teamName &&
          normalizeTeamName(teamBFilter.name) === normalizeTeamName(teamName)) return true;
      return false;
    },
    [normalizeTeamName, teamFilter.id, teamFilter.name, sgmMode, teamBFilter.name]
  );

  useEffect(() => {
    let isMounted = true;
    if (!teamFilter.id) {
      setTeamSuggestions([]);
      return;
    }
    const loadTeamPlayers = async () => {
      setIsLoadingTeamSuggestions(true);
      try {
        const response = await getTeamPlayers(teamFilter.id, 50);
        if (isMounted) {
          setTeamSuggestions(response.suggestions);
        }
      } catch {
        if (isMounted) {
          setTeamSuggestions([]);
        }
      } finally {
        if (isMounted) {
          setIsLoadingTeamSuggestions(false);
        }
      }
    };
    loadTeamPlayers();
    return () => {
      isMounted = false;
    };
  }, [teamFilter.id]);

  useEffect(() => {
    let isMounted = true;
    if (!teamBId) {
      setTeamBSuggestions([]);
      return;
    }
    const load = async () => {
      try {
        const response = await getTeamPlayers(teamBId, 50);
        if (isMounted) setTeamBSuggestions(response.suggestions);
      } catch {
        if (isMounted) setTeamBSuggestions([]);
      }
    };
    void load();
    return () => {
      isMounted = false;
    };
  }, [teamBId]);

  const filteredTopPicks = useMemo(() => {
    const source = pickMode === 'saved' ? savedPickSuggestions : topPickSuggestions;
    if (!teamFilter.id) {
      return source;
    }
    // Loose mode: show picks from both matchup teams (Team A and Team B).
    if (sgmMode === 'loose') {
      return source.filter(
        (player) => player.team_id === teamFilter.id || (teamBId != null && player.team_id === teamBId)
      );
    }
    return source.filter((player) => player.team_id === teamFilter.id);
  }, [pickMode, savedPickSuggestions, teamFilter.id, topPickSuggestions, sgmMode, teamBId]);

  const activeTeamNames = useMemo(() => {
    const teamFromSelection = teamFilter.name ? [teamFilter.name] : [];
    const mappedTeams = selections
      .map((selection) => selection.teamName ?? getPlayerTeam2025(selection.playerName))
      .filter((team): team is string => Boolean(team));
    return Array.from(new Set([...teamFromSelection, ...mappedTeams]));
  }, [selections, teamFilter.name]);

  const teamASelections = useMemo(() => {
    if (sgmMode !== 'loose') return selections;
    return selections.filter((s) => {
      if (!s.playerName.trim()) return false;
      const teamName = s.teamName ?? getPlayerTeam2025(s.playerName);
      if (!teamFilter.name) return true;
      return normalizeTeamName(teamName) === normalizeTeamName(teamFilter.name);
    });
  }, [sgmMode, selections, teamFilter.name, normalizeTeamName]);

  const teamBSelections = useMemo(() => {
    if (sgmMode !== 'loose') return [];
    return selections.filter((s) => {
      if (!s.playerName.trim()) return false;
      const teamName = s.teamName ?? getPlayerTeam2025(s.playerName);
      if (!teamBFilter.name) return false;
      return normalizeTeamName(teamName) === normalizeTeamName(teamBFilter.name);
    });
  }, [sgmMode, selections, teamBFilter.name, normalizeTeamName]);

  const handleSelectionChange = useCallback(
    (index: number, patch: Partial<SelectionRow>) => {
      setSelections((prev) =>
        prev.map((selection, idx) => {
          if (idx !== index) {
            return selection;
          }
          const next = { ...selection, ...patch };
          const shouldReset = (patch.stat && next.stat && next.useQuickPicks) || patch.useQuickPicks === true;
          if (shouldReset) {
            const options = getQuickOptions(next.stat);
            if (options.length) {
              next.threshold = options[0].threshold;
            }
          }
          if (patch.playerName && !patch.playerId) {
            next.teamId = null;
            next.teamName = null;
          }
          return next;
        })
      );
    },
    []
  );

  const handleRemoveSelection = (index: number) => {
    setSelections((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleAddSelection = () => {
    setSelections((prev) => (prev.length >= MAX_SGM_SELECTIONS ? prev : [...prev, defaultSelection()]));
  };

  // Auto-append a blank selection when the last selection becomes complete (player + stat chosen)
  useEffect(() => {
    if (shouldAutoAdvance(selections, MAX_SGM_SELECTIONS)) {
      setSelections((prev) => [...prev, defaultSelection()]);
    }
  }, [selections]);

  const findSelectionTarget = () => {
    if (activeAutocompleteIndex !== null) {
      return activeAutocompleteIndex;
    }
    const emptyIndex = selections.findIndex((selection) => !selection.playerName.trim());
    return emptyIndex >= 0 ? emptyIndex : 0;
  };

  const handleTopPickSelect = (suggestion: PlayerSuggestion) => {
    const targetIndex = findSelectionTarget();
    if (!isSameTeam(suggestion.team_id ?? null, suggestion.team_name ?? null)) {
      setError(sgmMode === 'loose'
        ? 'In Loose Mode, selections must be from Team A or their next opponent.'
        : 'Selections must be from the same team.');
      return;
    }
    const smartStat = getSmartDefaultStat(
      suggestion.player_id > 0 ? suggestion.player_id : null,
      suggestion.player_name,
      selections,
      targetIndex
    );
    handleSelectionChange(targetIndex, {
      playerName: suggestion.player_name,
      playerId: suggestion.player_id > 0 ? suggestion.player_id : null,
      teamId: suggestion.team_id ?? null,
      teamName: suggestion.team_name ?? null,
      ...(smartStat ? { stat: smartStat as StatType } : {}),
    });
    setShowingTopPicks(false);
  };

  const handleAutocompleteSelect = (suggestion: PlayerSuggestion) => {
    if (activeAutocompleteIndex === null) {
      return;
    }
    if (!isSameTeam(suggestion.team_id ?? null, suggestion.team_name ?? null)) {
      setError(sgmMode === 'loose'
        ? 'In Loose Mode, selections must be from Team A or their next opponent.'
        : 'Selections must be from the same team.');
      return;
    }
    const smartStat = getSmartDefaultStat(
      suggestion.player_id,
      suggestion.player_name,
      selections,
      activeAutocompleteIndex
    );
    handleSelectionChange(activeAutocompleteIndex, {
      playerName: suggestion.player_name,
      playerId: suggestion.player_id,
      teamId: suggestion.team_id ?? null,
      teamName: suggestion.team_name ?? null,
      ...(smartStat ? { stat: smartStat as StatType } : {}),
    });
    setAutocompleteOpen(false);
    setSuggestions([]);
    setActiveAutocompleteIndex(null);
  };

  useEffect(() => {
    if (activeAutocompleteIndex === null) {
      return;
    }
    const value = selections[activeAutocompleteIndex]?.playerName ?? '';
    const normalizedQuery = value.trim().toLowerCase();
    // Loose mode: once the two fixture teams are resolved (at least Team A
    // established via a first pick or direct team-name mapping), filter
    // client-side from that pool. Before that — when no team is yet known —
    // fall through to the global autocomplete path below so the first pick
    // isn't impossible.
    if (sgmMode === 'loose' && (teamSuggestions.length > 0 || teamBSuggestions.length > 0)) {
      const pool = [...teamSuggestions, ...teamBSuggestions];
      const filtered = normalizedQuery.length
        ? pool.filter((player) => player.player_name.toLowerCase().includes(normalizedQuery))
        : pool;
      setSuggestions(filtered);
      setAutocompleteOpen(filtered.length > 0);
      return;
    }
    if (normalizedQuery.length < 2) {
      if (teamFilter.id) {
        const filtered = normalizedQuery.length
          ? teamSuggestions.filter((player) => player.player_name.toLowerCase().includes(normalizedQuery))
          : teamSuggestions;
        setSuggestions(filtered);
        setAutocompleteOpen(filtered.length > 0);
      } else {
        setSuggestions([]);
        setAutocompleteOpen(false);
      }
      return;
    }
    const cacheKey = `${teamFilter.id ?? 'all'}:${normalizedQuery}`;
    const cached = autocompleteCacheRef.current.get(cacheKey);
    if (cached) {
      setSuggestions(cached);
      setAutocompleteOpen(cached.length > 0);
      return;
    }
    if (autocompleteDebounceRef.current) {
      clearTimeout(autocompleteDebounceRef.current);
    }
    autocompleteDebounceRef.current = setTimeout(async () => {
      try {
        setIsLoadingSuggestions(true);
        const response = await getPlayerAutocomplete(value, 8, teamFilter.id ?? undefined, true);
        const filtered = teamFilter.name
          ? response.suggestions.filter(
              (s) => !s.team_name || normalizeTeamName(s.team_name) === normalizeTeamName(teamFilter.name)
            )
          : response.suggestions;
        autocompleteCacheRef.current.set(cacheKey, filtered);
        setSuggestions(filtered);
        setAutocompleteOpen(true);
      } catch {
        setSuggestions([]);
        setAutocompleteOpen(false);
      } finally {
        setIsLoadingSuggestions(false);
      }
    }, 120);
    return () => {
      if (autocompleteDebounceRef.current) {
        clearTimeout(autocompleteDebounceRef.current);
      }
    };
  }, [activeAutocompleteIndex, selections, teamFilter.id, teamSuggestions, sgmMode, teamBSuggestions]);

  const findNextFixtureForTeam = useCallback((fixtures: Fixture[], teamName: string) => {
    const normalizedTeam = teamName.trim().toLowerCase();
    return fixtures.find((fixture) => isSelectableFixture(fixture) && (
      fixture.home_team_name.toLowerCase() === normalizedTeam ||
      fixture.away_team_name.toLowerCase() === normalizedTeam
    ));
  }, []);

  const loadNextGameForTeam = useCallback(
    async (teamName: string) => {
      const generation = ++fixtureGeneration.current;
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
    [findNextFixtureForTeam]
  );

  useEffect(() => {
    if (!nextGamePreloaded) {
      fixtureGeneration.current += 1;
      setNextGameLoading(false);
      setNextGameInfo(null);
      setNextFinalFixture(null);
      setNextGameError(null);
      return;
    }
    // In loose mode always load for Team A (teamFilter.name), even when Team B players are selected
    const teamToLoad = sgmMode === 'loose' ? (teamFilter.name ?? null) : (activeTeamNames.length === 1 ? activeTeamNames[0] : null);
    if (teamToLoad) {
      void loadNextGameForTeam(teamToLoad);
    } else {
      fixtureGeneration.current += 1;
      setNextGameLoading(false);
      setNextGameInfo(null);
      setNextFinalFixture(null);
      setNextGameError(null);
    }
  }, [activeTeamNames, loadNextGameForTeam, nextGamePreloaded, sgmMode, teamFilter.name]);

  useEffect(() => {
    if (sgmMode !== 'loose' || !nextGameInfo) {
      setTeamBNextGameInfo(null);
      return;
    }
    setTeamBNextGameInfo({
      team: nextGameInfo.opponent,
      opponent: nextGameInfo.team,
      venue: nextGameInfo.venue,
      location: nextGameInfo.location === 'home' ? 'away' : 'home',
      fixture: nextGameInfo.fixture,
    });
  }, [sgmMode, nextGameInfo]);

  useEffect(() => {
    setSelections((prev) =>
      prev.map((selection) => {
        if (!selection.useQuickPicks) {
          return selection;
        }
        const options = getQuickOptions(selection.stat);
        if (!options.length) {
          return selection;
        }
        const isValid = options.some((option) => option.threshold === selection.threshold);
        if (isValid) {
          return selection;
        }
        return { ...selection, threshold: options[0].threshold };
      })
    );
  }, []);

  const derivedBetMode = useMemo(() => {
    const filledSelections = selections.filter((selection) => selection.playerName.trim());
    let hasDecimal = false;
    let hasInteger = false;
    filledSelections.forEach((selection) => {
      const value = Number(selection.threshold);
      if (!Number.isFinite(value)) {
        return;
      }
      if (Number.isInteger(value)) {
        hasInteger = true;
      } else {
        hasDecimal = true;
      }
    });
    if (hasDecimal && hasInteger) {
      return 'mixed';
    }
    return hasDecimal ? 'over_under' : 'win_loss';
  }, [selections]);

  const effectiveGameType = nextGameType(gameType, nextFinalFixture, nextGamePreloaded);
  const nextFinalIncludesAll = nextGamePreloaded && isUpcomingFinalFixture(nextFinalFixture);

  const buildRequest = useCallback(
    (overrides?: Partial<SgmRequest>) => {
      const filledSelections = selections.filter((selection) => selection.playerName.trim() && selection.stat);
      if (filledSelections.length < 2) {
        return null;
      }
      const selectionPayload = filledSelections.map((selection) => ({
        player_id: selection.playerId ?? undefined,
        player_name: selection.playerId ? undefined : selection.playerName.trim(),
        stat: selection.stat,
        threshold: Number(selection.threshold),
        strict_over: false,
      }));
      const request: SgmRequest = {
        selections: selectionPayload,
        bet_mode: derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode,
        season_from: seasonFrom === 'any' ? undefined : Number(seasonFrom),
        season_to: seasonTo === 'any' ? undefined : Number(seasonTo),
        location: location === 'any' ? undefined : location,
        opponent: opponent === 'any' ? undefined : opponent,
        venue: venue === 'any' ? undefined : venue,
        game_type: effectiveGameType,
      };
      return { ...request, ...overrides };
    },
    [derivedBetMode, effectiveGameType, location, opponent, seasonFrom, seasonTo, selections, venue]
  );

  const buildRequestForTeam = useCallback(
    (teamSelections: SelectionRow[], overrides?: Partial<SgmRequest>) => {
      const filledSelections = teamSelections.filter((s) => s.playerName.trim() && s.stat);
      if (filledSelections.length < 1) {
        return null;
      }
      const selectionPayload = filledSelections.map((selection) => ({
        player_id: selection.playerId ?? undefined,
        player_name: selection.playerId ? undefined : selection.playerName.trim(),
        stat: selection.stat,
        threshold: Number(selection.threshold),
        strict_over: false,
      }));
      const request: SgmRequest = {
        selections: selectionPayload,
        bet_mode: derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode,
        season_from: seasonFrom === 'any' ? undefined : Number(seasonFrom),
        season_to: seasonTo === 'any' ? undefined : Number(seasonTo),
        location: location === 'any' ? undefined : location,
        opponent: opponent === 'any' ? undefined : opponent,
        venue: venue === 'any' ? undefined : venue,
        game_type: effectiveGameType,
      };
      return { ...request, ...overrides };
    },
    [derivedBetMode, effectiveGameType, location, opponent, seasonFrom, seasonTo, venue]
  );

  const stripContextFilters = useCallback((request: SgmRequest) => {
    const { opponent: _opponent, venue: _venue, location: _location, ...rest } = request;
    return rest;
  }, []);

  const stripSeasonFilters = useCallback((request: SgmRequest) => {
    const { season_from: _seasonFrom, season_to: _seasonTo, date_from: _dateFrom, date_to: _dateTo, ...rest } =
      request;
    return rest;
  }, []);

  const daysRestFilter = useMemo(() => {
    switch (daysRestBucket) {
      case '5': return { min: 5, max: 5 };
      case '6': return { min: 6, max: 6 };
      case '7': return { min: 7, max: 7 };
      case '8': return { min: 8, max: 8 };
      case '9': return { min: 9, max: 9 };
      case '10to14': return { min: 10, max: 14 };
      case '15plus': return { min: 15, max: 30 };
      default: return undefined;
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

  const daysRestFilterB = useMemo(() => {
    switch (daysRestBucketB) {
      case '5': return { min: 5, max: 5 };
      case '6': return { min: 6, max: 6 };
      case '7': return { min: 7, max: 7 };
      case '8': return { min: 8, max: 8 };
      case '9': return { min: 9, max: 9 };
      case '10to14': return { min: 10, max: 14 };
      case '15plus': return { min: 15, max: 30 };
      default: return undefined;
    }
  }, [daysRestBucketB]);

  const daysRestLabelB = useMemo(() => {
    switch (daysRestBucketB) {
      case '5': return '5 days rest';
      case '6': return '6 days rest';
      case '7': return '7 days rest';
      case '8': return '8 days rest';
      case '9': return '9 days rest';
      case '10to14': return '10–14 days rest';
      case '15plus': return '15+ days rest';
      default: return '';
    }
  }, [daysRestBucketB]);

  const displayedResearch = useRef<{ tracker: ReturnType<typeof startResearch>; result: SgmResponse; count: number } | null>(null);
  useEffect(() => {
    const pending = displayedResearch.current;
    if (pending && stats === pending.result) {
      pending.tracker.viewed(pending.count);
      displayedResearch.current = null;
    }
  }, [stats]);

  const handleSearch = async () => {
    if (nextGamePreloaded && nextGameLoading) {
      setError('Checking the next fixture. Please try again in a moment.');
      return;
    }
    const generation = ++searchGeneration.current;
    setLoading(false);
    setSubmittedSearch(null);
    setSubmittedTeamBSearch(null);
    setHasSubmitted(false);
    setError(null);
    setRateLimitInfo(null);
    setUsageInfo(null);
    const partials = selections.filter(isPartialSelection);
    if (partials.length > 0) {
      setError('Complete or remove each partial selection before searching.');
      return;
    }
    if (derivedBetMode === 'mixed') {
      setError('Do not mix 1+ style lines with 23.5 style lines in the same search.');
      return;
    }

    if (sgmMode === 'loose') {
      // Loose mode: validate next game focus is on
      if (!nextGamePreloaded || !nextGameInfo) {
        setError('Enable Next Game Focus to use Loose Mode — Team B must be the upcoming opponent.');
        return;
      }
      if (teamASelections.length < 1 || teamBSelections.length < 1) {
        setError('In Loose Mode, add at least one selection from each team.');
        return;
      }
      const reqA = buildRequestForTeam(teamASelections);
      const reqB = buildRequestForTeam(teamBSelections);
      if (!reqA || !reqB) {
        setError('In Loose Mode, add at least one selection from each team.');
        return;
      }
      const invalidThreshold = [...reqA.selections, ...reqB.selections].some(
        (s) => !Number.isFinite(s.threshold)
      );
      if (invalidThreshold) {
        setError('Enter numeric thresholds for each selection.');
        return;
      }
      const research = startResearch('sgm');
      setLoading(true);
      try {
        const [teamAResult, teamBResult] = await Promise.all([
          getSgmOutcomes(reqA, { analyticsHeaders: research.headers, onRateLimit: (info) => { if (generation === searchGeneration.current) setUsageInfo(info); } }),
          getSgmOutcomes(reqB, { analyticsHeaders: research.headers, onRateLimit: (info) => { if (generation === searchGeneration.current) setUsageInfo(info); } }),
        ]);
        if (generation !== searchGeneration.current) return;
        setSubmittedSearch({ request: reqA, receipt: teamAResult.game_log_receipt, expiresAt: teamAResult.game_log_receipt_expires_at });
        setSubmittedTeamBSearch({ request: reqB, receipt: teamBResult.game_log_receipt, expiresAt: teamBResult.game_log_receipt_expires_at });
        displayedResearch.current = { tracker: research, result: teamAResult, count: teamAResult.total + teamBResult.total };
        setStats(teamAResult);
        setTeamBStats(teamBResult);
        setHasSubmitted(true);
        setIsFormExpanded(false);
      } catch (err) {
        if (generation !== searchGeneration.current) return;
        research.failed(err instanceof ApiClientError ? err.statusCode : undefined);
        setStats(null);
        setSubmittedSearch(null);
        setSubmittedTeamBSearch(null);
        setTeamBStats(null);
        setHasSubmitted(false);
        if (err instanceof ApiClientError && err.statusCode === 429) {
          setRateLimitInfo({
            bucket: 'sgm',
            limit: err.response?.rateLimit?.limit,
            remaining: err.response?.rateLimit?.remaining,
            resetAt: err.response?.rateLimit?.resetAt,
          reason: err.response?.rateLimit?.reason,
          });
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load results.');
        }
      } finally {
        if (generation === searchGeneration.current) setLoading(false);
      }
      return;
    }

    // Precise mode
    const request = buildRequest();
    if (!request) {
      setError('Add at least two teammate selections.');
      return;
    }
    const normalizedTeamNames = activeTeamNames.map(normalizeTeamName).filter(Boolean);
    const uniqueTeamNames = new Set(normalizedTeamNames);
    if (uniqueTeamNames.size > 1) {
      setError('Selections must be from the same team.');
      return;
    }
    const uniqueTeamIds = Array.from(
      new Set(selections.map((selection) => selection.teamId).filter((teamId) => teamId))
    );
    if (uniqueTeamIds.length > 1 && uniqueTeamNames.size === 0) {
      setError('Selections must be from the same team.');
      return;
    }
    const invalidThreshold = request.selections.some((selection) => !Number.isFinite(selection.threshold));
    if (invalidThreshold) {
      setError('Enter numeric thresholds for each selection.');
      return;
    }

    const research = startResearch('sgm');

    setLoading(true);
    try {
      const response = await getSgmOutcomes(request, {
        analyticsHeaders: research.headers,
        onRateLimit: (info) => { if (generation === searchGeneration.current) setUsageInfo(info); },
      });
      if (generation !== searchGeneration.current) return;
      setSubmittedSearch({ request, receipt: response.game_log_receipt, expiresAt: response.game_log_receipt_expires_at });
      displayedResearch.current = { tracker: research, result: response, count: response.total };
      setStats(response);
      setHasSubmitted(true);
      setIsFormExpanded(false);
    } catch (err) {
      if (generation !== searchGeneration.current) return;
      research.failed(err instanceof ApiClientError ? err.statusCode : undefined);
      setStats(null);
      setSubmittedSearch(null);
      setSubmittedTeamBSearch(null);
      setHasSubmitted(false);
      if (err instanceof ApiClientError && err.statusCode === 429) {
        setRateLimitInfo({
          bucket: 'sgm',
          limit: err.response?.rateLimit?.limit,
          remaining: err.response?.rateLimit?.remaining,
          resetAt: err.response?.rateLimit?.resetAt,
          reason: err.response?.rateLimit?.reason,
        });
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load results.');
      }
    } finally {
      if (generation === searchGeneration.current) setLoading(false);
    }
  };

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
      if (parsed?.type !== 'sgm') {
        return;
      }
      const payload = parsed.payload ?? {};
      const selectionsInput = Array.isArray(payload.selections) ? payload.selections : [];
      if (selectionsInput.length < 2) {
        return;
      }
      autoAppliedRef.current = true;
      window.localStorage.removeItem(PENDING_SEARCH_KEY);

      const mappedSelections = selectionsInput.map((selection: any) => ({
        id: Math.random().toString(36).slice(2),
        playerName: selection.player_name ?? '',
        playerId: selection.player_id ?? null,
        teamId: null,
        teamName: null,
        stat: selection.stat ?? 'disposals',
        threshold: String(selection.threshold ?? '23.5'),
        useQuickPicks: true,
      }));
      const paddedSelections =
        mappedSelections.length >= 2
          ? mappedSelections
          : [...mappedSelections, defaultSelection()];
      setSelections(paddedSelections);
      if (payload.season_from) {
        setSeasonFrom(String(payload.season_from));
      }
      if (payload.season_to) {
        setSeasonTo(String(payload.season_to));
      }
      if (payload.location) {
        setLocation(payload.location);
      }
      if (payload.opponent) {
        setOpponent(payload.opponent);
      }
      if (payload.venue) {
        setVenue(payload.venue);
      }
      if (payload.game_type) {
        setGameType(payload.game_type);
      }
      setIsFormExpanded(false);
      setTimeout(() => {
        void handleSearch();
      }, 50);
    } catch {
      // Ignore malformed payloads
    }
  }, [handleSearch]);

  const handleSaveSearch = async () => {
    const request = buildRequest();
    if (!request) {
      return;
    }
    setIsSavingSearch(true);
    try {
      await saveSearch({
        type: 'sgm',
        payload: request,
      });
    } finally {
      setIsSavingSearch(false);
    }
  };

  const handleAdjustSearch = () => {
    setIsFormExpanded(true);
  };

  const handleNewSearch = () => {
    fixtureGeneration.current += 1;
    setNextGameLoading(false);
    searchGeneration.current += 1;
    setLoading(false);
    setSelections([defaultSelection(), defaultSelection()]);
    setSeasonFrom('2025');
    setSeasonTo(CURRENT_SEASON);
    setSeasonOptions(SEASON_OPTIONS);
    setLocation('any');
    setOpponent('any');
    setVenue('any');
    setGameType('regular');
    setResultsFormat('graphs');
    setNextGamePreloaded(true);
    setNextGameInfo(null);
    setNextFinalFixture(null);
    setNextGameError(null);
    setNextGameResults(null);
    setNextGameResultsLoading(false);
    setLastSeasonStats(null);
    setLastSeasonLoading(false);
    setLast30DaysStats(null);
    setLast30DaysLoading(false);
    setWeightBase(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightOpponent(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightLocation(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightVenue(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightLastSeason(DEFAULT_LAST_SEASON_MULTIPLIER);
    setWeightLast30Days(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightsOpen(false);
    setWeightedInfoOpen(false);
    setWeightsPresetName('');
    setPickMode('top');
    setStats(null);
    setSubmittedSearch(null);
    setSubmittedTeamBSearch(null);
    setHasSubmitted(false);
    setError(null);
    setRateLimitInfo(null);
    setUsageInfo(null);
    setIsFormExpanded(true);
    // Reset Team B state
    setSgmMode('precise');
    setTeamBStats(null);
    setTeamBNextGameInfo(null);
    setTeamBNextGameResults(null);
    setTeamBNextGameResultsLoading(false);
    setTeamBLastSeasonStats(null);
    setTeamBLastSeasonLoading(false);
    setTeamBLast30DaysStats(null);
    setTeamBLast30DaysLoading(false);
    setTeamBThisSeasonStats(null);
    setTeamBThisSeasonLoading(false);
    setWeightBBase(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightBOpponent(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightBLocation(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightBVenue(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightBLastSeason(DEFAULT_LAST_SEASON_MULTIPLIER);
    setWeightBLast30Days(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightBThisSeason(DEFAULT_WEIGHT_MULTIPLIER);
    setWeightDaysRestB(DEFAULT_WEIGHT_MULTIPLIER);
    setDaysRestStatsB(null);
    setDaysRestLoadingB(false);
    setCareerBaseStatsB(null);
    setCareerOpponentStatsB(null);
    setCareerLocationStatsB(null);
    setCareerVenueStatsB(null);
    setCareerDaysRestStatsB(null);
    setCareerLoadingB(false);
  };

  const lastSeasonInRange = useMemo(() => {
    const from = submittedSearch?.request.season_from ?? -Infinity;
    const to = submittedSearch?.request.season_to ?? Infinity;
    return LAST_SEASON_YEAR >= from && LAST_SEASON_YEAR <= to;
  }, [submittedSearch]);

  const last30DaysInRange = useMemo(() => {
    const currentYear = Number(CURRENT_SEASON);
    const from = submittedSearch?.request.season_from ?? -Infinity;
    const to = submittedSearch?.request.season_to ?? Infinity;
    return currentYear >= from && currentYear <= to;
  }, [submittedSearch]);

  const activeLastSeasonStats = lastSeasonInRange ? lastSeasonStats : null;
  const activeLast30DaysStats = last30DaysInRange ? last30DaysStats : null;
  const thisSeasonInRange = last30DaysInRange; // both require current season (2026) to be in range
  const activeThisSeasonStats = thisSeasonInRange ? thisSeasonStats : null;

  const activeDaysRestStats = daysRestBucket === 'any' ? null : daysRestStats;

  const baseTotal = stats?.total ?? 0;
  const opponentTotal = nextGameResults?.opponent?.total ?? 0;
  const locationTotal = nextGameResults?.location?.total ?? 0;
  const venueTotal = nextGameResults?.venue?.total ?? 0;
  const lastSeasonTotal = activeLastSeasonStats?.total ?? 0;
  const last30DaysTotal = activeLast30DaysStats?.total ?? 0;
  const thisSeasonTotal = activeThisSeasonStats?.total ?? 0;
  const daysRestTotal = activeDaysRestStats?.total ?? 0;
  const maxWeight = MAX_WEIGHT_MULTIPLIER;
  const effectiveWeightBase = computeEffectiveWeight(baseTotal, weightBase);
  const effectiveWeightOpponent = computeEffectiveWeight(opponentTotal, weightOpponent);
  const effectiveWeightLocation = computeEffectiveWeight(locationTotal, weightLocation);
  const effectiveWeightVenue = computeEffectiveWeight(venueTotal, weightVenue);
  const effectiveWeightLastSeason = computeEffectiveWeight(lastSeasonTotal, weightLastSeason);
  const effectiveWeightLast30Days = computeEffectiveWeight(last30DaysTotal, weightLast30Days);
  const effectiveWeightThisSeason = computeEffectiveWeight(thisSeasonTotal, weightThisSeason);
  const effectiveWeightDaysRest = computeEffectiveWeight(daysRestTotal, weightDaysRest);

  const totalWeightForPercent = useMemo(() => {
    return (
      effectiveWeightBase +
      effectiveWeightOpponent +
      effectiveWeightLocation +
      effectiveWeightVenue +
      effectiveWeightLastSeason +
      effectiveWeightLast30Days +
      effectiveWeightThisSeason +
      effectiveWeightDaysRest
    );
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
      setWeightDaysRest(toWeightMultiplierFromTarget(targetDaysRest, daysRestTotal));
    },
    [
      baseTotal,
      opponentTotal,
      locationTotal,
      venueTotal,
      lastSeasonTotal,
      last30DaysTotal,
      thisSeasonTotal,
      daysRestTotal,
    ]
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
  }, [hasSubmitted, baseTotal, opponentTotal, locationTotal, venueTotal, lastSeasonTotal, last30DaysTotal, thisSeasonTotal, daysRestTotal]);

  const getOutcomePct = (statsInput?: SgmResponse | null) => {
    if (!statsInput || statsInput.total <= 0) {
      return null;
    }
    const pct: Record<string, number> = {};
    Object.entries(statsInput.outcomes).forEach(([key, count]) => {
      pct[key] = (count / statsInput.total) * 100;
    });
    return pct;
  };

  const outcomeKeys = useMemo(() => {
    const keySet = new Set<string>();
    [stats, nextGameResults?.opponent, nextGameResults?.location, nextGameResults?.venue, activeLastSeasonStats, activeLast30DaysStats, activeThisSeasonStats, activeDaysRestStats]
      .filter((entry): entry is SgmResponse => Boolean(entry))
      .forEach((entry) => {
        Object.keys(entry.outcomes).forEach((key) => keySet.add(key));
      });
    return Array.from(keySet);
  }, [stats, nextGameResults, activeLastSeasonStats, activeLast30DaysStats, activeThisSeasonStats, activeDaysRestStats]);

  const weightedOutcomes = useMemo(() => {
    const candidates = [
      { weight: effectiveWeightBase, outcomes: getOutcomePct(stats) },
      { weight: effectiveWeightOpponent, outcomes: getOutcomePct(nextGameResults?.opponent) },
      { weight: effectiveWeightLocation, outcomes: getOutcomePct(nextGameResults?.location) },
      { weight: effectiveWeightVenue, outcomes: getOutcomePct(nextGameResults?.venue) },
      { weight: effectiveWeightLastSeason, outcomes: getOutcomePct(activeLastSeasonStats) },
      { weight: effectiveWeightLast30Days, outcomes: getOutcomePct(activeLast30DaysStats) },
      { weight: effectiveWeightThisSeason, outcomes: getOutcomePct(activeThisSeasonStats) },
      { weight: effectiveWeightDaysRest, outcomes: getOutcomePct(activeDaysRestStats) },
    ].filter((item) => item.outcomes && item.weight > 0);

    if (!candidates.length) {
      return null;
    }

    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    const filledSelections = selections.filter((selection) => selection.playerName.trim());
    const weighted: WeightedOutcome[] = outcomeKeys.map((key) => {
      const weightedPct =
        candidates.reduce((sum, item) => sum + (item.outcomes?.[key] ?? 0) * item.weight, 0) / totalWeight;
      const breakEven = weightedPct > 0 ? (100 / weightedPct).toFixed(2) : '0.00';
      return {
        key,
        label: formatOutcomeLabel(key, filledSelections, derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode),
        percent: weightedPct,
        breakEven,
      };
    });

    return { totalWeight, outcomes: weighted };
  }, [
    outcomeKeys,
    selections,
    derivedBetMode,
    stats,
    nextGameResults,
    activeLastSeasonStats,
    activeLast30DaysStats,
    activeThisSeasonStats,
    activeDaysRestStats,
    effectiveWeightBase,
    effectiveWeightOpponent,
    effectiveWeightLocation,
    effectiveWeightVenue,
    effectiveWeightLastSeason,
    effectiveWeightLast30Days,
    effectiveWeightThisSeason,
    effectiveWeightDaysRest,
  ]);

  // Derived display values for career-view toggle. Used on the 5
  // non-time-based cards (Base, Home/Away, Venue, Opponent, Days Rest).
  const displayBaseStats = careerViewEnabled && careerBaseStats ? careerBaseStats : stats;
  const displayOpponentStats = careerViewEnabled && careerOpponentStats ? careerOpponentStats : nextGameResults?.opponent ?? null;
  const displayLocationStats = careerViewEnabled && careerLocationStats ? careerLocationStats : nextGameResults?.location ?? null;
  const displayVenueStats = careerViewEnabled && careerVenueStats ? careerVenueStats : nextGameResults?.venue ?? null;
  const displayDaysRestStats = careerViewEnabled && careerDaysRestStats ? careerDaysRestStats : activeDaysRestStats;

  // Team B weighted outcomes (loose mode)
  const activeDaysRestStatsB = daysRestBucketB === 'any' ? null : daysRestStatsB;
  const teamBBasTotal = teamBStats?.total ?? 0;
  const teamBOpponentTotal = teamBNextGameResults?.opponent?.total ?? 0;
  const teamBLocationTotal = teamBNextGameResults?.location?.total ?? 0;
  const teamBVenueTotal = teamBNextGameResults?.venue?.total ?? 0;
  const teamBLastSeasonTotal = (lastSeasonInRange ? teamBLastSeasonStats : null)?.total ?? 0;
  const teamBLast30DaysTotal = (last30DaysInRange ? teamBLast30DaysStats : null)?.total ?? 0;
  const teamBThisSeasonTotal = (thisSeasonInRange ? teamBThisSeasonStats : null)?.total ?? 0;
  const teamBDaysRestTotal = activeDaysRestStatsB?.total ?? 0;
  const effectiveWeightBBase = computeEffectiveWeight(teamBBasTotal, weightBBase);
  const effectiveWeightBOpponent = computeEffectiveWeight(teamBOpponentTotal, weightBOpponent);
  const effectiveWeightBLocation = computeEffectiveWeight(teamBLocationTotal, weightBLocation);
  const effectiveWeightBVenue = computeEffectiveWeight(teamBVenueTotal, weightBVenue);
  const effectiveWeightBLastSeason = computeEffectiveWeight(teamBLastSeasonTotal, weightBLastSeason);
  const effectiveWeightBLast30Days = computeEffectiveWeight(teamBLast30DaysTotal, weightBLast30Days);
  const effectiveWeightBThisSeason = computeEffectiveWeight(teamBThisSeasonTotal, weightBThisSeason);
  const effectiveWeightBDaysRest = computeEffectiveWeight(teamBDaysRestTotal, weightDaysRestB);
  const totalWeightBForPercent =
    effectiveWeightBBase + effectiveWeightBOpponent + effectiveWeightBLocation +
    effectiveWeightBVenue + effectiveWeightBLastSeason + effectiveWeightBLast30Days +
    effectiveWeightBThisSeason + effectiveWeightBDaysRest;

  const teamBOutcomeKeys = useMemo(() => {
    const keySet = new Set<string>();
    [teamBStats, teamBNextGameResults?.opponent, teamBNextGameResults?.location, teamBNextGameResults?.venue,
      lastSeasonInRange ? teamBLastSeasonStats : null, last30DaysInRange ? teamBLast30DaysStats : null,
      thisSeasonInRange ? teamBThisSeasonStats : null, activeDaysRestStatsB]
      .filter((e): e is SgmResponse => Boolean(e))
      .forEach((e) => Object.keys(e.outcomes).forEach((k) => keySet.add(k)));
    return Array.from(keySet);
  }, [teamBStats, teamBNextGameResults, teamBLastSeasonStats, teamBLast30DaysStats, teamBThisSeasonStats, lastSeasonInRange, last30DaysInRange, thisSeasonInRange, activeDaysRestStatsB]);

  const teamBWeightedOutcomes = useMemo(() => {
    if (sgmMode !== 'loose') return null;
    const candidates = [
      { weight: effectiveWeightBBase, outcomes: getOutcomePct(teamBStats) },
      { weight: effectiveWeightBOpponent, outcomes: getOutcomePct(teamBNextGameResults?.opponent) },
      { weight: effectiveWeightBLocation, outcomes: getOutcomePct(teamBNextGameResults?.location) },
      { weight: effectiveWeightBVenue, outcomes: getOutcomePct(teamBNextGameResults?.venue) },
      { weight: effectiveWeightBLastSeason, outcomes: getOutcomePct(lastSeasonInRange ? teamBLastSeasonStats : null) },
      { weight: effectiveWeightBLast30Days, outcomes: getOutcomePct(last30DaysInRange ? teamBLast30DaysStats : null) },
      { weight: effectiveWeightBThisSeason, outcomes: getOutcomePct(thisSeasonInRange ? teamBThisSeasonStats : null) },
      { weight: effectiveWeightBDaysRest, outcomes: getOutcomePct(activeDaysRestStatsB) },
    ].filter((item) => item.outcomes && item.weight > 0);
    if (!candidates.length) return null;
    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    const filledSelections = teamBSelections.filter((s) => s.playerName.trim());
    const betMode = derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode;
    const weighted: WeightedOutcome[] = teamBOutcomeKeys.map((key) => {
      const weightedPct = candidates.reduce((sum, item) => sum + (item.outcomes?.[key] ?? 0) * item.weight, 0) / totalWeight;
      const breakEven = weightedPct > 0 ? (100 / weightedPct).toFixed(2) : '0.00';
      return { key, label: formatOutcomeLabel(key, filledSelections, betMode), percent: weightedPct, breakEven };
    });
    return { totalWeight, outcomes: weighted };
  }, [sgmMode, teamBOutcomeKeys, teamBSelections, derivedBetMode, teamBStats, teamBNextGameResults,
    teamBLastSeasonStats, teamBLast30DaysStats, teamBThisSeasonStats, activeDaysRestStatsB, lastSeasonInRange, last30DaysInRange, thisSeasonInRange,
    effectiveWeightBBase, effectiveWeightBOpponent, effectiveWeightBLocation,
    effectiveWeightBVenue, effectiveWeightBLastSeason, effectiveWeightBLast30Days, effectiveWeightBThisSeason, effectiveWeightBDaysRest]);

  // Team B career-view display derivations.
  const displayBaseStatsB = careerViewEnabled && careerBaseStatsB ? careerBaseStatsB : teamBStats;
  const displayOpponentStatsB = careerViewEnabled && careerOpponentStatsB ? careerOpponentStatsB : teamBNextGameResults?.opponent ?? null;
  const displayLocationStatsB = careerViewEnabled && careerLocationStatsB ? careerLocationStatsB : teamBNextGameResults?.location ?? null;
  const displayVenueStatsB = careerViewEnabled && careerVenueStatsB ? careerVenueStatsB : teamBNextGameResults?.venue ?? null;
  const displayDaysRestStatsB = careerViewEnabled && careerDaysRestStatsB ? careerDaysRestStatsB : activeDaysRestStatsB;

  const looseModeCombinedOutcomes = useMemo(() => {
    if (sgmMode !== 'loose') return null;
    const teamAMap = weightedOutcomes?.outcomes ?? null;
    const teamBMap = teamBWeightedOutcomes?.outcomes ?? null;
    if (!teamAMap || !teamBMap || teamAMap.length === 0 || teamBMap.length === 0) return null;

    // For win_loss mode (all-integer thresholds like 30+ / 20+), each side
    // already has just 'win' / 'loss' outcomes — the SGM bet is a single
    // yes/no, so collapse to "All selections hit" / "One or more misses".
    //
    // For over_under mode (any decimal threshold like 23.5), both over and
    // under lines are real markets the user might bet, so show the full
    // cartesian product of outcomes the same way precise mode does.
    const effectiveMode = derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode;

    if (effectiveMode === 'win_loss') {
      const winA = teamAMap.find((o) => o.key === 'win');
      const winB = teamBMap.find((o) => o.key === 'win');
      if (!winA || !winB) return null;
      const allHitPct = (winA.percent / 100) * (winB.percent / 100) * 100;
      return [
        { key: 'all_hit', labelA: 'All selections hit', labelB: '', percent: allHitPct },
        { key: 'one_or_more_miss', labelA: 'One or more misses', labelB: '', percent: Math.max(0, 100 - allHitPct) },
      ];
    }

    // over_under (or mixed): full cartesian product.
    const combined: { key: string; labelA: string; labelB: string; percent: number }[] = [];
    for (const outA of teamAMap) {
      for (const outB of teamBMap) {
        combined.push({
          key: `${outA.key}__${outB.key}`,
          labelA: outA.label,
          labelB: outB.label,
          percent: (outA.percent / 100) * (outB.percent / 100) * 100,
        });
      }
    }
    combined.sort((a, b) => b.percent - a.percent);
    return combined;
  }, [sgmMode, weightedOutcomes, teamBWeightedOutcomes, derivedBetMode]);

  const openWeightedInfo = () => {
    cleanupWeightedInfoTimeout();
    setWeightedInfoOpen(true);
  };

  const scheduleWeightedInfoClose = () => {
    cleanupWeightedInfoTimeout();
    weightedInfoCloseTimeout.current = setTimeout(() => {
      setWeightedInfoOpen(false);
      weightedInfoCloseTimeout.current = null;
    }, 150);
  };

  // Each accepted team result owns its context; clear earlier context immediately.
  useEffect(() => {
    setNextGameResults(null);
    setNextGameResultsLoading(false);
    setLastSeasonStats(null);
    setLastSeasonLoading(false);
    setLast30DaysStats(null);
    setLast30DaysLoading(false);
    setThisSeasonStats(null);
    setThisSeasonLoading(false);
    setDaysRestStats(null);
    setDaysRestLoading(false);
  }, [submittedSearch]);

  useEffect(() => {
    setTeamBNextGameResults(null);
    setTeamBNextGameResultsLoading(false);
    setTeamBLastSeasonStats(null);
    setTeamBLastSeasonLoading(false);
    setTeamBLast30DaysStats(null);
    setTeamBLast30DaysLoading(false);
    setTeamBThisSeasonStats(null);
    setTeamBThisSeasonLoading(false);
    setDaysRestStatsB(null);
    setDaysRestLoadingB(false);
  }, [submittedTeamBSearch]);

  useEffect(() => {
    let cancelled = false;
    if (!hasSubmitted || !submittedSearch?.receipt) {
      return;
    }
    const request = submittedSearch.request;
    if (!request || !nextGameInfo || !nextGamePreloaded) {
      return;
    }
    setNextGameResultsLoading(true);
    Promise.all([
      getSgmOutcomes({ ...request, opponent: nextGameInfo.opponent }, contextOptions),
      getSgmOutcomes({ ...request, location: nextGameInfo.location }, contextOptions),
      getSgmOutcomes({ ...request, venue: nextGameInfo.venue }, contextOptions),
    ])
      .then(([opponentStats, locationStats, venueStats]) => {
        if (cancelled) return;
        setNextGameResults({ opponent: opponentStats, location: locationStats, venue: venueStats });
      })
      .catch(() => {
        if (cancelled) return;
        setNextGameResults(null);
      })
      .finally(() => {
        if (cancelled) return;
        setNextGameResultsLoading(false);
      });
    return () => { cancelled = true; };
  }, [submittedSearch, contextOptions, hasSubmitted, nextGameInfo, nextGamePreloaded]);

  useEffect(() => {
    let cancelled = false;
    if (!hasSubmitted || !submittedSearch?.receipt) {
      return;
    }
    const request = submittedSearch.request;
    if (!request) {
      return;
    }

    if (lastSeasonInRange) {
      const lastSeasonRequest = {
        ...request,
        season_from: LAST_SEASON_YEAR,
        season_to: LAST_SEASON_YEAR,
      };
      setLastSeasonLoading(true);
      getSgmOutcomes(lastSeasonRequest, contextOptions)
        .then((data) => { if (!cancelled) setLastSeasonStats(data); })
        .catch(() => { if (!cancelled) setLastSeasonStats(null); })
        .finally(() => { if (!cancelled) setLastSeasonLoading(false); });
    } else {
      setLastSeasonStats(null);
      setLastSeasonLoading(false);
    }

    if (last30DaysInRange) {
      const today = new Date();
      const dateTo = today.toISOString().split('T')[0];
      const dateFromDate = new Date(today);
      dateFromDate.setDate(today.getDate() - LAST_30_DAYS);
      const dateFrom = dateFromDate.toISOString().split('T')[0];
      const last30Request = {
        ...request,
        season_from: undefined,
        season_to: undefined,
        date_from: dateFrom,
        date_to: dateTo,
      };
      setLast30DaysLoading(true);
      getSgmOutcomes(last30Request, contextOptions)
        .then((data) => { if (!cancelled) setLast30DaysStats(data); })
        .catch(() => { if (!cancelled) setLast30DaysStats(null); })
        .finally(() => { if (!cancelled) setLast30DaysLoading(false); });
    } else {
      setLast30DaysStats(null);
      setLast30DaysLoading(false);
    }

    if (thisSeasonInRange) {
      const thisSeasonRequest = {
        ...request,
        season_from: Number(CURRENT_SEASON),
        season_to: Number(CURRENT_SEASON),
      };
      setThisSeasonLoading(true);
      getSgmOutcomes(thisSeasonRequest, contextOptions)
        .then((data) => { if (!cancelled) setThisSeasonStats(data); })
        .catch(() => { if (!cancelled) setThisSeasonStats(null); })
        .finally(() => { if (!cancelled) setThisSeasonLoading(false); });
    } else {
      setThisSeasonStats(null);
      setThisSeasonLoading(false);
    }

    if (daysRestFilter) {
      const daysRestRequest = {
        ...request,
        days_rest_min: daysRestFilter.min,
        days_rest_max: daysRestFilter.max,
      };
      setDaysRestLoading(true);
      getSgmOutcomes(daysRestRequest, contextOptions)
        .then((data) => { if (!cancelled) setDaysRestStats(data); })
        .catch(() => { if (!cancelled) setDaysRestStats(null); })
        .finally(() => { if (!cancelled) setDaysRestLoading(false); });
    } else {
      setDaysRestStats(null);
      setDaysRestLoading(false);
    }
    return () => { cancelled = true; };
  }, [submittedSearch, contextOptions, hasSubmitted, lastSeasonInRange, last30DaysInRange, thisSeasonInRange, daysRestFilter]);

  // Auto-derive days-rest bucket from the upcoming fixture for the first
  // filled selection (matches backend SGM behaviour which applies the rest
  // filter to p1 — the first player in the selections list).
  useEffect(() => {
    const fixtureDateStr = nextGameInfo?.fixture.game_date;
    const firstFilledSelection = submittedSearch?.request.selections[0];
    if (!hasSubmitted || !submittedSearch?.receipt || !firstFilledSelection || !fixtureDateStr) {
      return;
    }
    const fixtureDate = new Date(fixtureDateStr);
    if (Number.isNaN(fixtureDate.getTime())) return;

    let cancelled = false;
    (async () => {
      try {
        const log = await getPlayerGameLog(
          gameLogRestParams(firstFilledSelection),
          { purpose: 'context', receipt: submittedSearch.receipt, receiptExpiresAt: submittedSearch.expiresAt }
        );
        if (cancelled || log.games.length === 0) return;
        const priorGames = log.games
          .filter((g) => new Date(g.game_date) < fixtureDate)
          .sort((a, b) => (a.game_date < b.game_date ? 1 : -1));
        if (!priorGames.length) return;
        const lastGameDate = new Date(priorGames[0].game_date);
        const diffDays = Math.round(
          (fixtureDate.getTime() - lastGameDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        let bucket: typeof daysRestBucket = 'any';
        if (diffDays === 5) bucket = '5';
        else if (diffDays === 6) bucket = '6';
        else if (diffDays === 7) bucket = '7';
        else if (diffDays === 8) bucket = '8';
        else if (diffDays === 9) bucket = '9';
        else if (diffDays >= 10 && diffDays <= 14) bucket = '10to14';
        else if (diffDays >= 15 && diffDays <= 30) bucket = '15plus';
        if (!cancelled && bucket !== 'any') setDaysRestBucket(bucket);
      } catch {
        // silent fail
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasSubmitted, nextGameInfo, submittedSearch]);

  // Career-view fetch: when toggle is on, fetch the 5 non-time-based
  // context cards with season stripped so they show lifetime numbers.
  // Weighted algo keeps using season-filtered data from above.
  useEffect(() => {
    if (!careerViewEnabled || !hasSubmitted || !submittedSearch?.receipt) {
      return;
    }
    const request = submittedSearch.request;
    if (!request) return;
    const careerBaseRequest = stripSeasonFilters(stripContextFilters(request)) as SgmRequest;

    let cancelled = false;
    setCareerLoading(true);

    const basePromise = getSgmOutcomes(careerBaseRequest, contextOptions);
    const opponentPromise = nextGameInfo
      ? getSgmOutcomes({ ...careerBaseRequest, opponent: nextGameInfo.opponent }, contextOptions)
      : Promise.resolve(null as SgmResponse | null);
    const locationPromise = nextGameInfo
      ? getSgmOutcomes({ ...careerBaseRequest, location: nextGameInfo.location }, contextOptions)
      : Promise.resolve(null as SgmResponse | null);
    const venuePromise = nextGameInfo
      ? getSgmOutcomes({ ...careerBaseRequest, venue: nextGameInfo.venue }, contextOptions)
      : Promise.resolve(null as SgmResponse | null);
    const daysRestPromise = daysRestFilter
      ? getSgmOutcomes(
          { ...careerBaseRequest, days_rest_min: daysRestFilter.min, days_rest_max: daysRestFilter.max },
          contextOptions
        )
      : Promise.resolve(null as SgmResponse | null);

    Promise.all([basePromise, opponentPromise, locationPromise, venuePromise, daysRestPromise])
      .then(([base, opponentStats, locationStats, venueStats, rest]) => {
        if (cancelled) return;
        setCareerBaseStats(base ?? null);
        setCareerOpponentStats(opponentStats ?? null);
        setCareerLocationStats(locationStats ?? null);
        setCareerVenueStats(venueStats ?? null);
        setCareerDaysRestStats(rest ?? null);
      })
      .catch(() => {
        // silent fail — season-filtered cards keep showing
      })
      .finally(() => {
        if (!cancelled) setCareerLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [careerViewEnabled, hasSubmitted, submittedSearch, contextOptions, nextGameInfo, daysRestFilter, stripContextFilters, stripSeasonFilters]);

  // Invalidate career cache when search changes.
  useEffect(() => {
    setCareerBaseStats(null);
    setCareerOpponentStats(null);
    setCareerLocationStats(null);
    setCareerVenueStats(null);
    setCareerDaysRestStats(null);
  }, [submittedSearch]);

  // Team B context effects (loose mode only)
  useEffect(() => {
    let cancelled = false;
    if (!hasSubmitted || !submittedTeamBSearch?.receipt) {
      setTeamBNextGameResults(null);
      setTeamBNextGameResultsLoading(false);
      return;
    }
    if (!teamBNextGameInfo) return;
    const reqB = submittedTeamBSearch.request;
    if (!reqB) return;
    setTeamBNextGameResultsLoading(true);
    Promise.all([
      getSgmOutcomes({ ...reqB, opponent: teamBNextGameInfo.opponent }, teamBContextOptions),
      getSgmOutcomes({ ...reqB, location: teamBNextGameInfo.location }, teamBContextOptions),
      getSgmOutcomes({ ...reqB, venue: teamBNextGameInfo.venue }, teamBContextOptions),
    ])
      .then(([opponentStats, locationStats, venueStats]) => {
        if (cancelled) return;
        setTeamBNextGameResults({ opponent: opponentStats, location: locationStats, venue: venueStats });
      })
      .catch(() => { if (!cancelled) setTeamBNextGameResults(null); })
      .finally(() => { if (!cancelled) setTeamBNextGameResultsLoading(false); });
    return () => { cancelled = true; };
  }, [submittedTeamBSearch, teamBContextOptions, hasSubmitted, teamBNextGameInfo]);

  useEffect(() => {
    let cancelled = false;
    if (!hasSubmitted || !submittedTeamBSearch?.receipt) {
      setTeamBLastSeasonStats(null);
      setTeamBLastSeasonLoading(false);
      setTeamBLast30DaysStats(null);
      setTeamBLast30DaysLoading(false);
      return;
    }
    const reqB = submittedTeamBSearch.request;
    if (!reqB) return;

    if (lastSeasonInRange) {
      setTeamBLastSeasonLoading(true);
      getSgmOutcomes({ ...reqB, season_from: LAST_SEASON_YEAR, season_to: LAST_SEASON_YEAR }, teamBContextOptions)
        .then((data) => { if (!cancelled) setTeamBLastSeasonStats(data); })
        .catch(() => { if (!cancelled) setTeamBLastSeasonStats(null); })
        .finally(() => { if (!cancelled) setTeamBLastSeasonLoading(false); });
    } else {
      setTeamBLastSeasonStats(null);
      setTeamBLastSeasonLoading(false);
    }

    if (last30DaysInRange) {
      const today = new Date();
      const dateTo = today.toISOString().split('T')[0];
      const dateFromDate = new Date(today);
      dateFromDate.setDate(today.getDate() - LAST_30_DAYS);
      const dateFrom = dateFromDate.toISOString().split('T')[0];
      setTeamBLast30DaysLoading(true);
      getSgmOutcomes(
        { ...reqB, season_from: undefined, season_to: undefined, date_from: dateFrom, date_to: dateTo },
        teamBContextOptions
      )
        .then((data) => { if (!cancelled) setTeamBLast30DaysStats(data); })
        .catch(() => { if (!cancelled) setTeamBLast30DaysStats(null); })
        .finally(() => { if (!cancelled) setTeamBLast30DaysLoading(false); });
    } else {
      setTeamBLast30DaysStats(null);
      setTeamBLast30DaysLoading(false);
    }

    if (thisSeasonInRange) {
      setTeamBThisSeasonLoading(true);
      getSgmOutcomes(
        { ...reqB, season_from: Number(CURRENT_SEASON), season_to: Number(CURRENT_SEASON) },
        teamBContextOptions
      )
        .then((data) => { if (!cancelled) setTeamBThisSeasonStats(data); })
        .catch(() => { if (!cancelled) setTeamBThisSeasonStats(null); })
        .finally(() => { if (!cancelled) setTeamBThisSeasonLoading(false); });
    } else {
      setTeamBThisSeasonStats(null);
      setTeamBThisSeasonLoading(false);
    }
    return () => { cancelled = true; };
  }, [submittedTeamBSearch, teamBContextOptions, hasSubmitted, lastSeasonInRange, last30DaysInRange, thisSeasonInRange]);

  // Team B days-rest fetch (loose mode only).
  useEffect(() => {
    let cancelled = false;
    if (!hasSubmitted || !submittedTeamBSearch?.receipt || !daysRestFilterB) {
      setDaysRestStatsB(null);
      setDaysRestLoadingB(false);
      return;
    }
    const reqB = submittedTeamBSearch.request;
    if (!reqB) return;
    setDaysRestLoadingB(true);
    getSgmOutcomes(
      { ...reqB, days_rest_min: daysRestFilterB.min, days_rest_max: daysRestFilterB.max },
      teamBContextOptions
    )
      .then((data) => { if (!cancelled) setDaysRestStatsB(data); })
      .catch(() => { if (!cancelled) setDaysRestStatsB(null); })
      .finally(() => { if (!cancelled) setDaysRestLoadingB(false); });
    return () => { cancelled = true; };
  }, [submittedTeamBSearch, teamBContextOptions, hasSubmitted, daysRestFilterB]);

  // Team B auto-derive days-rest bucket from teamBNextGameInfo (loose mode).
  useEffect(() => {
    const fixtureDateStr = teamBNextGameInfo?.fixture.game_date;
    const firstFilledB = submittedTeamBSearch?.request.selections[0];
    if (!hasSubmitted || !submittedTeamBSearch?.receipt || !submittedTeamBSearch?.receipt || !firstFilledB || !fixtureDateStr) {
      return;
    }
    const fixtureDate = new Date(fixtureDateStr);
    if (Number.isNaN(fixtureDate.getTime())) return;

    let cancelled = false;
    (async () => {
      try {
        const log = await getPlayerGameLog(
          gameLogRestParams(firstFilledB),
          { purpose: 'context', receipt: submittedTeamBSearch.receipt, receiptExpiresAt: submittedTeamBSearch.expiresAt }
        );
        if (cancelled || log.games.length === 0) return;
        const priorGames = log.games
          .filter((g) => new Date(g.game_date) < fixtureDate)
          .sort((a, b) => (a.game_date < b.game_date ? 1 : -1));
        if (!priorGames.length) return;
        const lastGameDate = new Date(priorGames[0].game_date);
        const diffDays = Math.round(
          (fixtureDate.getTime() - lastGameDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        let bucket: typeof daysRestBucketB = 'any';
        if (diffDays === 5) bucket = '5';
        else if (diffDays === 6) bucket = '6';
        else if (diffDays === 7) bucket = '7';
        else if (diffDays === 8) bucket = '8';
        else if (diffDays === 9) bucket = '9';
        else if (diffDays >= 10 && diffDays <= 14) bucket = '10to14';
        else if (diffDays >= 15 && diffDays <= 30) bucket = '15plus';
        if (!cancelled && bucket !== 'any') setDaysRestBucketB(bucket);
      } catch {
        // silent fail
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasSubmitted, teamBNextGameInfo, submittedTeamBSearch]);

  // Team B career-view fetch (loose mode only).
  useEffect(() => {
    if (!careerViewEnabled || !hasSubmitted || !submittedTeamBSearch?.receipt) {
      return;
    }
    const reqB = submittedTeamBSearch.request;
    if (!reqB) return;
    const careerBaseReqB = stripSeasonFilters(stripContextFilters(reqB)) as SgmRequest;

    let cancelled = false;
    setCareerLoadingB(true);

    const basePromise = getSgmOutcomes(careerBaseReqB, teamBContextOptions);
    const opponentPromise = teamBNextGameInfo
      ? getSgmOutcomes({ ...careerBaseReqB, opponent: teamBNextGameInfo.opponent }, teamBContextOptions)
      : Promise.resolve(null as SgmResponse | null);
    const locationPromise = teamBNextGameInfo
      ? getSgmOutcomes({ ...careerBaseReqB, location: teamBNextGameInfo.location }, teamBContextOptions)
      : Promise.resolve(null as SgmResponse | null);
    const venuePromise = teamBNextGameInfo
      ? getSgmOutcomes({ ...careerBaseReqB, venue: teamBNextGameInfo.venue }, teamBContextOptions)
      : Promise.resolve(null as SgmResponse | null);
    const daysRestPromise = daysRestFilterB
      ? getSgmOutcomes(
          { ...careerBaseReqB, days_rest_min: daysRestFilterB.min, days_rest_max: daysRestFilterB.max },
          teamBContextOptions
        )
      : Promise.resolve(null as SgmResponse | null);

    Promise.all([basePromise, opponentPromise, locationPromise, venuePromise, daysRestPromise])
      .then(([base, opp, loc, ven, rest]) => {
        if (cancelled) return;
        setCareerBaseStatsB(base ?? null);
        setCareerOpponentStatsB(opp ?? null);
        setCareerLocationStatsB(loc ?? null);
        setCareerVenueStatsB(ven ?? null);
        setCareerDaysRestStatsB(rest ?? null);
      })
      .catch(() => {
        // silent fail
      })
      .finally(() => {
        if (!cancelled) setCareerLoadingB(false);
      });

    return () => {
      cancelled = true;
    };
  }, [careerViewEnabled, hasSubmitted, submittedTeamBSearch, teamBContextOptions, teamBNextGameInfo, daysRestFilterB, stripContextFilters, stripSeasonFilters]);

  // Invalidate Team B career cache when search changes.
  useEffect(() => {
    setCareerBaseStatsB(null);
    setCareerOpponentStatsB(null);
    setCareerLocationStatsB(null);
    setCareerVenueStatsB(null);
    setCareerDaysRestStatsB(null);
  }, [seasonFrom, seasonTo, location, opponent, venue, gameType]);

  const formatResultsHeader = useMemo(() => {
    const seasonLabel =
      seasonFrom === 'any' && seasonTo === 'any'
        ? 'All seasons'
        : `${seasonFrom === 'any' ? 'Any' : seasonFrom}–${seasonTo === 'any' ? 'Any' : seasonTo}`;
    const gamesLabel = `${baseTotal} ${baseTotal === 1 ? 'game' : 'games'}`;
    return { seasonLabel, gamesLabel };
  }, [baseTotal, seasonFrom, seasonTo]);
  const showResults = hasSubmitted;

  useImperativeHandle(
    ref,
    () => ({
      addPlayerSelection: (playerName: string, teamId?: number, teamName?: string) => {
        if (!isSameTeam(teamId ?? null, teamName ?? null)) {
          setError('Selections must be from the same team.');
          return;
        }
        // Reset all filters to defaults (same as New Search)
        setSeasonFrom('2025');
        setSeasonTo(CURRENT_SEASON);
        setSeasonOptions(SEASON_OPTIONS);
        setLocation('any');
        setOpponent('any');
        setVenue('any');
        setGameType('regular');
        searchGeneration.current += 1;
        setLoading(false);
        setStats(null);
        setSubmittedSearch(null);
        setSubmittedTeamBSearch(null);
        setError(null);

        const targetIndex = findSelectionTarget();
        const smartStat = getSmartDefaultStat(null, playerName, selections, targetIndex);
        handleSelectionChange(targetIndex, {
          playerName,
          playerId: null,
          teamId: teamId ?? null,
          teamName: teamName ?? null,
          ...(smartStat ? { stat: smartStat as StatType } : {}),
        });
      },
    }),
    [findSelectionTarget, handleSelectionChange, isSameTeam]
  );

  return (
    <div className="relative w-full max-w-4xl mx-auto">
      <Card className="relative w-full bg-white border border-gray-200 shadow-elegant overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-green-500 via-green-600 to-green-700"></div>
        <CardContent className="space-y-6 px-6 sm:px-8 py-6">
          {showResults && !isFormExpanded && (
            <div className="space-y-6 animate-fade-in">
              {/* Action Buttons - Above criteria */}
              <div className="flex items-center gap-1 sm:gap-2 justify-end pb-3 border-b border-gray-100">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAdjustSearch}
                  className="h-10 px-2 sm:px-4 text-sm font-semibold"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline ml-1.5">Adjust Search</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSaveSearch}
                  disabled={isSavingSearch}
                  className="h-10 px-2 sm:px-4 text-sm font-semibold"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline ml-1.5">{isSavingSearch ? 'Saving...' : 'Save to Vault'}</span>
                </Button>
                <Button
                  type="button"
                  onClick={handleNewSearch}
                  className="h-10 px-2 sm:px-5 bg-gradient-to-r from-green-600 to-green-500 hover:from-green-700 hover:to-green-600 text-white font-semibold rounded transition-all shadow-sm hover:shadow-md"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline ml-1.5">New Search</span>
                </Button>
              </div>

              {/* Bet Criteria - Sticky bar */}
              <div className="sticky top-0 z-20 bg-green-50 border border-green-200 border-l-4 border-l-green-600 rounded-lg p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-green-600 rounded text-white">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Bet Criteria</p>
                    <p className="text-sm font-semibold text-gray-900">
                      {selections
                        .filter((selection) => selection.playerName.trim())
                        .map((selection) => formatSelectionSummaryLabel(selection))
                        .join(' • ')}
                      <span className="text-xs font-medium text-gray-500 ml-1">
                        • {seasonFrom === 'any' && seasonTo === 'any' ? 'Any' : `${seasonFrom === 'any' ? 'Any' : seasonFrom}–${seasonTo === 'any' ? 'Any' : seasonTo}`}
                      </span>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {(isFormExpanded || !showResults) && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <Users className="w-4 h-4" />
                Teammate SGM Search
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSgmMode('precise')}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    sgmMode === 'precise'
                      ? 'border-gray-900 bg-gray-900 text-white'
                      : 'border-gray-200 bg-white text-gray-400 hover:border-gray-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Precise</p>
                  <p className="text-xs mt-0.5">Same player and/or same team only.</p>
                </button>

                <button
                  type="button"
                  onClick={() => setSgmMode('loose')}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    sgmMode === 'loose'
                      ? 'border-gray-900 bg-gray-900 text-white'
                      : 'border-gray-200 bg-white text-gray-400 hover:border-gray-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Loose</p>
                  <p className="text-xs mt-0.5">Allows players from both teams to be included.</p>
                </button>
              </div>

              <Accordion type="single" collapsible className="rounded-lg border border-gray-200 bg-gray-50">
                <AccordionItem value="how-it-works" className="border-none">
                  <AccordionTrigger className="px-4 text-sm font-semibold text-gray-800">
                    How it works
                  </AccordionTrigger>
                  <AccordionContent className="px-4 pb-4 text-xs text-gray-600 leading-relaxed">
                    This search lets you choose the same player or their teammates. We only allow
                    teammates because the results are based on games they played together, giving a
                    true picture of shared outcomes. Mixing players from different teams or unrelated
                    games would not connect the data.
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-gray-700">From Season</Label>
                  <Select value={seasonFrom} onValueChange={setSeasonFrom}>
                    <SelectTrigger className="h-11">
                      <SelectValue />
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
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-gray-700">To Season</Label>
                  <Select value={seasonTo} onValueChange={setSeasonTo}>
                    <SelectTrigger className="h-11">
                      <SelectValue />
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
              <div className="grid grid-cols-1 gap-4">
                {((showingTopPicks && filteredTopPicks.length > 0) || isLoadingTopPicks) && (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <div className="flex items-center justify-between mb-2 gap-3">
                      <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        {pickMode === 'saved' ? 'Saved picks' : 'Top picks'}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center rounded-full border border-gray-200 bg-white p-1 text-[10px] font-semibold uppercase tracking-wide">
                          <button
                            type="button"
                            onClick={() => setPickMode('top')}
                            className={`rounded-full px-2 py-0.5 transition-colors ${
                              pickMode === 'top' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'
                            }`}
                          >
                            Top
                          </button>
                          <button
                            type="button"
                            onClick={() => setPickMode('saved')}
                            className={`rounded-full px-2 py-0.5 transition-colors ${
                              pickMode === 'saved' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'
                            }`}
                          >
                            Saved
                          </button>
                        </div>
                        <button
                          type="button"
                          className="text-xs text-gray-400 hover:text-gray-600"
                          onClick={() => setShowingTopPicks(false)}
                        >
                          Hide
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {isLoadingTopPicks ? (
                        <>
                          <Skeleton className="h-8 w-24" />
                          <Skeleton className="h-8 w-24" />
                          <Skeleton className="h-8 w-24" />
                        </>
                      ) : (
                        filteredTopPicks.map((player) => (
                          <Button
                            key={player.player_id}
                            type="button"
                            variant="outline"
                            className="h-8 px-3 text-xs font-semibold"
                            onClick={() => handleTopPickSelect(player)}
                          >
                            {player.player_name}
                          </Button>
                        ))
                      )}
                    </div>
                  </div>
                )}
                {selections.map((selection, index) => {
                  const selTeamName = selection.teamName ?? getPlayerTeam2025(selection.playerName);
                  const isTeamBPlayer = sgmMode === 'loose' && teamBFilter.name && selTeamName &&
                    normalizeTeamName(selTeamName) === normalizeTeamName(teamBFilter.name);
                  const isTeamAPlayer = sgmMode === 'loose' && teamFilter.name && selTeamName &&
                    normalizeTeamName(selTeamName) === normalizeTeamName(teamFilter.name);
                  return (
                  <div key={selection.id} className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label className="text-sm font-semibold text-gray-700">Selection {index + 1}</Label>
                        {sgmMode === 'loose' && selection.playerName && isTeamAPlayer && (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                            Team A
                          </span>
                        )}
                        {sgmMode === 'loose' && selection.playerName && isTeamBPlayer && (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                            Team B
                          </span>
                        )}
                        {selection.playerName && selection.teamName && (
                          <span className="text-xs font-semibold text-gray-500">
                            {selection.playerName}, {selection.teamName}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant={selection.useQuickPicks ? 'secondary' : 'ghost'}
                          className="h-7 px-2 text-xs"
                          onClick={() => handleSelectionChange(index, { useQuickPicks: true })}
                        >
                          Quick picks
                        </Button>
                        <Button
                          type="button"
                          variant={!selection.useQuickPicks ? 'secondary' : 'ghost'}
                          className="h-7 px-2 text-xs"
                          onClick={() => handleSelectionChange(index, { useQuickPicks: false })}
                        >
                          Custom line
                        </Button>
                      {selections.length > 2 && (
                        <Button
                            type="button"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleRemoveSelection(index)}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div className="md:col-span-2">
                        <Label className="text-xs font-semibold text-gray-600">Player</Label>
                        <Input
                          value={selection.playerName}
                          placeholder="Start typing a player..."
                          onFocus={() => setActiveAutocompleteIndex(index)}
                          onChange={(event) => {
                            handleSelectionChange(index, {
                              playerName: event.target.value,
                              playerId: null,
                            });
                            setActiveAutocompleteIndex(index);
                          }}
                        />
                      {autocompleteOpen && activeAutocompleteIndex === index && suggestions.length > 0 && (
                        <div className="mt-2 rounded border border-gray-200 bg-white shadow-sm max-h-48 overflow-auto">
                          {suggestions.map((suggestion) => (
                            <button
                              key={suggestion.player_id}
                              type="button"
                              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                              onClick={() => handleAutocompleteSelect(suggestion)}
                            >
                              {suggestion.team_name
                                ? `${suggestion.player_name}, ${suggestion.team_name}`
                                : suggestion.player_name}
                            </button>
                          ))}
                        </div>
                      )}
                      {isLoadingSuggestions && activeAutocompleteIndex === index && (
                        <p className="text-xs text-gray-500 mt-2">Searching...</p>
                      )}
                      {isLoadingTeamSuggestions &&
                        activeAutocompleteIndex === index &&
                        teamFilter.id &&
                        !isLoadingSuggestions && (
                          <p className="text-xs text-gray-500 mt-2">Loading teammates...</p>
                        )}
                      {/* Career averages — shown when a player is selected in this row */}
                      {selection.playerId !== null && selection.playerId > 0 && (
                        <PlayerCareerAverages
                          playerId={selection.playerId}
                          playerName={selection.playerName}
                          size="sm"
                          className="mt-2"
                        />
                      )}
                      </div>
                      <div>
                        <Label className="text-xs font-semibold text-gray-600">Stat</Label>
                        <Select
                          value={selection.stat ?? ''}
                          onValueChange={(value: StatType) => handleSelectionChange(index, { stat: value })}
                        >
                          <SelectTrigger className="h-10">
                            <SelectValue placeholder="Pick a stat" />
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
                      {selection.stat && (
                      <div>
                        <Label className="text-xs font-semibold text-gray-600">
                          {selection.useQuickPicks ? 'Quick line' : 'Line'}
                        </Label>
                        {selection.useQuickPicks ? (
                          <div className="flex flex-wrap gap-2">
                            {getQuickOptions(selection.stat).map((option) => (
                              <Button
                                key={option.label}
                                type="button"
                                variant={selection.threshold === option.threshold ? 'secondary' : 'outline'}
                                className="h-8 px-3 text-xs"
                                onClick={() => handleSelectionChange(index, { threshold: option.threshold })}
                              >
                                {option.label}
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <Input
                            value={selection.threshold}
                            onChange={(event) =>
                              handleSelectionChange(index, { threshold: event.target.value })
                            }
                          />
                        )}
                      </div>
                      )}
                    </div>
                  </div>
                  );
                })}
                <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 px-3 text-xs font-semibold"
                  onClick={handleAddSelection}
                  disabled={selections.length >= MAX_SGM_SELECTIONS}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add selection (up to {MAX_SGM_SELECTIONS})
                </Button>
                  <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                    Mode:{' '}
                    {derivedBetMode === 'mixed'
                      ? 'Mixed'
                      : derivedBetMode === 'over_under'
                        ? 'Over/Under'
                        : 'Win/Loss'}
                  </div>
                </div>
              </div>

          <Button
            type="button"
            className="w-full h-12 bg-green-600 hover:bg-green-700 text-white font-semibold rounded"
            onClick={handleSearch}
            disabled={loading || (nextGamePreloaded && nextGameLoading)}
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

          <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">Next Game Focus</p>
              <p className="text-xs text-gray-500">Include upcoming opponent, venue, and home/away splits.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-700">Next Game</span>
              <Switch
                checked={nextGamePreloaded}
                onCheckedChange={(checked) => {
                  setNextGamePreloaded(checked);
                  if (!checked) {
                    setNextGameResults(null);
                    setNextGameResultsLoading(false);
                    if (sgmMode === 'loose') setSgmMode('precise');
                  }
                }}
                aria-label="Toggle next game focus"
                className="data-[state=checked]:bg-green-600 data-[state=unchecked]:bg-gray-300 scale-90"
              />
            </div>
          </div>

          {nextFinalIncludesAll && <p className="text-xs text-emerald-800 bg-emerald-50 rounded-lg px-4 py-2">Next game is a final: results include regular season + finals. The player impact panel compares finals with the same-season regular-season baseline.</p>}
          {!nextGamePreloaded && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-gray-700">Location</Label>
                  <Select
                    value={location}
                    onValueChange={(value: 'any' | 'home' | 'away') => setLocation(value)}
                  >
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      <SelectItem value="home">Home</SelectItem>
                      <SelectItem value="away">Away</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-gray-700">Opponent</Label>
                  <Select value={opponent} onValueChange={setOpponent}>
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      {AFL_TEAMS.map((team) => (
                        <SelectItem key={team} value={team}>
                          {team}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-gray-700">Venue</Label>
                  <Select value={venue} onValueChange={setVenue}>
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      {AFL_VENUES.map((venueOption) => (
                        <SelectItem key={venueOption} value={venueOption}>
                          {venueOption}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-semibold text-gray-700">Game Type</Label>
                <Select
                  value={gameType}
                  onValueChange={(value: 'regular' | 'finals' | 'all') => setGameType(value)}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="regular">Regular</SelectItem>
                    <SelectItem value="finals">Finals</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-gray-600" />
                  Days Rest
                </Label>
                <Select
                  value={daysRestBucket}
                  onValueChange={(value: typeof daysRestBucket) => setDaysRestBucket(value)}
                >
                  <SelectTrigger className="h-11">
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
            </>
          )}

          {rateLimitInfo && (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-amber-50 p-5 shadow-sm">
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

          {error && (
            <Alert variant="destructive" className="mt-4">
              <XCircle className="h-5 w-5" />
              <AlertTitle className="font-semibold">Error</AlertTitle>
              <AlertDescription className="mt-1 text-sm">{error}</AlertDescription>
            </Alert>
          )}
        </div>
          )}

          {hasSubmitted && (
            <div id="weighted-results" className="mt-6 rounded-xl border border-green-900/20 overflow-hidden shadow-lg">
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
                      onClick={() => setWeightsOpen((prev) => !prev)}
                      className="h-7 px-3 text-[11px] font-bold text-white bg-white/15 hover:bg-white/25 rounded-full border-0"
                    >
                      {weightsOpen ? 'Hide Sliders' : 'Customize'}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="bg-green-50/60 border-t border-green-900/20">
              <div className="px-4 pt-4 pb-4 space-y-4">
                {sgmMode === 'loose' ? (
                  looseModeCombinedOutcomes && looseModeCombinedOutcomes.length > 0 ? (
                    <div className="space-y-4">
                      <div className="rounded-lg border border-amber-200 bg-white p-4 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-[10px] font-bold text-amber-800 uppercase tracking-wider">Combined (Loose)</span>
                          <span className="text-[9px] text-gray-500">probabilities multiplied, assumes independence</span>
                        </div>
                        <div className="space-y-3">
                          {looseModeCombinedOutcomes.map((outcome, index) => (
                            <div key={outcome.key}>
                              <div className="flex items-center justify-between text-xs font-semibold text-gray-600">
                                <span className="truncate pr-2">{outcome.labelB ? `${outcome.labelA} / ${outcome.labelB}` : outcome.labelA}</span>
                                <span className="shrink-0">{outcome.percent.toFixed(1)}%</span>
                              </div>
                              <div className="mt-2 h-4 w-full rounded-full bg-gray-100 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${index % 2 === 0 ? 'bg-gradient-to-r from-amber-400 to-amber-600' : 'bg-gradient-to-r from-orange-400 to-orange-600'}`}
                                  style={{ width: `${Math.min(outcome.percent * 4, 100)}%` }}
                                ></div>
                              </div>
                              {!screenshotMode && (
                                <div className="mt-1 text-xs text-gray-500">
                                  Break-even: ${outcome.percent > 0 ? (100 / outcome.percent).toFixed(2) : '0.00'}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">Waiting for both teams&apos; weighted outcomes to resolve…</p>
                  )
                ) : weightedOutcomes ? (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                      <div className="space-y-3">
                        {weightedOutcomes.outcomes.map((outcome, index) => (
                          <div key={outcome.key}>
                            <div className="flex items-center justify-between text-xs font-semibold text-gray-600">
                              <span>{outcome.label}</span>
                              <span>{outcome.percent.toFixed(1)}%</span>
                            </div>
                            <div className="mt-2 h-4 w-full rounded-full bg-gray-100 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${index % 2 === 0 ? 'bg-gradient-to-r from-emerald-400 to-green-600' : 'bg-gradient-to-r from-blue-400 to-blue-600'}`}
                                style={{ width: `${outcome.percent}%` }}
                              ></div>
                            </div>
                            {!screenshotMode && (
                              <div className="mt-1 text-xs text-gray-500">
                                Break-even: ${outcome.breakEven}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">Add weights to see weighted results.</p>
                )}

                {sgmMode !== 'loose' && weightedOutcomes && (
                  <div className="text-xs text-gray-500 text-right">
                    Total weight: {weightedOutcomes.totalWeight}
                  </div>
                )}

                <div className="space-y-4">
                  {weightsOpen && (
                    <div className="space-y-4">
                      {sgmMode === 'loose' && (
                        <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Team A Weights — {teamFilter.name ?? 'Team A'}</p>
                      )}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <WeightSlider
                          label="All games"
                          value={weightBase}
                          onChange={setWeightBase}
                          count={baseTotal}
                          max={maxWeight}
                          disabled={baseTotal === 0}
                          percent={
                            baseTotal > 0 && totalWeightForPercent > 0
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
                          disabled={locationTotal === 0}
                          percent={
                            locationTotal > 0 && totalWeightForPercent > 0
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
                          disabled={venueTotal === 0}
                          percent={
                            venueTotal > 0 && totalWeightForPercent > 0
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
                          disabled={opponentTotal === 0}
                          percent={
                            opponentTotal > 0 && totalWeightForPercent > 0
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
                            disabled={thisSeasonTotal === 0}
                            percent={
                              thisSeasonTotal > 0 && totalWeightForPercent > 0
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
                            disabled={lastSeasonTotal === 0}
                            percent={
                              lastSeasonTotal > 0 && totalWeightForPercent > 0
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
                            disabled={last30DaysTotal === 0}
                            percent={
                              last30DaysTotal > 0 && totalWeightForPercent > 0
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
                            disabled={daysRestTotal === 0}
                            percent={
                              daysRestTotal > 0 && totalWeightForPercent > 0
                                ? (effectiveWeightDaysRest / totalWeightForPercent) * 100
                                : null
                            }
                          />
                        )}
                      </div>

                      {sgmMode === 'loose' && (
                        <>
                          <p className="text-xs font-semibold text-orange-700 uppercase tracking-wide mt-4">Team B Weights — {teamBFilter.name ?? 'Team B'}</p>
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <WeightSlider
                              label="All games"
                              value={weightBBase}
                              onChange={setWeightBBase}
                              count={teamBBasTotal}
                              max={maxWeight}
                              disabled={teamBBasTotal === 0}
                              percent={teamBBasTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBBase / totalWeightBForPercent) * 100 : null}
                            />
                            <WeightSlider
                              label="Home/Away"
                              value={weightBLocation}
                              onChange={setWeightBLocation}
                              count={teamBLocationTotal}
                              max={maxWeight}
                              disabled={teamBLocationTotal === 0}
                              percent={teamBLocationTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBLocation / totalWeightBForPercent) * 100 : null}
                            />
                            <WeightSlider
                              label="Venue"
                              value={weightBVenue}
                              onChange={setWeightBVenue}
                              count={teamBVenueTotal}
                              max={maxWeight}
                              disabled={teamBVenueTotal === 0}
                              percent={teamBVenueTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBVenue / totalWeightBForPercent) * 100 : null}
                            />
                            <WeightSlider
                              label="Opponent"
                              value={weightBOpponent}
                              onChange={setWeightBOpponent}
                              count={teamBOpponentTotal}
                              max={maxWeight}
                              disabled={teamBOpponentTotal === 0}
                              percent={teamBOpponentTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBOpponent / totalWeightBForPercent) * 100 : null}
                            />
                            {thisSeasonInRange && (
                              <WeightSlider
                                label={`This season (${CURRENT_SEASON})`}
                                value={weightBThisSeason}
                                onChange={setWeightBThisSeason}
                                count={teamBThisSeasonTotal}
                                max={maxWeight}
                                disabled={teamBThisSeasonTotal === 0}
                                percent={teamBThisSeasonTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBThisSeason / totalWeightBForPercent) * 100 : null}
                              />
                            )}
                            {lastSeasonInRange && (
                              <WeightSlider
                                label={`Last season (${LAST_SEASON_YEAR})`}
                                value={weightBLastSeason}
                                onChange={setWeightBLastSeason}
                                count={teamBLastSeasonTotal}
                                max={maxWeight}
                                disabled={teamBLastSeasonTotal === 0}
                                percent={teamBLastSeasonTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBLastSeason / totalWeightBForPercent) * 100 : null}
                              />
                            )}
                            {last30DaysInRange && (
                              <WeightSlider
                                label={`Last ${LAST_30_DAYS} days`}
                                value={weightBLast30Days}
                                onChange={setWeightBLast30Days}
                                count={teamBLast30DaysTotal}
                                max={maxWeight}
                                disabled={teamBLast30DaysTotal === 0}
                                percent={teamBLast30DaysTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBLast30Days / totalWeightBForPercent) * 100 : null}
                              />
                            )}
                            {daysRestBucketB !== 'any' && (
                              <WeightSlider
                                label={daysRestLabelB}
                                value={weightDaysRestB}
                                onChange={setWeightDaysRestB}
                                count={teamBDaysRestTotal}
                                max={maxWeight}
                                disabled={teamBDaysRestTotal === 0}
                                percent={teamBDaysRestTotal > 0 && totalWeightBForPercent > 0 ? (effectiveWeightBDaysRest / totalWeightBForPercent) * 100 : null}
                              />
                            )}
                          </div>
                        </>
                      )}
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

          {hasSubmitted && submittedSearch ? <SgmPlayerImpactResearch
            request={submittedSearch.request} receipt={submittedSearch.receipt}
            label={submittedTeamBSearch ? 'Team A' : undefined}
          /> : null}
          {hasSubmitted && submittedTeamBSearch ? <SgmPlayerImpactResearch
            request={submittedTeamBSearch.request} receipt={submittedTeamBSearch.receipt} label="Team B"
          /> : null}

          {/* SGM Game Log — precise mode only, between Algorithm and Detailed Hit Rates */}
          {hasSubmitted && sgmMode === 'precise' && submittedSearch && (
            <SgmGameLog
              receipt={submittedSearch.receipt}
              receiptExpiresAt={submittedSearch.expiresAt}
              selections={submittedLogSelections}
              seasonFrom={submittedSearch.request.season_from}
              seasonTo={submittedSearch.request.season_to}
              location={submittedSearch.request.location}
              opponent={submittedSearch.request.opponent}
              venue={submittedSearch.request.venue}
              gameType={submittedSearch.request.game_type}
              todayDate={new Date().toISOString().slice(0, 10)}
            />
          )}

          {hasSubmitted && (
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
                          {formatResultsHeader.seasonLabel}
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs font-semibold bg-white/20 text-white px-2.5 py-1 rounded-full">
                          {formatResultsHeader.gamesLabel}
                        </span>
                      </div>
                    </div>
                    <div className="p-2.5 bg-white/15 rounded-xl">
                      <Users className="w-6 h-6 text-white" />
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <Tabs value={resultsFormat} onValueChange={(value) => setResultsFormat(value as any)}>
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

              {sgmMode === 'loose' ? (
                <>
                  {/* Career-view toggle — applies to both Team A and Team B
                      non-time-based cards simultaneously. Weighted algos stay
                      anchored to the season filter on both sides. */}
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
                            <strong> Days rest</strong> cards (both teams) between your
                            selected season range and full career history.
                          </p>
                          <p className="text-[10px] text-gray-500">
                            Time-based cards and the weighted algorithms for both teams stay
                            anchored to your season filter.
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

                  {/* Team A Section */}
                  <div className="rounded-lg border-l-4 border-blue-500 pl-4 space-y-4">
                    <p className="text-sm font-bold text-blue-700 uppercase tracking-wide">
                      Team A — {teamFilter.name ?? 'Team A'}
                    </p>
                    <SgmResultsTemplate
                      title={careerViewEnabled ? 'All games (career)' : 'All games'}
                      stats={displayBaseStats}
                      loading={loading || (careerViewEnabled && careerLoading && !careerBaseStats)}
                      resultsFormat={resultsFormat}
                      selections={teamASelections}
                      betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                    />
                    {thisSeasonInRange && (
                      <SgmResultsTemplate
                        title={`This season (${CURRENT_SEASON})`}
                        stats={activeThisSeasonStats}
                        loading={thisSeasonLoading}
                        resultsFormat={resultsFormat}
                        selections={teamASelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                    {nextGameInfo && (
                      <>
                        <SgmResultsTemplate
                          title={`${nextGameInfo.location === 'home' ? 'Home' : 'Away'} games${careerViewEnabled ? ' (career)' : ''}`}
                          stats={displayLocationStats}
                          loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerLocationStats)}
                          resultsFormat={resultsFormat}
                          selections={teamASelections}
                          betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                        />
                        <SgmResultsTemplate
                          title={`Games at ${nextGameInfo.venue}${careerViewEnabled ? ' (career)' : ''}`}
                          stats={displayVenueStats}
                          loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerVenueStats)}
                          resultsFormat={resultsFormat}
                          selections={teamASelections}
                          betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                        />
                        <SgmResultsTemplate
                          title={`Games vs ${nextGameInfo.opponent}${careerViewEnabled ? ' (career)' : ''}`}
                          stats={displayOpponentStats}
                          loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerOpponentStats)}
                          resultsFormat={resultsFormat}
                          selections={teamASelections}
                          betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                        />
                      </>
                    )}
                    {last30DaysInRange && (
                      <SgmResultsTemplate
                        title={`Last ${LAST_30_DAYS} days`}
                        stats={activeLast30DaysStats}
                        loading={last30DaysLoading}
                        resultsFormat={resultsFormat}
                        selections={teamASelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                    {daysRestBucket !== 'any' && (
                      <SgmResultsTemplate
                        title={`${daysRestLabel}${careerViewEnabled ? ' (career)' : ''}`}
                        stats={displayDaysRestStats}
                        loading={daysRestLoading || (careerViewEnabled && careerLoading && !careerDaysRestStats)}
                        resultsFormat={resultsFormat}
                        selections={teamASelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                    {lastSeasonInRange && (
                      <SgmResultsTemplate
                        title={`Last season (${LAST_SEASON_YEAR})`}
                        stats={activeLastSeasonStats}
                        loading={lastSeasonLoading}
                        resultsFormat={resultsFormat}
                        selections={teamASelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                  </div>

                  {/* Team B Section */}
                  <div className="rounded-lg border-l-4 border-orange-400 pl-4 space-y-4">
                    <p className="text-sm font-bold text-orange-700 uppercase tracking-wide">
                      Team B — {teamBFilter.name ?? 'Team B'}
                    </p>
                    <SgmResultsTemplate
                      title={careerViewEnabled ? 'All games (career)' : 'All games'}
                      stats={displayBaseStatsB}
                      loading={loading || (careerViewEnabled && careerLoadingB && !careerBaseStatsB)}
                      resultsFormat={resultsFormat}
                      selections={teamBSelections}
                      betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                    />
                    {thisSeasonInRange && (
                      <SgmResultsTemplate
                        title={`This season (${CURRENT_SEASON})`}
                        stats={thisSeasonInRange ? teamBThisSeasonStats : null}
                        loading={teamBThisSeasonLoading}
                        resultsFormat={resultsFormat}
                        selections={teamBSelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                    {teamBNextGameInfo && (
                      <>
                        <SgmResultsTemplate
                          title={`${teamBNextGameInfo.location === 'home' ? 'Home' : 'Away'} games${careerViewEnabled ? ' (career)' : ''}`}
                          stats={displayLocationStatsB}
                          loading={teamBNextGameResultsLoading || (careerViewEnabled && careerLoadingB && !careerLocationStatsB)}
                          resultsFormat={resultsFormat}
                          selections={teamBSelections}
                          betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                        />
                        <SgmResultsTemplate
                          title={`Games at ${teamBNextGameInfo.venue}${careerViewEnabled ? ' (career)' : ''}`}
                          stats={displayVenueStatsB}
                          loading={teamBNextGameResultsLoading || (careerViewEnabled && careerLoadingB && !careerVenueStatsB)}
                          resultsFormat={resultsFormat}
                          selections={teamBSelections}
                          betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                        />
                        <SgmResultsTemplate
                          title={`Games vs ${teamBNextGameInfo.opponent}${careerViewEnabled ? ' (career)' : ''}`}
                          stats={displayOpponentStatsB}
                          loading={teamBNextGameResultsLoading || (careerViewEnabled && careerLoadingB && !careerOpponentStatsB)}
                          resultsFormat={resultsFormat}
                          selections={teamBSelections}
                          betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                        />
                      </>
                    )}
                    {last30DaysInRange && (
                      <SgmResultsTemplate
                        title={`Last ${LAST_30_DAYS} days`}
                        stats={last30DaysInRange ? teamBLast30DaysStats : null}
                        loading={teamBLast30DaysLoading}
                        resultsFormat={resultsFormat}
                        selections={teamBSelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                    {daysRestBucketB !== 'any' && (
                      <SgmResultsTemplate
                        title={`${daysRestLabelB}${careerViewEnabled ? ' (career)' : ''}`}
                        stats={displayDaysRestStatsB}
                        loading={daysRestLoadingB || (careerViewEnabled && careerLoadingB && !careerDaysRestStatsB)}
                        resultsFormat={resultsFormat}
                        selections={teamBSelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                    {lastSeasonInRange && (
                      <SgmResultsTemplate
                        title={`Last season (${LAST_SEASON_YEAR})`}
                        stats={lastSeasonInRange ? teamBLastSeasonStats : null}
                        loading={teamBLastSeasonLoading}
                        resultsFormat={resultsFormat}
                        selections={teamBSelections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    )}
                  </div>

                  {/* Combined section moved to top algo card — no duplicate at bottom */}
                </>
              ) : (
                <>
                  {/* Career-view toggle — flips non-time-based SGM cards to
                      show lifetime outcomes instead of the selected season
                      range. Weighted algorithm stays anchored to the season
                      filter regardless. */}
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
                            <strong> Days rest</strong> cards between your selected season
                            range and the selections&apos; full career history.
                          </p>
                          <p className="text-[10px] text-gray-500">
                            Time-based cards (This season, Last season, Last 30 days) and the
                            weighted algorithm both stay anchored to your season filter.
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

                  <SgmResultsTemplate
                    title={careerViewEnabled ? 'All games (career)' : 'All games'}
                    stats={displayBaseStats}
                    loading={loading || (careerViewEnabled && careerLoading && !careerBaseStats)}
                    resultsFormat={resultsFormat}
                    selections={selections}
                    betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                  />
                  {thisSeasonInRange && (
                    <SgmResultsTemplate
                      title={`This season (${CURRENT_SEASON})`}
                      stats={activeThisSeasonStats}
                      loading={thisSeasonLoading}
                      resultsFormat={resultsFormat}
                      selections={selections}
                      betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                    />
                  )}
                  {nextGameInfo && (
                    <>
                      <SgmResultsTemplate
                        title={`${nextGameInfo.location === 'home' ? 'Home' : 'Away'} games${careerViewEnabled ? ' (career)' : ''}`}
                        stats={displayLocationStats}
                        loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerLocationStats)}
                        resultsFormat={resultsFormat}
                        selections={selections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                      <SgmResultsTemplate
                        title={`Games at ${nextGameInfo.venue}${careerViewEnabled ? ' (career)' : ''}`}
                        stats={displayVenueStats}
                        loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerVenueStats)}
                        resultsFormat={resultsFormat}
                        selections={selections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                      <SgmResultsTemplate
                        title={`Games vs ${nextGameInfo.opponent}${careerViewEnabled ? ' (career)' : ''}`}
                        stats={displayOpponentStats}
                        loading={nextGameResultsLoading || (careerViewEnabled && careerLoading && !careerOpponentStats)}
                        resultsFormat={resultsFormat}
                        selections={selections}
                        betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                      />
                    </>
                  )}
                  {last30DaysInRange && (
                    <SgmResultsTemplate
                      title={`Last ${LAST_30_DAYS} days`}
                      stats={activeLast30DaysStats}
                      loading={last30DaysLoading}
                      resultsFormat={resultsFormat}
                      selections={selections}
                      betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                    />
                  )}
                  {daysRestBucket !== 'any' && (
                    <SgmResultsTemplate
                      title={`${daysRestLabel}${careerViewEnabled ? ' (career)' : ''}`}
                      stats={displayDaysRestStats}
                      loading={daysRestLoading || (careerViewEnabled && careerLoading && !careerDaysRestStats)}
                      resultsFormat={resultsFormat}
                      selections={selections}
                      betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                    />
                  )}
                  {lastSeasonInRange && (
                    <SgmResultsTemplate
                      title={`Last season (${LAST_SEASON_YEAR})`}
                      stats={activeLastSeasonStats}
                      loading={lastSeasonLoading}
                      resultsFormat={resultsFormat}
                      selections={selections}
                      betMode={derivedBetMode === 'mixed' ? 'over_under' : derivedBetMode}
                    />
                  )}
                </>
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
                  Return to Weighted Analysis
                </Button>
              </div>
            </div>
          )}

          {/* Bottom Action Buttons */}
          {showResults && !isFormExpanded && (
            <div className="flex items-center gap-1 sm:gap-2 justify-end pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleAdjustSearch}
                className="h-10 px-2 sm:px-4 text-sm font-semibold"
              >
                <ChevronDown className="w-3.5 h-3.5" />
                <span className="hidden sm:inline ml-1.5">Adjust Search</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleSaveSearch}
                disabled={isSavingSearch}
                className="h-10 px-2 sm:px-4 text-sm font-semibold"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span className="hidden sm:inline ml-1.5">{isSavingSearch ? 'Saving...' : 'Save to Vault'}</span>
              </Button>
              <Button
                type="button"
                onClick={handleNewSearch}
                className="h-10 px-2 sm:px-5 bg-gradient-to-r from-green-600 to-green-500 hover:from-green-700 hover:to-green-600 text-white font-semibold rounded transition-all shadow-sm hover:shadow-md"
              >
                <Plus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline ml-1.5">New Search</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
});

type WeightSliderProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  count: number;
  max: number;
  disabled?: boolean;
  percent?: number | null;
};

function WeightSlider({ label, value, onChange, count, max, disabled, percent }: WeightSliderProps) {
  const percentLabel = percent === null || percent === undefined ? '--' : percent.toFixed(1);
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-4 ${disabled ? 'opacity-60' : ''}`}>
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

type SgmResultsTemplateProps = {
  title: string;
  stats?: SgmResponse | null;
  loading: boolean;
  resultsFormat: 'graphs' | 'text' | 'both';
  selections: SelectionRow[];
  betMode: 'over_under' | 'win_loss';
};

function SgmResultsTemplate({
  title,
  stats,
  loading,
  resultsFormat,
  selections,
  betMode,
}: SgmResultsTemplateProps) {
  const { screenshotMode } = useScreenshotMode();
  const totalGames = stats?.total ?? 0;
  const filledSelections = useMemo(
    () => selections.filter((selection) => selection.playerName.trim()),
    [selections]
  );
  const outcomes = useMemo(() => {
    if (!stats || totalGames <= 0) {
      return [];
    }
    return Object.entries(stats.outcomes).map(([key, count]) => {
      const percent = totalGames > 0 ? (count / totalGames) * 100 : 0;
      const breakEven = percent > 0 ? (100 / percent).toFixed(2) : '0.00';
      return {
        key,
        label: formatOutcomeLabel(key, filledSelections, betMode),
        lines: formatOutcomeLines(key, filledSelections, betMode),
        count,
        percent,
        breakEven,
      };
    });
  }, [stats, totalGames, filledSelections, betMode]);

  const showText = resultsFormat !== 'graphs';
  const showGraphs = resultsFormat !== 'text';
  const barGradients = [
    'bg-gradient-to-r from-emerald-400 to-green-600',
    'bg-gradient-to-r from-blue-400 to-blue-600',
    'bg-gradient-to-r from-violet-400 to-purple-600',
    'bg-gradient-to-r from-amber-400 to-orange-500',
  ];

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

      {showGraphs && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 sm:p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-[0.15em]">Result Distribution</p>
            {stats ? <span className="text-xs font-medium text-gray-400">{totalGames} games</span> : null}
          </div>
          {loading && !stats ? (
            <div className="space-y-5">
              <Skeleton className="h-7 w-full rounded-xl" />
              <Skeleton className="h-7 w-full rounded-xl" />
            </div>
          ) : outcomes.length ? (
            <div className="space-y-6">
              {outcomes.map((outcome, index) => (
                <div key={outcome.key}>
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-sm font-semibold text-gray-600">{outcome.label}</span>
                    <span className="text-3xl font-black text-gray-900 tabular-nums leading-none">
                      {outcome.percent.toFixed(1)}<span className="text-base font-semibold text-gray-400 ml-0.5">%</span>
                    </span>
                  </div>
                  <div className="h-7 w-full rounded-xl bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded-xl ${barGradients[index % barGradients.length]}`}
                      style={{ width: `${outcome.percent}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-xs text-gray-400">{outcome.count} games</span>
                    {!screenshotMode && (
                      <span className="text-xs text-gray-400">Break-even: ${outcome.breakEven}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-gray-500">No stats yet.</p>
          )}
        </div>
      )}

      {showText && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {loading && !stats
            ? Array.from({ length: 2 }).map((_, idx) => (
                <Card key={idx} className="border border-gray-200 bg-white shadow-sm">
                  <CardContent className="p-6 space-y-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-10 w-32" />
                    <Skeleton className="h-3 w-32" />
                  </CardContent>
                </Card>
              ))
            : outcomes.map((outcome) => (
                <Card key={outcome.key} className="border border-gray-200 bg-white shadow-sm">
                  <CardContent className="p-6 space-y-2">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      {outcome.lines.map((line, index) => (
                        <span key={`${outcome.key}-${index}`} className="block">
                          {line}
                        </span>
                      ))}
                    </p>
                    <p className="text-3xl font-bold text-gray-900">{outcome.percent.toFixed(1)}%</p>
                    {!screenshotMode && (
                      <p className="text-xs text-gray-500">Break-even: ${outcome.breakEven}</p>
                    )}
                    <p className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                      {outcome.count} games
                    </p>
                  </CardContent>
                </Card>
              ))}
        </div>
      )}
    </div>
  );
}
