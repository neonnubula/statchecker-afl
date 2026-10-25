"use client";

import { Camera } from "lucide-react";
import { useScreenshotMode } from "@/context/ScreenshotModeContext";

export default function ScreenshotModeToggle() {
  const { screenshotMode, toggleScreenshotMode } = useScreenshotMode();

  return (
    <button
      type="button"
      onClick={toggleScreenshotMode}
      className={`fixed bottom-4 right-4 z-50 h-7 w-7 rounded-full border backdrop-blur-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
        screenshotMode
          ? "border-emerald-400/60 bg-emerald-100/70 text-emerald-700 opacity-70 hover:opacity-90"
          : "border-gray-300/60 bg-[#faf7f0]/70 text-gray-500 opacity-20 hover:opacity-60"
      }`}
      aria-label={screenshotMode ? "Disable screenshot mode" : "Enable screenshot mode"}
      title={screenshotMode ? "Disable screenshot mode" : "Enable screenshot mode"}
    >
      <Camera className="mx-auto h-3.5 w-3.5" />
    </button>
  );
}
