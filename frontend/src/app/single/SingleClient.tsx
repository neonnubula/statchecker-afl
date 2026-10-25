"use client";

import React, { useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import NavbarSection from "@/components/landing/NavbarSection";
import FooterSection from "@/components/landing/FooterSection";
import { landingContent } from "@/content";
import SearchModeToggle from "@/components/SearchModeToggle";
import ScreenshotModeToggle from "@/components/ScreenshotModeToggle";
import { Fixture } from "@/lib/api/fixtures";
import type { PlayerStatsDemoRef } from "@/components/PlayerStatsDemo";
import { ScreenshotModeProvider, useScreenshotMode } from "@/context/ScreenshotModeContext";

const PlayerStatsDemo = dynamic(
  () => import("@/components/PlayerStatsDemo").then((mod) => mod.PlayerStatsDemo),
  { ssr: false }
);

const UpcomingGamesBanner = dynamic(
  () => import("@/components/UpcomingGamesBanner").then((mod) => mod.UpcomingGamesBanner),
  { ssr: false }
);

export default function SingleClient() {
  return (
    <ScreenshotModeProvider>
      <SingleClientContent />
    </ScreenshotModeProvider>
  );
}

function SingleClientContent() {
  const { screenshotMode } = useScreenshotMode();
  const playerStatsDemoRef = useRef<PlayerStatsDemoRef>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<number | null>(null);

  const handlePlayerSelect = useCallback((playerName: string, fixture: Fixture) => {
    setSelectedFixtureId(fixture.fixture_id);
    playerStatsDemoRef.current?.setPlayerAndPrepare(playerName);
  }, []);

  const handleGameSelect = useCallback((fixture: Fixture) => {
    setSelectedFixtureId(fixture.fixture_id);
  }, []);

  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground overflow-x-hidden">
      <NavbarSection content={landingContent.navbar} />

      <header className="relative pt-28 pb-8">
        <div className="mx-auto max-w-[1136px] px-6">
          <p className="text-[14px] font-normal text-muted-foreground">Search</p>
          <h1 className="mt-4 text-[40px] md:text-[52px] leading-[1.05] font-medium tracking-[-0.035em]">
            Single Player Search
          </h1>
          <p className="mt-5 max-w-[640px] text-[17px] leading-[1.55] text-muted-foreground">
            Analyze historical AFL player statistics for any prop bet.
          </p>
          <Link href="/afl/context" className="mt-4 inline-flex text-sm text-orange-700 underline underline-offset-4 hover:text-orange-800">Compare match turnaround and ground distance →</Link>
        </div>
      </header>

      <main className="flex-1 pb-8 sm:pb-10">
        <div className="mx-auto max-w-[1136px] px-6">
          {!screenshotMode && (
            <div className="mb-4 rounded-xl border border-pulse-500/20 bg-pulse-500/[0.06] px-4 py-3 text-xs sm:text-sm text-orange-700 font-medium">
              Past performance does not guarantee future performance, always think before you bet.
            </div>
          )}

          <div className="sticky top-16 z-30 -mx-6 mb-6 bg-card backdrop-blur-xl border-b border-border px-6 py-4">
            <SearchModeToggle className="mb-3" />
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Upcoming Games</span>
              <span className="text-[10px] text-muted-foreground">Tap a game or player to search</span>
            </div>
            <UpcomingGamesBanner
              onPlayerSelect={handlePlayerSelect}
              onGameSelect={handleGameSelect}
              selectedFixtureId={selectedFixtureId}
            />
          </div>

          <PlayerStatsDemo ref={playerStatsDemoRef} />
        </div>
      </main>
      <FooterSection />
      <ScreenshotModeToggle />
    </main>
  );
}
