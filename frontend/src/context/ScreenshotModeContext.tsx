"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const SCREENSHOT_MODE_STORAGE_KEY = "statchecker:screenshot-mode";

type ScreenshotModeContextValue = {
  screenshotMode: boolean;
  setScreenshotMode: (enabled: boolean) => void;
  toggleScreenshotMode: () => void;
};

const ScreenshotModeContext = createContext<ScreenshotModeContextValue | null>(null);

export function ScreenshotModeProvider({ children }: { children: React.ReactNode }) {
  const [screenshotMode, setScreenshotMode] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      setHydrated(true);
      return;
    }

    const storedValue = window.localStorage.getItem(SCREENSHOT_MODE_STORAGE_KEY);
    if (storedValue !== null) {
      setScreenshotMode(storedValue === "true");
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(SCREENSHOT_MODE_STORAGE_KEY, String(screenshotMode));
  }, [hydrated, screenshotMode]);

  const toggleScreenshotMode = useCallback(() => {
    setScreenshotMode((prev) => !prev);
  }, []);

  const value = useMemo(
    () => ({
      screenshotMode,
      setScreenshotMode,
      toggleScreenshotMode,
    }),
    [screenshotMode, toggleScreenshotMode]
  );

  return <ScreenshotModeContext.Provider value={value}>{children}</ScreenshotModeContext.Provider>;
}

export function useScreenshotMode() {
  const context = useContext(ScreenshotModeContext);

  if (!context) {
    return {
      screenshotMode: false,
      setScreenshotMode: () => {},
      toggleScreenshotMode: () => {},
    };
  }

  return context;
}
