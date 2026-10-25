import { createHmac, randomUUID } from 'node:crypto';
import { ANALYTICS_SERVER_EVENTS, ANALYTICS_FEATURES, normalizeBrowserEvent, normalizeAnalyticsProperties, sanitizePathname, sanitizeCampaignToken, validAnalyticsUuid } from './product-analytics-schema.js';

export function analyticsUserKey(userId, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof userId !== 'string' || !userId) return null;
  return createHmac('sha256', secret).update(`product-analytics:user:${userId}`).digest('hex');
}
export function analyticsEventId(key, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return randomUUID();
  const hex = createHmac('sha256', secret).update(`product-analytics:event:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function analyticsRequestContext(request, trustedPlatform = false) {
  if (!request) return {};
  const optedOut = request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1'
    || request.headers.get('x-analytics-opt-out') === '1'
    || /(?:^|;\s*)sc_analytics_opt_out=1(?:;|$)/.test(request.headers.get('cookie') || '');
  const uuid = name => !optedOut && validAnalyticsUuid(request.headers.get(name)) ? request.headers.get(name) : null;
  const country = trustedPlatform ? request.headers.get('x-vercel-ip-country') : null;
  return { session_id: uuid('x-analytics-session-id'), request_id: uuid('x-analytics-request-id'),
    pathname: sanitizePathname(new URL(request.url).pathname),
    device: /mobile|android|iphone/i.test(request.headers.get('user-agent') || '') ? 'mobile' : 'desktop',
    country: /^[A-Z]{2}$/.test(country || '') ? country : null, optedOut };
}
export function normalizeServerEvent(event) {
  if (!event || !ANALYTICS_SERVER_EVENTS.includes(event.event_name) || !['afl', 'nba_preview', 'nba', 'site'].includes(event.product)
    || (event.feature != null && !ANALYTICS_FEATURES.includes(event.feature))
    || (event.outcome != null && !['success', 'empty', 'failure', 'blocked'].includes(event.outcome))) return null;
  const properties = normalizeAnalyticsProperties(event.properties);
  if (!properties) return null;
  const timestamp = typeof event.occurred_at === 'string' ? Date.parse(event.occurred_at) : NaN;
  return { event_id: validAnalyticsUuid(event.event_id) ? event.event_id : randomUUID(), event_name: event.event_name,
    occurred_at: new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString(),
    product: event.product, feature: event.feature || null, outcome: event.outcome || null,
    duration_ms: Number.isFinite(event.duration_ms) ? Math.round(Math.max(0, Math.min(300000, event.duration_ms))) : null,
    result_count_bucket: ['0', '1', '2-10', '11-50', '51+'].includes(event.result_count_bucket) ? event.result_count_bucket : null,
    session_id: validAnalyticsUuid(event.session_id) ? event.session_id : null,
    request_id: validAnalyticsUuid(event.request_id) ? event.request_id : null,
    pathname: sanitizePathname(event.pathname), device: ['mobile', 'desktop', 'unknown'].includes(event.device) ? event.device : 'unknown',
    source: sanitizeCampaignToken(event.source), medium: sanitizeCampaignToken(event.medium), campaign: sanitizeCampaignToken(event.campaign), properties };
}
export function resultCountBucket(count) {
  return !Number.isFinite(count) || count < 0 ? null : count === 0 ? '0' : count === 1 ? '1' : count <= 10 ? '2-10' : count <= 50 ? '11-50' : '51+';
}
export function researchResultCount(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const result = payload.result || payload;
  if (Number.isFinite(result.over) && Number.isFinite(result.under)) return result.over + result.under;
  if (Number.isFinite(result.total)) return result.total;
  if (Number.isFinite(result.matched_games)) return result.matched_games;
  if (Number.isFinite(result.observed?.settled_games)) return result.observed.settled_games + (result.observed.pushes || 0);
  if (Array.isArray(result.games)) return result.games.length;
  return null;
}
export function researchOutcomeEvent({ status, duration_ms, count, product, feature, request_id }) {
  const blocked = [401, 403, 429].includes(status);
  const success = status >= 200 && status < 300;
  return { event_name: blocked ? 'research_blocked' : success ? 'research_completed' : 'research_failed',
    product, feature, request_id, duration_ms,
    outcome: blocked ? 'blocked' : success ? count === 0 ? 'empty' : 'success' : 'failure',
    result_count_bucket: success ? resultCountBucket(count) : null };
}

const reply = status => new Response(null, { status, headers: { 'Cache-Control': 'private, no-store' } });
export function createAnalyticsCollector({ authenticate, rateLimit, schedule, trustedPlatform = false, now = Date.now }) {
  return async request => {
    if (request.headers.get('origin') !== new URL(request.url).origin
      || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) return reply(403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415);
    if (analyticsRequestContext(request).optedOut || /bot|crawler|spider|headless/i.test(request.headers.get('user-agent') || '')) return reply(204);
    let body;
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply(400);
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 16384) { await reader.cancel(); return reply(413); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      body = JSON.parse(new TextDecoder().decode(data));
    } catch { return reply(400); }
    if (!body || Object.keys(body).join(',') !== 'events' || !Array.isArray(body.events) || !body.events.length || body.events.length > 20) return reply(400);
    const receivedAt = now();
    const events = body.events.map(event => normalizeBrowserEvent(event, receivedAt));
    if (events.some(event => !event)) return reply(400);
    try {
      if (!(await rateLimit(request))) return reply(429);
      const { userId } = await authenticate();
      schedule(events, { request, userId, trustedPlatform });
      return reply(202);
    } catch { return reply(503); }
  };
}
export function createProductEventScheduler({ after, persist, now = Date.now }) {
  return (event, context = {}) => {
    try {
      // Trusted business call sites can preserve the actual payment timestamp
      // across webhook retries. Browser occurrences use their separate validator.
      const supplied = typeof event?.occurred_at === 'string' ? Date.parse(event.occurred_at) : NaN;
      const stamped = { ...event, occurred_at: new Date(Number.isFinite(supplied) ? supplied : now()).toISOString() };
      after(async () => { try { await persist(stamped, context); } catch { /* delivery remains optional */ } });
    } catch { /* Scheduling cannot invalidate a completed customer operation. */ }
  };
}

/** Bound optional identity work; late resolution/rejection remains handled. */
export function resolveAnalyticsWithinBudget(resolveContext, fallback, { timeoutMs = 250, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise(resolve => {
    let finished = false;
    let timer;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      resolve(value);
    };
    timer = setTimer(() => finish(fallback), timeoutMs);
    Promise.resolve().then(resolveContext).then(finish, () => finish(fallback));
  });
}
