"""Server-side, cached AFL schedule research; no player-database access.

Squiggle requirements: https://api.squiggle.com.au/#requirements
One whole-season fetch supports every club's prior-match context, then serves all
users from a six-hour process cache. This is not a live scores feed. Register
this router with the main application's _require_internal_secret dependency.
"""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
from threading import Lock
import time
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
import httpx

from app.afl_context import LEAGUE_ZONE, build_context

router = APIRouter(prefix='/afl', tags=['AFL match context'])
SOURCE_URL = 'https://api.squiggle.com.au/'
USER_AGENT = os.getenv('SCHEDULE_USER_AGENT', 'StatChecker open-source AFL research (set SCHEDULE_USER_AGENT to include your contact)')
CACHE_TTL_SECONDS = 6 * 60 * 60
ERROR_COOLDOWN_SECONDS = 15 * 60
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
FETCH_DEADLINE_SECONDS = 20
VENUES_PATH = Path(__file__).resolve().parents[1] / 'data' / 'afl_venues.json'
CONFIRMATIONS_PATH = Path(__file__).resolve().parents[1] / 'data' / 'afl_fixture_confirmations.json'
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CacheEntry:
    context: dict
    fetched_monotonic: float


_cache: dict[int, CacheEntry] = {}
_state_lock = Lock()
_fetch_lock = Lock()  # Global across seasons; never parallelize provider requests.
_retry_after_monotonic = 0.0


def _utc_now():
    return datetime.now(timezone.utc)


def _confirmed_instant(value):
    stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Fixture confirmation requires a timezone')
    return stamp.astimezone(timezone.utc)


def _annotate_confirmations(context, registry):
    """Confirm exact scheduled fixtures only; named future finals can be placeholders."""
    rows = registry.get('confirmations')
    if registry.get('schema_version') != 1 or not isinstance(rows, list) or len(rows) > 400:
        raise ValueError('Invalid fixture confirmation registry')
    confirmations = {}
    for row in rows:
        gid = row.get('game_id', '')
        if not isinstance(gid, str) or not gid.startswith('squiggle:') or not gid[9:].isdigit() or gid in confirmations:
            raise ValueError('Invalid or duplicate confirmation identity')
        if type(row.get('season')) is not int or not 2000 <= row['season'] <= 2100:
            raise ValueError('Invalid confirmation season')
        if any(not isinstance(row.get(k), str) or not row[k].strip() for k in ('home_team', 'away_team', 'venue')):
            raise ValueError('Missing confirmation fixture details')
        source = urlparse(row.get('source_url', ''))
        if row.get('source') != 'official AFL' or source.scheme != 'https' or source.netloc != 'www.afl.com.au' or source.fragment:
            raise ValueError('Fixture confirmation requires an official AFL source')
        start, checked = _confirmed_instant(row['starts_at']), _confirmed_instant(row['checked_at'])
        if start.astimezone(LEAGUE_ZONE).year != row['season'] or checked >= start:
            raise ValueError('Invalid fixture confirmation timestamps')
        confirmations[gid] = (row, start, checked)
    for game in context['games']:
        game.update(schedule_verified=False, confirmation_source=None, confirmation_checked_at=None)
        confirmation = confirmations.get(game['game_id'])
        if game['state'] != 'scheduled' or confirmation is None:
            continue
        row, start, checked = confirmation
        if checked > _utc_now():
            continue
        if (all(game[k] == row[k] for k in ('season', 'home_team', 'away_team', 'venue'))
                and _confirmed_instant(game['starts_at']) == start):
            game.update(schedule_verified=True, confirmation_source=row['source_url'],
                        confirmation_checked_at=row['checked_at'])
    return context


