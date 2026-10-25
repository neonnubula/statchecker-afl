/**
 * localStorage-backed store for the Multi "cart" — the set of legs the user is
 * combining. Selections persist across navigation and sessions until the user
 * explicitly clears them. Mirrors the existing `statchecker:pending-search`
 * localStorage usage in PlayerStatsDemo.tsx (SSR-guarded, try/catch wrapped).
 *
 * No network involved: legs are snapshots captured from a single search, so
 * combining them costs zero rate-limit tokens.
 */

import type { LegSnapshot } from '@/lib/multi-types';

export const MULTI_CART_KEY = 'statchecker:multi-cart';

const isBrowser = () => typeof window !== 'undefined';

/** Read the current cart. Returns [] on SSR, missing key, or parse failure. */
export const readCart = (): LegSnapshot[] => {
  if (!isBrowser()) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(MULTI_CART_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LegSnapshot[]) : [];
  } catch {
    return [];
  }
};

const writeCart = (legs: LegSnapshot[]): LegSnapshot[] => {
  if (isBrowser()) {
    try {
      window.localStorage.setItem(MULTI_CART_KEY, JSON.stringify(legs));
    } catch {
      // ignore quota / serialization errors — cart is best-effort
    }
  }
  return legs;
};

/** Append a leg and return the updated cart. */
export const addLeg = (leg: LegSnapshot): LegSnapshot[] => writeCart([...readCart(), leg]);

/** Remove a leg by id and return the updated cart. */
export const removeLeg = (id: string): LegSnapshot[] =>
  writeCart(readCart().filter((leg) => leg.id !== id));

/** Replace the entire cart (used when hydrating a saved multi from the vault). */
export const setCart = (legs: LegSnapshot[]): LegSnapshot[] => writeCart(legs);

/** Empty the cart. */
export const clearCart = (): LegSnapshot[] => writeCart([]);
