"""Deployed research can be restricted to the configured frontend proxy."""
import pytest
from fastapi import HTTPException
from starlette.requests import Request
from app.main import _require_internal_secret


def request(secret=None):
    headers = [] if secret is None else [(b'x-internal-secret', secret.encode())]
    return Request({'type': 'http', 'headers': headers})


def test_missing_required_secret_fails_closed(monkeypatch):
    monkeypatch.delenv('INTERNAL_API_SECRET', raising=False)
    monkeypatch.setenv('REQUIRE_INTERNAL_SECRET', 'true')
    with pytest.raises(HTTPException) as error:
        _require_internal_secret(request())
    assert error.value.status_code == 503


@pytest.mark.parametrize('supplied', [None, 'incorrect-secret', 'é'])
def test_configured_secret_rejects_untrusted_calls(monkeypatch, supplied):
    monkeypatch.setenv('INTERNAL_API_SECRET', 'synthetic-shared-secret')
    with pytest.raises(HTTPException) as error:
        _require_internal_secret(request(supplied))
    assert error.value.status_code == 401


def test_configured_proxy_is_accepted(monkeypatch):
    monkeypatch.setenv('INTERNAL_API_SECRET', 'synthetic-shared-secret')
    _require_internal_secret(request('synthetic-shared-secret'))


def test_unconfigured_local_development_remains_available(monkeypatch):
    for key in ('INTERNAL_API_SECRET', 'REQUIRE_INTERNAL_SECRET'):
        monkeypatch.delenv(key, raising=False)
    _require_internal_secret(request())
