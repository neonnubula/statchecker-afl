/**
 * UpcomingGamesBanner - Compact horizontal banner of upcoming games
 * 
 * Displays upcoming AFL fixtures as small, clickable chips.
 * Designed to sit above the search form without taking up much space.
 * Hover over a game to see player lists and select a player for quick search.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, User } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Fixture,
  getUpcomingFixtures
} from '@/lib/api/fixtures';
import { getTeamRosterByName } from '@/lib/api/client';
import { isSelectableFixture } from '@/lib/fixture-selection';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';

interface UpcomingGamesBannerProps {
  onGameSelect?: (fixture: Fixture) => void;
  onPlayerSelect?: (playerName: string, fixture: Fixture) => void;
  selectedFixtureId?: number | null;
}

// Very short team abbreviations
const TEAM_ABBREV: Record<string, string> = {
  'Sydney Swans': 'SYD',
  'Carlton Blues': 'CAR',
  'Gold Coast Suns': 'GC',
  'Geelong Cats': 'GEE',
  'Greater Western Sydney Giants': 'GWS',
  'Hawthorn Hawks': 'HAW',
  'Brisbane Lions': 'BRI',
  'Western Bulldogs': 'WB',
  'St Kilda Saints': 'STK',
  'Collingwood Magpies': 'COL',
  'Adelaide Crows': 'ADE',
  'Essendon Bombers': 'ESS',
  'Fremantle Dockers': 'FRE',
  'Melbourne Demons': 'MEL',
  'North Melbourne Kangaroos': 'NM',
  'Port Adelaide Power': 'PA',
  'Richmond Tigers': 'RIC',
  'West Coast Eagles': 'WC',
};

function getTeamAbbrev(fullName: string): string {
  return TEAM_ABBREV[fullName] || fullName.substring(0, 3).toUpperCase();
}

function formatShortDate(dateStr: string | null): string {
  if (!dateStr) return 'TBC';
  const date = new Date(`${dateStr}T12:00:00`);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  return `${month}/${day}`;
}

export function UpcomingGamesBanner({
  onGameSelect,
  onPlayerSelect,
  selectedFixtureId
}: UpcomingGamesBannerProps) {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [teamRosters, setTeamRosters] = useState<Record<string, string[]>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const fetchRostersForTeams = useCallback(async (teamNames: string[]) => {
    const uniqueTeams = Array.from(new Set(teamNames));
    const results: Record<string, string[]> = {};
    await Promise.all(
      uniqueTeams.map(async (name) => {
        try {
          const response = await getTeamRosterByName(name, 50);
          results[name] = response.suggestions.map((s) => s.player_name);
        } catch {
          results[name] = [];
        }
      })
    );
    setTeamRosters((prev) => ({ ...prev, ...results }));
  }, []);

  useEffect(() => {
    async function fetchFixtures() {
      try {
        const response = await getUpcomingFixtures(14);
        setFixtures(response.fixtures);
        const allTeams = response.fixtures.filter((f) => isSelectableFixture(f)).flatMap((f) => [f.home_team_name, f.away_team_name]);
        void fetchRostersForTeams(allTeams);
      } catch {
        setFixtures([]);
      }
    }
    fetchFixtures();

  }, []);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const scrollAmount = 200;
      scrollContainerRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  if (!fixtures.length) return null;

  return (
    <div className="flex items-center gap-2" aria-label="Upcoming AFL finals and fixtures">
      {/* Left arrow - hidden on mobile */}
      {!isMobile && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 flex-shrink-0 text-gray-400 hover:text-gray-600"
          onClick={() => scroll('left')}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      )}

      {/* Scrollable game chips */}
      <div
        ref={scrollContainerRef}
        className="flex gap-2 overflow-x-auto scrollbar-hide scroll-smooth flex-1"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch' // Better touch scrolling on iOS
        }}
      >
        {fixtures.map((fixture) => (
          <GameChip
            key={fixture.fixture_id}
            fixture={fixture}
            isSelected={selectedFixtureId === fixture.fixture_id}
            onClick={() => { if (isSelectableFixture(fixture)) onGameSelect?.(fixture); }}
            onPlayerSelect={(playerName) => { if (isSelectableFixture(fixture)) onPlayerSelect?.(playerName, fixture); }}
            isMobile={isMobile}
            teamRosters={teamRosters}
          />
        ))}
      </div>

      {/* Right arrow - hidden on mobile */}
      {!isMobile && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 flex-shrink-0 text-gray-400 hover:text-gray-600"
          onClick={() => scroll('right')}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

interface GameChipProps {
  fixture: Fixture;
  isSelected: boolean;
  onClick: () => void;
  onPlayerSelect?: (playerName: string) => void;
  isMobile: boolean;
  teamRosters: Record<string, string[]>;
}

function GameChip({ fixture, isSelected, onClick, onPlayerSelect, isMobile, teamRosters }: GameChipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const home = getTeamAbbrev(fixture.home_team_name);
  const away = getTeamAbbrev(fixture.away_team_name);
  const date = fixture.game_date ? formatShortDate(fixture.game_date)
    : fixture.date_window_start && fixture.date_window_end
      ? `${formatShortDate(fixture.date_window_start)}–${formatShortDate(fixture.date_window_end)} · time TBC` : 'Date TBC';
  const selectable = isSelectableFixture(fixture);

  const homePlayers = teamRosters[fixture.home_team_name] ?? [];
  const awayPlayers = teamRosters[fixture.away_team_name] ?? [];
  
  const handlePlayerClick = (playerName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false); // Close the hover card immediately
    if (selectable) onPlayerSelect?.(playerName);
  };

  const handleChipClick = (e: React.MouseEvent) => {
    if (isMobile || !selectable) {
      // On mobile, toggle the hover card open/close
      setIsOpen(!isOpen);
      e.stopPropagation();
    } else {
      // On desktop, just call the game select handler
      onClick();
    }
  };

  return (
    <HoverCard
      open={isOpen}
      onOpenChange={setIsOpen}
      openDelay={isMobile ? 0 : 200}
      closeDelay={isMobile ? 0 : 100}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={handleChipClick}
          className={`
            flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium
            transition-all duration-150 whitespace-nowrap
            ${isSelected
              ? 'bg-emerald-600 text-white shadow-sm'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }
            ${isMobile && isOpen ? 'bg-blue-100 text-blue-800' : ''}
            ${isMobile ? 'active:scale-95 active:bg-gray-200' : ''}
          `}
        >
          {home} v {away} · {date}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        className={`${isMobile ? 'w-[calc(100vw-2rem)] max-w-sm' : 'w-[480px]'} p-0 shadow-xl border border-gray-200`}
        align={isMobile ? "center" : "start"}
        side={isMobile ? "bottom" : "bottom"}
        sideOffset={8}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-green-600 to-green-700 text-white px-4 py-3 rounded-t-lg">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-sm">{fixture.home_team_name}</span>
            <span className="text-xs bg-white/20 px-2 py-0.5 rounded">vs</span>
            <span className="font-semibold text-sm">{fixture.away_team_name}</span>
          </div>
          <p className="text-xs text-green-100 mt-1 text-center">
            {fixture.round_name} • {fixture.venue_name} • {date} {fixture.game_time ?? ''}
          </p>
        </div>
        
        <div className="px-4 py-2 text-xs text-gray-600 border-b border-gray-200">
          {fixture.note && <p>{fixture.note}</p>}
          {fixture.source_urls?.[0] && <a className="underline" href={fixture.source_urls[0]} target="_blank" rel="noreferrer">Official fixture source</a>}
          {fixture.checked_at && <p>Checked {new Date(fixture.checked_at).toLocaleString('en-US', { timeZone: 'Australia/Melbourne' })} Melbourne time</p>}
        </div>
        {/* Instruction */}
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
          <p className="text-xs text-gray-600 text-center">
            <User className="w-3 h-3 inline mr-1" />
            {selectable ? 'Select a player to search their stats' : 'Next-game research opens when clubs, date and time are confirmed.'}
          </p>
        </div>
        
        {/* Team columns */}
        {selectable && <div
          className="grid grid-cols-2 divide-x divide-gray-200 max-h-[300px] overflow-hidden"
          onWheel={(e) => e.stopPropagation()}
        >
          {/* Home team */}
          <div className="flex flex-col max-h-[300px]">
            <div className="px-3 py-2 bg-gray-100 border-b border-gray-200 flex-shrink-0">
              <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">
                {fixture.home_team_name.split(' ')[0]}
              </span>
            </div>
            <div 
              className="overflow-y-auto flex-1 overscroll-contain"
              onWheel={(e) => {
                e.stopPropagation();
                const target = e.currentTarget;
                const { scrollTop, scrollHeight, clientHeight } = target;
                const isAtTop = scrollTop === 0 && e.deltaY < 0;
                const isAtBottom = scrollTop + clientHeight >= scrollHeight && e.deltaY > 0;
                if (!isAtTop && !isAtBottom) {
                  e.preventDefault();
                }
              }}
            >
              {homePlayers.map((player, idx) => (
                <button
                  key={`home-${idx}`}
                  type="button"
                  onClick={(e) => handlePlayerClick(player, e)}
                  className="w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-green-50 hover:text-green-700 transition-colors border-b border-gray-100 last:border-0"
                >
                  {player}
                </button>
              ))}
            </div>
          </div>
          
          {/* Away team */}
          <div className="flex flex-col max-h-[300px]">
            <div className="px-3 py-2 bg-gray-100 border-b border-gray-200 flex-shrink-0">
              <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">
                {fixture.away_team_name.split(' ')[0]}
              </span>
            </div>
            <div 
              className="overflow-y-auto flex-1 overscroll-contain"
              onWheel={(e) => {
                e.stopPropagation();
                const target = e.currentTarget;
                const { scrollTop, scrollHeight, clientHeight } = target;
                const isAtTop = scrollTop === 0 && e.deltaY < 0;
                const isAtBottom = scrollTop + clientHeight >= scrollHeight && e.deltaY > 0;
                if (!isAtTop && !isAtBottom) {
                  e.preventDefault();
                }
              }}
            >
              {awayPlayers.map((player, idx) => (
                <button
                  key={`away-${idx}`}
                  type="button"
                  onClick={(e) => handlePlayerClick(player, e)}
                  className="w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-green-50 hover:text-green-700 transition-colors border-b border-gray-100 last:border-0"
                >
                  {player}
                </button>
              ))}
            </div>
          </div>
        </div>}
      </HoverCardContent>
    </HoverCard>
  );
}

export default UpcomingGamesBanner;
