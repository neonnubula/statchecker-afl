import { issueResearchReceipt, verifyResearchReceipt, verifyResearchContext, validSingleResearchInput } from './research-receipt.js';
import { randomUUID } from 'node:crypto';
import { analyticsRequestContext, researchResultCount, researchOutcomeEvent } from './product-analytics.js';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const rerun = () => Response.json({ detail: 'Run this search again to load its details.' }, { status: 403, headers: HEADERS });
const unavailable = () => Response.json({ detail: 'Search is temporarily unavailable. Please try again shortly.' }, { status: 503, headers: HEADERS });
const rateHeaders = rate => ({
  'X-RateLimit-Limit': String(rate.limit),
  'X-RateLimit-Remaining': String(rate.remaining),
  'X-RateLimit-Reset': String(Math.floor(rate.resetAt / 1000)),
  ...(rate.reason ? { 'X-RateLimit-Reason': rate.reason } : {}),
});

async function inputFrom(request, kind) {
  if (kind === 'single') {
    if (request.url.length > 8192) throw new RangeError('Query too large');
    const params = new URL(request.url).searchParams;
    if (new Set(params.keys()).size !== [...params.keys()].length) throw new SyntaxError('Duplicate parameter');
    return Object.fromEntries(params);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing body');
  const decoder = new TextDecoder();
  let body = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) { await reader.cancel(); throw new RangeError('Body too large'); }
      body += decoder.decode(value, { stream: true });
    }
    const parsed = JSON.parse(body + decoder.decode());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('Invalid object');
    return parsed;
  } finally { reader.releaseLock(); }
}

