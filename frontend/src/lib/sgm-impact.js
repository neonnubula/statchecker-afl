import { analyticsHeaders } from './analytics-client.js';

const STATS = new Set(['disposals', 'goals', 'marks', 'tackles', 'kicks', 'handballs', 'clearances', 'hit_outs']);

/** Stable submitted selections only; repeated lines share independent player/stat context. */
export function sgmImpactTargets(request) {
  if (!Array.isArray(request?.selections) || request.selections.length > 12) return [];
  const seen = new Set();
  return request.selections.flatMap((selection, selectionIndex) => {
    const byId = Number.isSafeInteger(selection?.player_id) && selection.player_id > 0 && !selection.player_name;
    const byName = selection?.player_id == null && typeof selection?.player_name === 'string' && selection.player_name.trim();
    if ((!byId && !byName) || !STATS.has(selection.stat)) return [];
    const key = JSON.stringify([byId ? selection.player_id : selection.player_name.trim(), selection.stat]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, selectionIndex, selection }];
  });
}

/** A bounded worker pool avoids one upstream request per leg starting at once. */
export async function loadSgmImpacts({ request, receipt, endpoint, signal, onResult, fetcher = fetch }) {
  const targets = sgmImpactTargets(request);
  let next = 0;
  async function worker() {
    while (!signal.aborted && next < targets.length) {
      const target = targets[next++];
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 40000);
      try {
        if (signal.aborted) break;
        const response = await fetcher(endpoint, {
          method: 'POST', cache: 'no-store', signal: controller.signal,
          headers: { ...analyticsHeaders(undefined), 'Content-Type': 'application/json', 'x-search-purpose': 'context',
            ...(receipt ? { 'x-search-receipt': receipt } : {}) },
          body: JSON.stringify({ request, selection_index: target.selectionIndex }),
        });
        if (!response.ok) throw new Error(response.status === 403
          ? 'Run this multi-player search again to load its player context.'
          : 'Player schedule comparisons are temporarily unavailable.');
        const data = await response.json();
        if (data.schema_version !== 1 || data.stat !== target.selection.stat || !data.finals
          || !data.history_scope || !data.rest || !data.travel || !data.upcoming
          || (target.selection.player_id != null && data.player_id !== target.selection.player_id)) {
          throw new Error('Player comparison data did not match this selection.');
        }
        if (!signal.aborted) onResult(target.key, { data });
      } catch (error) {
        if (!signal.aborted) onResult(target.key, { error: error.name === 'AbortError'
          ? 'Player comparisons took too long. Run the multi-player search again to retry.' : error.message });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, worker));
}
