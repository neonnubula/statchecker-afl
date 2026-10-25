// Server-side authorization for the detail projections of a metered search.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RECEIPT_TTL_MS = 30 * 60 * 1000;
const DOMAIN = 'statchecker:research-details:v1:';
const STATS = new Set(['disposals', 'goals', 'marks', 'tackles', 'kicks', 'handballs', 'clearances', 'hit_outs']);
const optional = value => value === undefined || value === null || value === '';
const text = value => optional(value) ? null : typeof value === 'string' && value.trim().length <= 160 ? value.trim() : undefined;
const integer = value => optional(value) ? null : ['string', 'number'].includes(typeof value) && /^(?:0|[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
const year = value => { const n = integer(value); return n === null || (n >= 1900 && n <= 2100) ? n : undefined; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allowedKeys = (input, names) => Object.keys(input).every(key => names.includes(key));

export function validSingleResearchInput(input) {
  return STATS.has(input.stat) && !optional(input.threshold)
    && typeof input.threshold !== 'object' && Number.isFinite(Number(input.threshold))
    && (input.strict_over === undefined || ['true', 'false'].includes(input.strict_over));
}

function identity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = integer(input.player_id), name = text(input.player_name);
  if (id > 0 && name === null) return { player_id: id };
  if (id === null && name) return { player_name: name };
  return null;
}

function seasons(input) {
  const from = year(input.season_from), to = year(input.season_to);
  if (from === undefined || to === undefined || (from !== null && to !== null && from > to)) return null;
  return { season_from: from, season_to: to };
}

function singleProjection(input) {
  const player = identity(input), range = seasons(input);
  if (!player || !range) return null;
  return { ...player, ...range, game_type: 'all' };
}

function sgmProjection(input) {
  if (!Array.isArray(input?.selections) || input.selections.length < 1 || input.selections.length > 12) return null;
  const selections = input.selections.map(selection => {
    const player = identity(selection);
    if (!player || !STATS.has(selection.stat) || typeof selection.threshold !== 'number' || !Number.isFinite(selection.threshold)
      || (!optional(selection.strict_over) && typeof selection.strict_over !== 'boolean')) return null;
    return { ...player, stat: selection.stat, threshold: selection.threshold, strict_over: selection.strict_over ?? false };
  });
  const range = seasons(input);
  const location = text(input.location), opponent = text(input.opponent), venue = text(input.venue);
  const normalizedGameType = text(input.game_type);
  const gameType = normalizedGameType === null ? 'all' : normalizedGameType;
  if (selections.some(s => !s) || !range || ![null, 'home', 'away'].includes(location)
    || opponent === undefined || venue === undefined || !['all', 'regular', 'finals'].includes(gameType)) return null;
  return { selections, bet_mode: 'over_under', ...range, location, opponent, venue, game_type: gameType };
}

function signature(encoded, secret) {
  return createHmac('sha256', secret).update(DOMAIN + encoded).digest();
}

function researchIdentity(kind, input) {
  if (kind === 'single') {
    const player = identity(input);
    const strict = input.strict_over ?? false;
    if (!player || !STATS.has(input.stat) || optional(input.threshold)
      || !['number', 'string'].includes(typeof input.threshold) || !Number.isFinite(Number(input.threshold))
      || ![true, false, 'true', 'false'].includes(strict)) return null;
    return { ...player, stat: input.stat, threshold: Number(input.threshold), strict_over: strict === true || strict === 'true' };
  }
  const projection = sgmProjection(input);
  const mode = input.bet_mode ?? 'over_under';
  return projection && ['over_under', 'win_loss'].includes(mode) ? { selections: projection.selections, bet_mode: mode } : null;
}

const FILTERS = ['season_from', 'season_to', 'date_from', 'date_to', 'location', 'opponent', 'venue', 'game_type', 'days_rest_min', 'days_rest_max'];
function validContextFilters(input) {
  if (!seasons(input) || ![null, 'home', 'away'].includes(text(input.location))
    || text(input.opponent) === undefined || text(input.venue) === undefined
    || ![null, 'all', 'regular', 'finals'].includes(text(input.game_type))) return false;
  for (const name of ['date_from', 'date_to']) {
    const value = input[name];
    if (!optional(value) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return false;
  }
  if (!optional(input.date_from) && !optional(input.date_to) && input.date_from > input.date_to) return false;
  const min = integer(input.days_rest_min), max = integer(input.days_rest_max);
  return min !== undefined && max !== undefined && (min === null || min <= 365)
    && (max === null || max <= 365) && (min === null || max === null || min <= max);
}

export function issueResearchReceipt({ userId, kind, request, secret, now = Date.now() }) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof userId !== 'string' || !userId || userId.length > 200 || !Number.isSafeInteger(now)) return null;
  const projection = kind === 'single' ? singleProjection(request) : kind === 'sgm' ? sgmProjection(request) : null;
  const research = researchIdentity(kind, request);
  if (!projection || !research) return null;
  const restYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Australia/Melbourne', year: 'numeric' }).format(new Date(now)));
  const payload = { v: 1, sub: userId, kind, projection, research, restYear, iat: now, exp: now + RECEIPT_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${encoded}.${signature(encoded, secret).toString('base64url')}`;
  return token.length <= 8192 ? { token, expiresAt: payload.exp } : null;
}

function readReceipt({ token, userId, secret, now = Date.now() }) {
  try {
    if (typeof secret !== 'string' || secret.length < 32 || typeof token !== 'string' || token.length > 8192 || !Number.isSafeInteger(now)) return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
    const [encoded, supplied] = parts;
    const decodedSignature = Buffer.from(supplied, 'base64url');
    const expectedSignature = signature(encoded, secret);
    if (decodedSignature.length !== expectedSignature.length || decodedSignature.toString('base64url') !== supplied || !timingSafeEqual(decodedSignature, expectedSignature)) return false;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.sub !== userId || !['single', 'sgm'].includes(payload.kind)
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.exp - payload.iat !== RECEIPT_TTL_MS || now >= payload.exp || payload.iat > now + 30000) return false;
    return payload;
  } catch { return false; }
}

// Comparison panels may vary documented filters, but never the charged
// player/stat/threshold/selection order. They share the original expiry and a
// separate resource ceiling; successful context requests cannot mint receipts.
export function verifyResearchContext(options) {
  try {
    const payload = readReceipt(options);
    const { kind, request } = options;
    if (!payload || payload.kind !== kind || !validContextFilters(request)) return false;
    const names = kind === 'single' ? ['player_id', 'player_name', 'stat', 'threshold', 'strict_over'] : ['selections', 'bet_mode'];
    if (!allowedKeys(request, [...names, ...FILTERS])) return false;
    if (kind === 'sgm' && (!Array.isArray(request.selections) || !request.selections.every(s => allowedKeys(s, ['player_id', 'player_name', 'stat', 'threshold', 'strict_over'])))) return false;
    const research = researchIdentity(kind, request);
    return research !== null && same(research, payload.research);
  } catch { return false; }
}

export function verifyResearchReceipt(options) {
  try {
    const payload = readReceipt(options);
    const { kind, request } = options;
    if (!payload) return false;
    if (kind === 'sgm') {
      if (payload.kind !== 'sgm' || !allowedKeys(request, ['selections', 'bet_mode', 'season_from', 'season_to', 'location', 'opponent', 'venue', 'game_type'])
        || request.bet_mode !== 'over_under') return false;
      if (!request.selections.every(s => allowedKeys(s, ['player_id', 'player_name', 'stat', 'threshold', 'strict_over']))) return false;
      const projection = sgmProjection(request);
      return projection !== null && same(projection, payload.projection);
    }
    if (kind !== 'single' || !allowedKeys(request, ['player_id', 'player_name', 'season_from', 'season_to', 'game_type', 'without_player_id'])
      || (!optional(request.game_type) && request.game_type !== 'all')) return false;
    const projection = singleProjection(request), without = integer(request.without_player_id);
    if (!projection || without === undefined || without === 0) return false;
    // Table filters/flags are computed from all games in the submitted seasons.
    // The existing "without teammate" table remains within that player's grant.
    if (payload.kind === 'single' && same(projection, payload.projection)) return true;
    // Rest labels need the current/prior-season log of an already selected
    // player, even when the paid search was restricted to older seasons.
    if (without !== null || projection.season_from !== payload.restYear - 1 || projection.season_to !== payload.restYear) return false;
    const players = payload.kind === 'single' ? [identity(payload.projection)] : payload.projection.selections.map(identity);
    return players.some(player => same(player, identity(request)));
  } catch {
    return false;
  }
}