/** Dependency-injected real proxy path; tests never load credentials/providers. */
export function createSearchProxy({ auth, authorize, planForUser, consumeRateLimit, consumeDetailRateLimit, fetch: fetchBackend, getBaseUrl, getSecret, now = Date.now, scheduleEvent = (_event, _context) => {} }) {
  const execute = async function handle(request, { kind, detail = false, impact = false, onIdentity = () => {}, onResult = () => {} }) {
    try {
      const { userId } = await auth();
      onIdentity(userId);
      if (!userId) return Response.json({ detail: 'Unauthorized' }, { status: 401, headers: HEADERS });
      if (typeof authorize !== 'function' || !(await authorize(userId))) return Response.json({ detail: 'Complete your account and verify your email to continue.', next: '/welcome' }, { status: 403, headers: HEADERS });
      const secret = getSecret();
      if (typeof secret !== 'string' || secret.length < 32) return unavailable();
      let input;
      try { input = await inputFrom(request, kind); }
      catch (error) { return Response.json({ detail: 'Invalid search request.' }, { status: error instanceof RangeError ? 413 : 400, headers: HEADERS }); }
      const receipt = request.headers.get('x-search-receipt');
      const purpose = request.headers.get('x-search-purpose');
      let impactSelection = null;
      if (impact && kind === 'sgm') {
        if (Object.keys(input).sort().join(',') !== 'request,selection_index'
          || !Number.isSafeInteger(input.selection_index) || input.selection_index < 0
          || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)
          || !Array.isArray(input.request.selections) || input.selection_index >= input.request.selections.length) return rerun();
        impactSelection = input.request.selections[input.selection_index];
        input = input.request;
      }
      if (impact && (!['single', 'sgm'].includes(kind) || !receipt)) return rerun();
      const context = impact || (!detail && purpose === 'context');
      let responseRateHeaders = {};
      if ((detail && receipt) || context) {
        const verify = context ? verifyResearchContext : verifyResearchReceipt;
        if (!verify({ token: receipt, userId, kind, request: input, secret, now: now() })) return rerun();
        const rate = await consumeDetailRateLimit({ userId });
        if (!rate.allowed) return Response.json({ detail: 'Too many detail requests. Please wait a moment.' }, {
          status: 429, headers: { ...HEADERS, 'Retry-After': String(Math.max(1, Math.ceil((rate.resetAt - now()) / 1000))) },
        });
      } else {
        // A label is never authorization. Missing/expired automatic detail
        // requests must not quietly spend another research burst allowance.
        if (purpose && purpose !== 'user') return rerun();
        if (!detail && ((kind === 'single' && !validSingleResearchInput(input)) || !issueResearchReceipt({ userId, kind, request: input, secret, now: now() }))) {
          return Response.json({ detail: 'Invalid search request.' }, { status: 400, headers: HEADERS });
        }
        if (detail) {
          const resource = await consumeDetailRateLimit({ userId });
          if (!resource.allowed) return Response.json({ detail: 'Too many detail requests. Please wait a moment.' }, {
            status: 429, headers: { ...HEADERS, 'Retry-After': String(Math.max(1, Math.ceil((resource.resetAt - now()) / 1000))) },
          });
        }
        const plan = await planForUser(userId);
        const rate = await consumeRateLimit({ userId, plan, bucket: kind });
        responseRateHeaders = rateHeaders(rate);
        if (!rate.allowed) return Response.json({ detail: 'Too many searches in a short time. Please wait a moment and try again.' }, { status: 429, headers: { ...HEADERS, ...responseRateHeaders } });
      }
      const endpoint = impact ? 'player-impact' : detail ? (kind === 'single' ? 'game-log' : 'sgm-game-log') : (kind === 'single' ? 'over-under' : 'sgm');
      // The entire original SGM research grant was verified above. Only now
      // project its selected leg to read-only player context; never mint a new grant.
      const impactQuery = impactSelection ? new URLSearchParams({
        ...(impactSelection.player_id != null ? { player_id: String(impactSelection.player_id) } : { player_name: impactSelection.player_name }),
        stat: impactSelection.stat,
      }).toString() : null;
      const target = `${getBaseUrl()}/search/${endpoint}${impactQuery ? '?' + impactQuery : kind === 'single' ? '?' + new URL(request.url).searchParams.toString() : ''}`;
      const backend = await fetchBackend(target, {
        method: impact || kind === 'single' ? 'GET' : 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        ...(kind === 'sgm' && !impact ? { body: JSON.stringify(input) } : {}),
        signal: AbortSignal.timeout(impact ? 35000 : 20000),
      });
      const body = await backend.text();
      // Primary summary payloads are small. Do not parse large game logs or
      // player-context payloads a second time solely for telemetry.
      if (backend.ok && !detail && !impact) { try { onResult(researchResultCount(JSON.parse(body))); } catch { /* payload remains unchanged */ } }
      const headers = { ...HEADERS, ...responseRateHeaders, 'Content-Type': backend.headers.get('content-type') ?? 'application/json' };
      if (backend.ok && !detail && !context) {
        // Mint only after the authorized backend search has actually succeeded.
        const result = issueResearchReceipt({ userId, kind, request: input, secret, now: now() });
        if (!result) return unavailable();
        headers['x-search-receipt'] = result.token;
        headers['x-search-receipt-expires-at'] = String(result.expiresAt);
      }
      return new Response(body, { status: backend.status, headers });
    } catch {
      // Storage, Clerk, configuration and network failures fail closed. No
      // customer IDs, token contents or raw provider exceptions reach logs.
      return unavailable();
    }
  };
  return async function trackedSearch(request, options) {
    const start = now();
    const request_id = analyticsRequestContext(request).request_id || randomUUID();
    let userId = null, count = null;
    const response = await execute(request, { ...options, onIdentity: id => { userId = id; }, onResult: result => { count = result; } });
    response.headers.set('x-analytics-request-id', request_id);
    try {
      if (!analyticsRequestContext(request).optedOut) scheduleEvent(researchOutcomeEvent({ status: response.status, duration_ms: now() - start, count,
        product: 'afl', feature: options.impact ? 'impact' : options.detail || request.headers.get('x-search-purpose') === 'context' ? 'detail' : options.kind, request_id }), { request, userId });
    } catch { /* Analytics cannot change research success, errors or quota handling. */ }
    return response;
  };
}
