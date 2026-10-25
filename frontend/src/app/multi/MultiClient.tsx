"use client";

import React from "react";
import dynamic from "next/dynamic";
import NavbarSection from "@/components/landing/NavbarSection";
import FooterSection from "@/components/landing/FooterSection";
import { landingContent } from "@/content";
import SearchModeToggle from "@/components/SearchModeToggle";
import ScreenshotModeToggle from "@/components/ScreenshotModeToggle";
import { ScreenshotModeProvider, useScreenshotMode } from "@/context/ScreenshotModeContext";

const MultiDemo = dynamic(
  () => import("@/components/MultiDemo").then((mod) => mod.MultiDemo),
  { ssr: false }
);

export default function MultiClient() {
  return (
    <ScreenshotModeProvider>
      <MultiClientContent />
    </ScreenshotModeProvider>
  );
}

function MultiClientContent() {
  const { screenshotMode } = useScreenshotMode();

  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground overflow-x-hidden">
      <NavbarSection content={landingContent.navbar} />

      <header className="relative pt-28 pb-8">
        <div className="mx-auto max-w-[1136px] px-6">
          <p className="text-[14px] font-normal text-muted-foreground">Search</p>
          <h1 className="mt-4 text-[40px] md:text-[52px] leading-[1.05] font-medium tracking-[-0.035em]">
            Multi Builder
          </h1>
          <p className="mt-5 max-w-[640px] text-[17px] leading-[1.55] text-muted-foreground">
            Combine independent legs from single search and model the combined probability.
          </p>
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
            <SearchModeToggle />
          </div>

          <MultiDemo />
        </div>
      </main>
      <FooterSection />
      <ScreenshotModeToggle />
    </main>
  );
}
