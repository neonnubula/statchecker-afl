"""Bounded, authenticated access to the reviewed 2026 finals importer.

No arbitrary SQL, filesystem paths, provider fetching or identity repair is
accepted over HTTP. Applying requires the hash from a fresh dry-run plan.
"""
import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool

MAX_BODY_BYTES = 512 * 1024
MAX_JSON_DEPTH = 32
BODY_READ_TIMEOUT_SECONDS = 10


def require_maintenance_secret(request: Request):
    expected = os.environ.get('INTERNAL_API_SECRET', '')
    if not expected:
        raise HTTPException(503, 'Maintenance is unavailable')
    supplied = request.headers.get('x-internal-secret', '')
    if not secrets.compare_digest(expected.encode(), supplied.encode()):
        raise HTTPException(401, 'Unauthorized')


async def read_body(request):
    if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
        raise HTTPException(415, 'Expected application/json')
    body = bytearray()
    try:
        async with asyncio.timeout(BODY_READ_TIMEOUT_SECONDS):
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_BODY_BYTES:
                    raise HTTPException(413, 'Import bundle is too large')
                body.extend(chunk)
    except TimeoutError:
        raise HTTPException(408, 'Import bundle upload timed out')
    try:
        value = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise HTTPException(400, 'Invalid JSON')
    if not isinstance(value, dict):
        raise HTTPException(400, 'Expected an object')
    # Python's JSON decoder recursion threshold varies by runtime. Bound the
    # accepted structure explicitly before passing it to importer validation.
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if not isinstance(item, (dict, list)):
            continue
        if depth > MAX_JSON_DEPTH:
            raise HTTPException(400, 'JSON nesting is too deep')
        children = item.values() if isinstance(item, dict) else item
        pending.extend((child, depth + 1) for child in children if isinstance(child, (dict, list)))
    return value


def audit_database(db_path):
    with closing(sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        def rows(sql):
            return [dict(r) for r in conn.execute(sql)]
        # Reuse only identities already accepted by the transactional importer.
        # The collector must still match each new official name, number and stat.
        bindings = []
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='afl_verified_final_imports'").fetchone():
            for record in conn.execute('SELECT receipt_json FROM afl_verified_final_imports ORDER BY applied_at'):
                receipt = json.loads(record[0])
                for binding in receipt.get('source_identity_overrides', []):
                    bindings.append({k: binding[k] for k in (
                        'player_id', 'player_name', 'canonical_api_player_id', 'source_api_player_id',
                        'official_player_number', 'official_player_name', 'imported_team_id')})
        return {
            'season': 2026,
            'audited_at': datetime.now(timezone.utc).isoformat(),
            'verified_identity_bindings': bindings,
            'players': rows('SELECT player_id,api_player_id,player_name FROM players ORDER BY player_id'),
            'teams': rows('SELECT team_id,api_team_id,team_name FROM teams ORDER BY team_id'),
            'venues': rows('SELECT venue_id,venue_name FROM venues ORDER BY venue_id'),
            'player_clubs': rows('''SELECT DISTINCT p.player_id,s.team_id FROM players p
                JOIN player_game_stats s ON s.player_id=p.player_id JOIN games g ON g.game_id=s.game_id
                WHERE g.season_year=2026 ORDER BY p.player_id,s.team_id'''),
            'games': rows('''SELECT g.*,count(s.stat_id) AS stat_rows FROM games g
                LEFT JOIN player_game_stats s ON s.game_id=g.game_id WHERE g.season_year=2026
                GROUP BY g.game_id ORDER BY g.game_date,g.game_id'''),
        }


def create_router(db_path, clear_cache):
    router = APIRouter(prefix='/internal/afl-finals', include_in_schema=False,
                       dependencies=[Depends(require_maintenance_secret)])

    @router.get('/audit')
    def audit():
        try:
            return audit_database(db_path())
        except (sqlite3.Error, OSError):
            raise HTTPException(503, 'Maintenance database is unavailable')

    @router.post('/plan')
    async def plan(request: Request):
        from scripts.afl_import_verified_finals import plan_import
        bundle = await read_body(request)
        try:
            return await run_in_threadpool(plan_import, db_path(), bundle)
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(409, str(exc))
        except (sqlite3.Error, OSError):
            raise HTTPException(503, 'Maintenance database is unavailable')

    @router.post('/apply')
    async def apply(request: Request):
        from scripts.afl_import_verified_finals import apply_import
        value = await read_body(request)
        if set(value) != {'bundle', 'expected_plan_sha256'} or not isinstance(value['bundle'], dict):
            raise HTTPException(400, 'Expected bundle and expected_plan_sha256')
        expected = value['expected_plan_sha256']
        if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
            raise HTTPException(400, 'Invalid plan hash')
        try:
            path = Path(db_path()).resolve()
            backup_dir = path.parent / 'afl-import-backups'
            backup_dir.mkdir(mode=0o700, exist_ok=True)
            backup = backup_dir / ('finals-2026-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
                                   + '-' + secrets.token_hex(6) + '.db')
            result = await run_in_threadpool(apply_import, str(path), value['bundle'],
                                            expected_plan_sha256=expected, backup_path=str(backup))
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(409, str(exc))
        except (sqlite3.Error, OSError):
            raise HTTPException(503, 'Maintenance operation failed; inspect the audit before retrying')
        clear_cache()
        return {**result, 'applied': bool(result['rows_to_insert']),
                'backup_file': backup.name if backup.exists() else None}

    return router
