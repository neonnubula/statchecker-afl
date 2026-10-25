// Shared, deliberately small vocabulary. Never send search text, player names,
// receipt tokens, email addresses, user IDs or arbitrary exception messages.
export const ANALYTICS_BROWSER_EVENTS = [
  'page_view', 'preview_interacted', 'membership_viewed', 'checkout_requested',
  'registration_submitted', 'research_started', 'research_results_viewed',
  'research_client_failed', 'web_vital', 'feature_used', 'cta_clicked',
  'registration_submission_succeeded', 'registration_client_failed', 'checkout_client_failed',
];
export const ANALYTICS_SERVER_EVENTS = [
  'research_completed', 'research_failed', 'research_blocked', 'checkout_created',
  'checkout_failed', 'registration_completed', 'purchase_completed', 'account_setup_completed',
];
export const ANALYTICS_FEATURES = ['page', 'base', 'uplift', 'weights', 'membership', 'registration', 'checkout', 'single', 'sgm', 'multi', 'vault', 'account', 'contact', 'performance', 'detail', 'impact', 'brief'];
export const validAnalyticsUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function sanitizeCampaignToken(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value) && !/\d{8}/.test(value) ? value.toLowerCase() : null;
}
export function sanitizePathname(value) {
  if (typeof value !== 'string') return null;
  const path = value.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/';
  if (/^\/(?:nba-preview|membership|dashboard|search|sgm|multi|vault|account|contact|privacy|terms|plans|welcome|nba|blog|sign-in|sign-up)?$/.test(path)) return path;
  if (/^\/blog\/[a-z0-9-]{1,120}$/.test(path)) return path;
  if (/^\/purchase\/(?:success|cancel)$/.test(path)) return path;
  if (['/single', '/members', '/dashboard/vault', '/afl/context', '/nba-preview/method', '/nba-research-tools'].includes(path)) return path;
  if (/^\/api\/search\/(?:over-under|sgm|game-log|sgm-game-log|player-impact|sgm-player-impact)$/.test(path)) return path;
  if (/^\/api\/nba\/(?:research|brief)$/.test(path)) return path;
  return null;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const optionalEnum = (value, choices) => value == null || choices.includes(value);
const fields = ['event_id', 'event_name', 'occurred_at', 'session_id', 'request_id', 'product', 'feature', 'outcome', 'duration_ms', 'result_count_bucket', 'pathname', 'device', 'source', 'medium', 'campaign', 'properties'];
export function normalizeBrowserOccurrence(value, now = Date.now()) {
  if (value == null) return new Date(now).toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value
    || timestamp < now - 86400000 || timestamp > now + 300000) return null;
  // Browser clocks are untrusted. A slightly fast clock cannot create future events.
  return new Date(Math.min(timestamp, now)).toISOString();
}
export function normalizeAnalyticsProperties(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !['action', 'view', 'cached', 'metric', 'value', 'rating', 'sample_rate', 'cta'].includes(key))) return null;
  if (!optionalEnum(input.action, ['open', 'select', 'change', 'reset', 'save', 'add', 'portal', 'sync', 'complete', 'click'])
    || !optionalEnum(input.view, ['base', 'uplift', 'weights'])
    || !optionalEnum(input.metric, ['CLS', 'FCP', 'INP', 'LCP', 'TTFB'])
    || !optionalEnum(input.rating, ['good', 'needs-improvement', 'poor'])
    || (input.cached != null && typeof input.cached !== 'boolean')
    || (input.value != null && (!Number.isFinite(input.value) || input.value < 0 || input.value > 300000))
    || (input.sample_rate != null && input.sample_rate !== 0.1)
    || (input.cta != null && !sanitizeCampaignToken(input.cta))) return null;
  return { ...input };
}
export function normalizeBrowserEvent(event, now = Date.now()) {
  if (!object(event) || Object.keys(event).some(key => !fields.includes(key))
    || !ANALYTICS_BROWSER_EVENTS.includes(event.event_name) || !validAnalyticsUuid(event.event_id)
    || (event.session_id != null && !validAnalyticsUuid(event.session_id))
    || (event.request_id != null && !validAnalyticsUuid(event.request_id))
    || !['afl', 'nba_preview', 'nba', 'site'].includes(event.product)
    || !optionalEnum(event.feature, ANALYTICS_FEATURES)
    || !optionalEnum(event.outcome, ['success', 'empty', 'failure', 'blocked', 'error', 'limit', 'unauthorized'])
    || !optionalEnum(event.device, ['mobile', 'desktop', 'unknown'])
    || !optionalEnum(event.result_count_bucket, ['0', '1', '2-10', '11-50', '51+'])
    || (event.duration_ms != null && (!Number.isFinite(event.duration_ms) || event.duration_ms < 0 || event.duration_ms > 300000))) return null;
  const properties = normalizeAnalyticsProperties(event.properties);
  const occurred_at = normalizeBrowserOccurrence(event.occurred_at, now);
  if (!properties || !occurred_at) return null;
  return { ...event, occurred_at, pathname: sanitizePathname(event.pathname),
    source: sanitizeCampaignToken(event.source), medium: sanitizeCampaignToken(event.medium), campaign: sanitizeCampaignToken(event.campaign),
    session_id: event.session_id || null, request_id: event.request_id || null, device: event.device || 'unknown', properties };
}
