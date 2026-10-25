"use client";

import { useEffect, useMemo, useState } from 'react';
import type { SgmRequest } from '@/lib/api/types';
import { loadSgmImpacts, sgmImpactTargets } from '@/lib/sgm-impact.js';
import { PlayerImpactPanel, type PlayerImpactData } from './PlayerImpactPanel';

type Result = { data?: PlayerImpactData; error?: string };

/** Each card is independent player research, never a combined SGM adjustment. */
export default function SgmPlayerImpactResearch({ request, receipt, label }: {
  request: SgmRequest; receipt?: string; label?: string;
}) {
  const targets = useMemo(() => sgmImpactTargets(request), [request]);
  const [loaded, setLoaded] = useState<{ request: SgmRequest; receipt?: string; results: Record<string, Result> } | null>(null);
  const dev = process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DEV_MODE === 'true';
  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ request, receipt, results: {} });
    if (!dev && !receipt) return () => controller.abort();
    void loadSgmImpacts({ request, receipt, signal: controller.signal,
      endpoint: `${dev ? '/dev/api' : '/api'}/search/sgm-player-impact`,
      onResult: (key: string, result: Result) => setLoaded(previous =>
        previous?.request === request && previous.receipt === receipt
          ? { ...previous, results: { ...previous.results, [key]: result } } : previous),
    });
    return () => controller.abort();
  }, [request, receipt, dev]);
  if (!targets.length) return null;
  const results = loaded?.request === request && loaded.receipt === receipt ? loaded.results : {};
  return <section aria-label={label ? `${label} player schedule comparisons` : 'Multi-player schedule comparisons'} className="mt-6 space-y-4">
    <header><h2 className="text-lg font-semibold text-slate-900">{label ? `${label} · ` : ''}Player schedule comparisons</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">Turnaround and travel for each selected player and stat. These are independent comparisons and do not change the combined multi-player result.</p></header>
    {targets.map(target => {
      const result = results[target.key];
      return result?.data ? <PlayerImpactPanel key={target.key} data={result.data} />
        : <div key={target.key} aria-live="polite" className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <p className="font-medium text-slate-900">{target.selection.player_name || `Selected player ${target.selectionIndex + 1}`} · {target.selection.stat.replaceAll('_', '-')}</p>
          <p className="mt-1">{!dev && !receipt ? 'Run this multi-player search again to load its player context.'
            : result?.error || 'Loading player turnaround and travel comparisons…'}</p>
        </div>;
    })}
  </section>;
}
