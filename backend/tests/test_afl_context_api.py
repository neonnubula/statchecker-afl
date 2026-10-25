"""Match context must be cached, source-validated, and protected before fetch."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from threading import Event, Thread

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

from app import afl_context_api as api
from app.main import _require_internal_secret

REAL_CLIENT = httpx.Client


def game(gid, start, home=1, away=2, complete=100):
    dt = datetime.fromisoformat(start)
    return {'id': gid, 'year': dt.year, 'round': gid, 'roundname': f'Round {gid}',
            'hteamid': home, 'ateamid': away, 'hteam': f'Team {home}' if home else None,
            'ateam': f'Team {away}' if away else None, 'venue': 'M.C.G.',
            'unixtime': int(dt.timestamp()), 'date': dt.strftime('%Y-%m-%d %H:%M:%S'),
            'tz': '+10:00', 'localtime': dt.strftime('%Y-%m-%d %H:%M:%S'),
            'complete': complete, 'is_final': 0}


@pytest.fixture
def payload():
    return {'games': [game(1, '2026-06-01T19:00:00+10:00'),
                      game(2, '2026-06-08T19:00:00+10:00', away=3),
                      game(3, '2026-09-15T19:00:00+10:00', home=None, away=None, complete=0)]}


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(api, '_cache', {})
    monkeypatch.setattr(api, '_retry_after_monotonic', 0.0)
    monkeypatch.setattr(api.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(api, '_utc_now', lambda: datetime(2026, 8, 1, tzinfo=timezone.utc))
    yield now


# Synthetic registries written per test. The repository ships no venue or
# fixture data; forks build their own files under data/ (see SCHEMA.md).
SYNTHETIC_VENUES = {
    name: {'latitude': lat, 'longitude': lon, 'timezone': zone,
           'source_url': 'https://www.openstreetmap.org/way/1', 'attribution': '© OpenStreetMap contributors',
           'license': 'ODbL-1.0', 'license_url': 'https://opendatacommons.org/licenses/odbl/1-0/'}
    for name, lat, lon, zone in [('M.C.G.', -37.82, 144.98, 'Australia/Melbourne'),
                                 ('Gabba', -27.49, 153.04, 'Australia/Brisbane')]}
SYNTHETIC_CONFIRMATIONS = {'schema_version': 1, 'confirmations': [{
    'game_id': 'squiggle:38726', 'season': 2026, 'home_team': 'Brisbane Lions', 'away_team': 'Adelaide',
    'starts_at': '2026-09-12T09:35:00Z', 'venue': 'Gabba', 'source': 'official AFL',
    'source_url': 'https://www.afl.com.au/finals/tickets/semi-final-2', 'checked_at': '2026-09-11T13:00:00Z'}]}


@pytest.fixture(autouse=True)
def registries(monkeypatch, tmp_path):
    venues, confirmations = tmp_path / 'afl_venues.json', tmp_path / 'afl_fixture_confirmations.json'
    venues.write_text(json.dumps(SYNTHETIC_VENUES))
    confirmations.write_text(json.dumps(SYNTHETIC_CONFIRMATIONS))
    monkeypatch.setattr(api, 'VENUES_PATH', venues)
    monkeypatch.setattr(api, 'CONFIRMATIONS_PATH', confirmations)


@pytest.fixture
def upstream(monkeypatch, payload):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=payload)
    monkeypatch.setattr(api.httpx, 'Client', lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs))
    return requests


def body(response):
    return json.loads(response.body)


def test_fetch_preserves_every_source_row_and_namespaces_and_attribution(upstream):
    result = body(api.get_context(2026))
    assert result['status'] == 'ready' and result['stale'] is False
    assert result['as_of'] == result['fetched_at'] == result['retrieved_at'] == '2026-08-01T00:00:00+00:00'
    assert result['refresh_interval_hours'] == 6
    assert [g['game_id'] for g in result['games']] == ['squiggle:1', 'squiggle:2', 'squiggle:3']
    assert result['games'][2]['home_team_id'] is None
    assert result['games'][1]['teams']['squiggle:1']['venue_distance_km'] == 0
    assert result['games'][0]['venue_evidence']['attribution'] == '© OpenStreetMap contributors'
    assert result['schedule_status'] == 'source_snapshot_not_independently_confirmed'
    request = upstream[0]
    assert str(request.url) == 'https://api.squiggle.com.au/?q=games&year=2026'
    assert 'StatChecker' in request.headers['user-agent']
    assert 'StatChecker' in request.headers['user-agent']
    assert 'referer' not in request.headers


def test_six_hour_cache_avoids_requests_and_refreshes_at_expiry(upstream, isolated):
    api.get_context(2026)
    isolated[0] += api.CACHE_TTL_SECONDS - 1
    result = body(api.get_context(2026))
    assert len(upstream) == 1 and result['age_seconds'] == api.CACHE_TTL_SECONDS - 1
    isolated[0] += 1
    assert body(api.get_context(2026))['age_seconds'] == 0
    assert len(upstream) == 2


def test_failure_serves_old_data_explicitly_stale_then_obeys_global_cooldown(upstream, isolated, monkeypatch):
    original = body(api.get_context(2026))
    isolated[0] += api.CACHE_TTL_SECONDS
    attempts = []
    def fail(season):
        attempts.append(season)
        raise httpx.ReadTimeout('sensitive upstream details')
    monkeypatch.setattr(api, '_fetch_snapshot', fail)
    stale = body(api.get_context(2026))
    assert stale['status'] == 'stale' and stale['stale'] is True
    assert stale['games'] == original['games'] and stale['as_of'] == original['as_of']
    assert stale['age_seconds'] == api.CACHE_TTL_SECONDS
    assert 'sensitive' not in json.dumps(stale)
    api.get_context(2026)
    assert api.get_context(2025).status_code == 503
    assert attempts == [2026]
    isolated[0] += api.ERROR_COOLDOWN_SECONDS
    api.get_context(2026)
    assert attempts == [2026, 2026]


def test_invalid_refresh_never_replaces_good_cache(upstream, payload, isolated):
    original = body(api.get_context(2026))
    payload['games'][0]['year'] = 2025
    isolated[0] += api.CACHE_TTL_SECONDS
    result = body(api.get_context(2026))
    assert result['status'] == 'stale' and result['games'] == original['games']
    assert len(upstream) == 2


def test_first_failure_has_no_usable_data_and_throttles_retry(monkeypatch):
    count = []
    def fail(season):
        count.append(season)
        raise ValueError('malformed')
    monkeypatch.setattr(api, '_fetch_snapshot', fail)
    response = api.get_context(2026)
    result = body(response)
    assert response.status_code == 503
    assert response.headers['retry-after'] == '900'
    assert response.headers['cache-control'] == 'private, no-store'
    assert result['games'] == [] and result['fetched_at'] is None
    assert result['status'] == 'unavailable'
    api.get_context(2026)
    assert count == [2026]


def test_concurrent_cold_requests_make_one_upstream_fetch(upstream, monkeypatch):
    original_fetch = api._fetch_snapshot
    started, release = Event(), Event()
    results = []
    def slow_fetch(season):
        started.set()
        assert release.wait(2)
        return original_fetch(season)
    monkeypatch.setattr(api, '_fetch_snapshot', slow_fetch)
    worker = Thread(target=lambda: results.append(api.get_context(2026)))
    worker.start()
    try:
        assert started.wait(2)
        other = api.get_context(2026)
        assert other.status_code == 503 and body(other)['refresh_reason'] == 'refresh_in_progress'
        assert api.get_context(2025).status_code == 503
    finally:
        release.set()
        worker.join(2)
    assert not worker.is_alive() and results[0].status_code == 200
    assert len(upstream) == 1
    assert api.get_context(2026).status_code == 200 and len(upstream) == 1


@pytest.mark.parametrize('kind', ['http_failure', 'redirect', 'html', 'advertised_large', 'actual_large', 'json_array', 'invalid_json', 'duplicate_game', 'wrong_season'])
def test_bad_upstream_fails_closed(monkeypatch, payload, kind):
    def handler(request):
        if kind == 'http_failure':
            return httpx.Response(429, text='do not expose provider detail')
        if kind == 'redirect':
            return httpx.Response(302, headers={'location': 'https://other.example.com/'})
        if kind == 'html':
            return httpx.Response(200, text='<html>error</html>')
        if kind == 'advertised_large':
            return httpx.Response(200, headers={'content-type': 'application/json', 'content-length': str(api.MAX_RESPONSE_BYTES+1)}, content=b'{}')
        if kind == 'actual_large':
            return httpx.Response(200, headers={'content-type': 'application/json'}, content=b' '*(api.MAX_RESPONSE_BYTES+1))
        if kind == 'json_array':
            return httpx.Response(200, json=[])
        if kind == 'invalid_json':
            return httpx.Response(200, headers={'content-type': 'application/json'}, content=b'{')
        if kind == 'duplicate_game':
            payload['games'].append(deepcopy(payload['games'][0]))
        if kind == 'wrong_season':
            payload['games'][0]['year'] = 2025
        return httpx.Response(200, json=payload)
    monkeypatch.setattr(api.httpx, 'Client', lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs))
    response = api.get_context(2026)
    assert response.status_code == 503 and body(response)['games'] == []
    assert api._cache == {}


def test_protected_router_auth_and_season_bounds(monkeypatch, upstream):
    monkeypatch.setenv('INTERNAL_API_SECRET', 'context-test-secret')
    app = FastAPI()
    app.include_router(api.router, dependencies=[Depends(_require_internal_secret)])
    client = TestClient(app)
    assert client.get('/afl/context').status_code == 401
    assert client.get('/afl/context', headers={'x-internal-secret': 'wrong'}).status_code == 401
    assert not upstream
    headers = {'x-internal-secret': 'context-test-secret'}
    assert client.get('/afl/context?season=2027', headers=headers).status_code == 422
    assert client.get('/afl/context?season=2024', headers=headers).status_code == 422
    assert client.get('/afl/context?season=garbage', headers=headers).status_code == 422
    assert not upstream
    result = client.get('/afl/context', headers=headers)
    assert result.status_code == 200 and result.json()['season'] == 2026
    monkeypatch.delenv('INTERNAL_API_SECRET')
    monkeypatch.setenv('REQUIRE_INTERNAL_SECRET', 'true')
    assert client.get('/afl/context', headers=headers).status_code == 503


def test_streaming_size_bound_without_content_length(monkeypatch):
    chunks_read = []
    class LargeStream(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(100):
                chunks_read.append(index)
                yield b' ' * 65536
    def handler(request):
        return httpx.Response(200, headers={'content-type': 'application/json'}, stream=LargeStream())
    monkeypatch.setattr(api.httpx, 'Client', lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs))
    assert api.get_context(2026).status_code == 503
    assert len(chunks_read) == api.MAX_RESPONSE_BYTES // 65536 + 1
    assert api._cache == {}


def test_total_stream_deadline_enforced(monkeypatch, isolated):
    class SlowStream(httpx.SyncByteStream):
        def __iter__(self):
            isolated[0] += api.FETCH_DEADLINE_SECONDS + 1
            yield b'{}'
    def handler(request):
        assert request.extensions['timeout']['connect'] == 5.0
        assert request.extensions['timeout']['read'] == 10.0
        return httpx.Response(200, headers={'content-type': 'application/json'}, stream=SlowStream())
    monkeypatch.setattr(api.httpx, 'Client', lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs))
    assert api.get_context(2026).status_code == 503
    assert api._retry_after_monotonic > isolated[0]


def test_expired_cache_served_stale_while_refresh_lock_held(upstream, isolated):
    original = body(api.get_context(2026))
    isolated[0] += api.CACHE_TTL_SECONDS
    with api._fetch_lock:
        result = api.get_context(2026)
    assert result.status_code == 200
    assert body(result)['stale'] is True
    assert body(result)['refresh_reason'] == 'refresh_in_progress'
    assert body(result)['games'] == original['games']
    assert len(upstream) == 1


def test_fresh_cache_still_usable_during_other_season_cooldown(upstream, monkeypatch):
    api.get_context(2026)
    monkeypatch.setattr(api, '_retry_after_monotonic', 999999.0)
    assert body(api.get_context(2026))['status'] == 'ready'
    assert len(upstream) == 1


def test_trickling_response_checks_deadline_before_buffer_fills(monkeypatch, isolated):
    chunks_read = []
    initial = isolated[0]
    class TrickleStream(httpx.SyncByteStream):
        def __iter__(self):
            for index in range(10):
                isolated[0] += 8  # Every chunk arrives inside the 10-second read timeout.
                chunks_read.append(index)
                yield b' '
    def handler(request):
        return httpx.Response(200, headers={'content-type': 'application/json'}, stream=TrickleStream())
    monkeypatch.setattr(api.httpx, 'Client', lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs))
    assert api.get_context(2026).status_code == 503
    assert chunks_read == [0, 1, 2]  # Abort at 24s, not after the 80s stream ends.
    assert api.FETCH_DEADLINE_SECONDS < isolated[0] - initial < api.FETCH_DEADLINE_SECONDS + 10
    assert api._cache == {}


@pytest.fixture
def confirmation_registry():
    return json.loads(api.CONFIRMATIONS_PATH.read_text())


def confirmation_game(registry, **overrides):
    row = registry['confirmations'][0]
    result = {k: row[k] for k in ('game_id', 'season', 'home_team', 'away_team', 'starts_at', 'venue')}
    result['state'] = 'scheduled'
    result.update(overrides)
    return result


def test_exact_official_confirmation_is_added_before_caching(upstream, payload, monkeypatch, confirmation_registry):
    monkeypatch.setattr(api, '_utc_now', lambda: datetime(2026, 9, 11, 13, 5, tzinfo=timezone.utc))
    upcoming = game(38726, '2026-09-12T19:35:00+10:00', home=2, away=1, complete=0)
    upcoming.update(hteam='Brisbane Lions', ateam='Adelaide', venue='Gabba')
    payload['games'] = [upcoming]
    result = body(api.get_context(2026))
    assert result['games'][0]['schedule_verified'] is True
    assert result['games'][0]['confirmation_source'] == 'https://www.afl.com.au/finals/tickets/semi-final-2'
    assert result['games'][0]['confirmation_checked_at'] == '2026-09-11T13:00:00Z'
    assert api._cache[2026].context['games'][0]['schedule_verified'] is True
    assert len(upstream) == 1


@pytest.mark.parametrize('change', [
    {'starts_at': '2026-09-12T10:35:00Z'}, {'venue': 'M.C.G.'},
    {'home_team': 'Sydney'}, {'away_team': 'Fremantle'}, {'season': 2025},
    {'game_id': 'different-provider:38726'}, {'state': 'final'}, {'state': 'in_progress'},
])
def test_changed_fixture_or_completed_history_is_not_independently_confirmed(monkeypatch, confirmation_registry, change):
    monkeypatch.setattr(api, '_utc_now', lambda: datetime(2026, 9, 11, 13, 5, tzinfo=timezone.utc))
    context = {'games': [confirmation_game(confirmation_registry, **change)]}
    api._annotate_confirmations(context, confirmation_registry)
    assert len(context['games']) == 1
    assert context['games'][0]['schedule_verified'] is False
    assert context['games'][0]['confirmation_source'] is None


def test_future_finals_stay_unverified_when_placeholder_teams_become_named(monkeypatch, confirmation_registry):
    monkeypatch.setattr(api, '_utc_now', lambda: datetime(2026, 9, 11, 13, 5, tzinfo=timezone.utc))
    placeholder = confirmation_game(confirmation_registry, game_id='squiggle:38728',
        starts_at='2026-09-19T09:20:00Z', venue='M.C.G.', home_team='Sydney', away_team=None)
    context = {'games': [placeholder]}
    api._annotate_confirmations(context, confirmation_registry)
    assert context['games'][0]['schedule_verified'] is False
    placeholder['away_team'] = 'Fremantle'
    api._annotate_confirmations(context, confirmation_registry)
    assert context['games'][0]['schedule_verified'] is False
    assert context['games'][0]['confirmation_source'] is None


def test_equivalent_utc_instant_matches_but_unperformed_confirmation_does_not(monkeypatch, confirmation_registry):
    context = {'games': [confirmation_game(confirmation_registry, starts_at='2026-09-12T09:35:00+00:00')]}
    api._annotate_confirmations(context, confirmation_registry)  # frozen August 1 precedes checking
    assert context['games'][0]['schedule_verified'] is False
    monkeypatch.setattr(api, '_utc_now', lambda: datetime(2026, 9, 11, 13, 5, tzinfo=timezone.utc))
    api._annotate_confirmations(context, confirmation_registry)
    assert context['games'][0]['schedule_verified'] is True


def test_duplicate_confirmation_identity_fails_closed(confirmation_registry):
    context = {'games': [confirmation_game(confirmation_registry)]}
    confirmation_registry['confirmations'].append(deepcopy(confirmation_registry['confirmations'][0]))
    with pytest.raises(ValueError, match='duplicate'):
        api._annotate_confirmations(context, confirmation_registry)