def _fetch_snapshot(season):
    """Bound network/body processing and normalize before anything enters cache."""
    started = time.monotonic()
    url = f'{SOURCE_URL}?q=games&year={season}'
    with httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=False) as client:
        with client.stream('GET', url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'}) as response:
            response.raise_for_status()
            if response.status_code != 200:
                raise ValueError('Unexpected provider status')
            content_type = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
            if content_type != 'application/json':
                raise ValueError('Expected JSON provider response')
            advertised = response.headers.get('content-length')
            if advertised is not None and (not advertised.isdigit() or int(advertised) > MAX_RESPONSE_BYTES):
                raise ValueError('Unexpected provider response length')
            raw = bytearray()
            # Do not coalesce incoming chunks: a slow trickle can keep each
            # socket read under its timeout while delaying a full 64 KiB buffer.
            # Check the 20s deadline on each received chunk; an active read can
            # still run up to its 10s timeout before control returns here.
            for chunk in response.iter_bytes():
                if time.monotonic() - started > FETCH_DEADLINE_SECONDS:
                    raise TimeoutError('Provider response deadline exceeded')
                if len(raw) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise ValueError('Provider response too large')
                raw.extend(chunk)
    if time.monotonic() - started > FETCH_DEADLINE_SECONDS:
        raise TimeoutError('Provider response deadline exceeded')
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError('Invalid season payload')
    stamp = _utc_now().isoformat()
    envelope = {'source': 'Squiggle', 'source_url': url, 'retrieved_at': stamp,
                'sha256': hashlib.sha256(raw).hexdigest(), 'payload': payload}
    venues = json.loads(VENUES_PATH.read_text())
    context = build_context(envelope, venues)
    # Optional: officially confirmed fixture details layered over the schedule.
    confirmations = (json.loads(CONFIRMATIONS_PATH.read_text()) if CONFIRMATIONS_PATH.exists()
                     else {'schema_version': 1, 'confirmations': []})
    _annotate_confirmations(context, confirmations)
    context['source_sha256'] = envelope['sha256']
    return context


def _response(season, entry, *, reason=None, retry_after_seconds=0):
    now = time.monotonic()
    if entry is None:
        return JSONResponse(status_code=503, headers={
            'Cache-Control': 'private, no-store', 'Retry-After': str(max(1, retry_after_seconds))}, content={
            'season': season, 'status': 'unavailable', 'stale': False,
            'freshness_status': 'unavailable', 'fetched_at': None, 'as_of': None,
            'retrieved_at': None, 'age_seconds': None, 'refresh_interval_hours': 6,
            'refresh_reason': reason or 'upstream_unavailable',
            'message': 'AFL match context is temporarily unavailable.', 'games': []})
    age = max(0, int(now - entry.fetched_monotonic))
    stale = now - entry.fetched_monotonic >= CACHE_TTL_SECONDS
    result = deepcopy(entry.context)
    result.update(season=season, status='stale' if stale else 'ready', stale=stale,
                  freshness_status='stale' if stale else 'cached_snapshot',
                  fetched_at=entry.context['retrieved_at'], as_of=entry.context['retrieved_at'],
                  age_seconds=age, refresh_interval_hours=6,
                  schedule_status='source_snapshot_not_independently_confirmed')
    if reason:
        result['refresh_reason'] = reason
    if retry_after_seconds:
        result['retry_after_seconds'] = retry_after_seconds
    return JSONResponse(content=result, headers={'Cache-Control': 'private, no-store'})


def get_context(season):
    """Shared cache, stale fallback and cooldown; called in FastAPI's threadpool."""
    global _retry_after_monotonic
    now = time.monotonic()
    with _state_lock:
        entry = _cache.get(season)
        retry_at = _retry_after_monotonic
    if entry and now - entry.fetched_monotonic < CACHE_TTL_SECONDS:
        return _response(season, entry)
    if now < retry_at:
        return _response(season, entry, reason='upstream_unavailable',
                         retry_after_seconds=max(1, int(retry_at-now)))
    if not _fetch_lock.acquire(blocking=False):
        return _response(season, entry, reason='refresh_in_progress', retry_after_seconds=30)
    try:
        # A contender may have refreshed or failed between the read and lock.
        now = time.monotonic()
        with _state_lock:
            entry = _cache.get(season)
            retry_at = _retry_after_monotonic
        if entry and now - entry.fetched_monotonic < CACHE_TTL_SECONDS:
            return _response(season, entry)
        if now < retry_at:
            return _response(season, entry, reason='upstream_unavailable',
                             retry_after_seconds=max(1, int(retry_at-now)))
        try:
            context = _fetch_snapshot(season)
        except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError,
                OverflowError, OSError, RecursionError) as exc:
            # Do not expose upstream payloads, URLs with credentials, or exception
            # details to users. An invalid response never replaces good data.
            logger.warning('AFL context refresh rejected: %s', type(exc).__name__)
            with _state_lock:
                _retry_after_monotonic = time.monotonic() + ERROR_COOLDOWN_SECONDS
            return _response(season, entry, reason='upstream_unavailable',
                             retry_after_seconds=ERROR_COOLDOWN_SECONDS)
        entry = CacheEntry(context=context, fetched_monotonic=time.monotonic())
        with _state_lock:
            _cache[season] = entry
            _retry_after_monotonic = 0.0
            # Keep only currently supported seasons after a calendar rollover.
            for old in list(_cache):
                if old < _utc_now().astimezone(LEAGUE_ZONE).year - 1:
                    del _cache[old]
        return _response(season, entry)
    finally:
        _fetch_lock.release()


@router.get('/context')
def match_context(season: int | None = Query(default=None)):
    current = _utc_now().astimezone(LEAGUE_ZONE).year
    season = current if season is None else season
    if season < current-1 or season > current:
        raise HTTPException(422, f'Season must be {current-1} or {current}')
    return get_context(season)
