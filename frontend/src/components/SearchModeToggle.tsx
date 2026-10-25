"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface SearchModeToggleProps {
  className?: string;
}

const SearchModeToggle = ({ className }: SearchModeToggleProps) => {
  const pathname = usePathname();
  const isSingle = pathname?.startsWith("/single");
  const isSgm = pathname?.startsWith("/sgm");
  const isMulti = pathname?.startsWith("/multi");
  const isHome = pathname === "/";
  const isVault = pathname?.startsWith("/vault");

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      <Link
        href="/"
        className={cn(
          "rounded-xl border px-4 py-2 text-xs font-semibold transition-all sm:text-sm",
          isHome
            ? "border-gray-900 bg-gray-900 text-white shadow-sm"
            : "border-black/10 bg-white/80 text-gray-700 hover:border-gray-300 hover:bg-white"
        )}
      >
        Home
      </Link>
      <Link
        href="/single"
        className={cn(
          "rounded-xl border px-4 py-2 text-xs font-semibold transition-all sm:text-sm",
          isSingle
            ? "border-gray-900 bg-gray-900 text-white shadow-sm"
            : "border-black/10 bg-white/80 text-gray-700 hover:border-gray-300 hover:bg-white"
        )}
      >
        Single Search
      </Link>
      <Link
        href="/sgm"
        className={cn(
          "rounded-xl border px-4 py-2 text-xs font-semibold transition-all sm:text-sm",
          isSgm
            ? "border-gray-900 bg-gray-900 text-white shadow-sm"
            : "border-black/10 bg-white/80 text-gray-700 hover:border-gray-300 hover:bg-white"
        )}
      >
        SGM Search
      </Link>
      <Link
        href="/multi"
        className={cn(
          "rounded-xl border px-4 py-2 text-xs font-semibold transition-all sm:text-sm",
          isMulti
            ? "border-gray-900 bg-gray-900 text-white shadow-sm"
            : "border-black/10 bg-white/80 text-gray-700 hover:border-gray-300 hover:bg-white"
        )}
      >
        Multi Search
      </Link>
      <Link
        href="/vault"
        className={cn(
          "rounded-xl border px-4 py-2 text-xs font-semibold transition-all sm:text-sm",
          isVault
            ? "border-gray-900 bg-gray-900 text-white shadow-sm"
            : "border-black/10 bg-white/80 text-gray-700 hover:border-gray-300 hover:bg-white"
        )}
      >
        My Vault
      </Link>
    </div>
  );
};

export default SearchModeToggle;

