import asyncio
from pathlib import Path
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.afl_finals_maintenance import MAX_BODY_BYTES, audit_database, create_router, read_body


@pytest.fixture
def maintenance(tmp_path, monkeypatch):
    monkeypatch.setenv('INTERNAL_API_SECRET', 'test-only-maintenance-secret')
    app = FastAPI()
    app.include_router(create_router(lambda: str(tmp_path / 'stats.db'), lambda: None))
    return TestClient(app)


AUTH = {'x-internal-secret': 'test-only-maintenance-secret'}


@pytest.mark.parametrize('path', ['plan', 'apply'])
def test_authentication_precedes_body_processing(maintenance, path):
    response = maintenance.post('/internal/afl-finals/' + path, content='not json')
    assert response.status_code == 401


def test_missing_secret_never_disables_auth(maintenance, monkeypatch):
    monkeypatch.delenv('INTERNAL_API_SECRET')
    assert maintenance.get('/internal/afl-finals/audit').status_code == 503


def test_audit_requires_secret(maintenance):
    assert maintenance.get('/internal/afl-finals/audit').status_code == 401


def test_bundle_size_is_bounded(maintenance):
    response = maintenance.post('/internal/afl-finals/plan', content=b' ' * (MAX_BODY_BYTES+1),
                                headers={**AUTH, 'content-type':'application/json'})
    assert response.status_code == 413


def test_no_caller_chosen_database_or_backup_path(maintenance):
    response = maintenance.post('/internal/afl-finals/apply', headers=AUTH,
                                json={'bundle':{},'expected_plan_sha256':'a'*64,'backup_path':'/tmp/override'})
    assert response.status_code == 400


def test_apply_requires_valid_reviewed_hash(maintenance):
    response = maintenance.post('/internal/afl-finals/apply', headers=AUTH,
                                json={'bundle':{},'expected_plan_sha256':'not-a-hash'})
    assert response.status_code == 400


def test_stale_preconditions_return_conflict(maintenance, monkeypatch):
    import scripts.afl_import_verified_finals as importer
    def reject(*args, **kwargs):
        raise ValueError('Reviewed plan does not match current database')
    monkeypatch.setattr(importer, 'apply_import', reject)
    response = maintenance.post('/internal/afl-finals/apply', headers=AUTH,
                                json={'bundle':{},'expected_plan_sha256':'a'*64})
    assert response.status_code == 409


def test_management_routes_not_advertised_in_public_schema(maintenance):
    assert not any('/internal/afl-finals' in p for p in maintenance.get('/openapi.json').json()['paths'])


@pytest.mark.parametrize('path', ['audit', 'plan', 'apply'])
def test_wrong_secret_is_rejected_for_every_route(maintenance,path):
    response=maintenance.request('GET' if path=='audit' else 'POST','/internal/afl-finals/'+path,
                                 headers={'x-internal-secret':'wrong'},content=b'{}')
    assert response.status_code==401


def test_deeply_nested_json_is_a_controlled_bad_request(maintenance):
    response=maintenance.post('/internal/afl-finals/plan',headers={**AUTH,'content-type':'application/json'},
                               content=b'{"a":'+b'['*2000+b'0'+b']'*2000+b'}')
    assert response.status_code==400


def test_json_depth_limit_does_not_depend_on_decoder_recursion(maintenance):
    response=maintenance.post('/internal/afl-finals/plan',headers={**AUTH,'content-type':'application/json'},
                               content=b'{"a":'+b'['*32+b'0'+b']'*32+b'}')
    assert response.status_code==400
    assert response.json()['detail']=='JSON nesting is too deep'


def test_json_brackets_in_strings_are_not_nesting():
    class StringRequest:
        headers={'content-type':'application/json'}
        async def stream(self):
            yield b'{"source_note":"'+b'['*2000+b']'*2000+b'"}'
    assert asyncio.run(read_body(StringRequest()))=={'source_note':'['*2000+']'*2000}


def test_body_read_has_a_total_deadline(monkeypatch):
    import app.afl_finals_maintenance as module
    monkeypatch.setattr(module,'BODY_READ_TIMEOUT_SECONDS',0.001)
    class SlowRequest:
        headers={'content-type':'application/json'}
        async def stream(self):
            yield b'{'
            await asyncio.sleep(0.02)
            yield b'}'
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as failure:
        asyncio.run(read_body(SlowRequest()))
    assert failure.value.status_code==408


@pytest.mark.parametrize('path', ['plan','apply'])
def test_database_error_is_controlled_and_never_exposes_paths(maintenance,monkeypatch,path):
    import scripts.afl_import_verified_finals as importer
    def fail(*args,**kwargs):
        raise sqlite3.OperationalError('/private/volume/path.db is locked')
    monkeypatch.setattr(importer,'plan_import' if path=='plan' else 'apply_import',fail)
    body={} if path=='plan' else {'bundle':{},'expected_plan_sha256':'a'*64}
    response=maintenance.post('/internal/afl-finals/'+path,headers=AUTH,json=body)
    assert response.status_code==503 and '/private/' not in response.text


def test_audit_missing_database_does_not_create_it(maintenance,tmp_path):
    response=maintenance.get('/internal/afl-finals/audit',headers=AUTH)
    assert response.status_code==503 and not (tmp_path/'stats.db').exists()


def test_apply_passes_only_server_owned_paths_and_clears_cache_after_success(tmp_path,monkeypatch):
    import scripts.afl_import_verified_finals as importer
    monkeypatch.setenv('INTERNAL_API_SECRET',AUTH['x-internal-secret'])
    events=[]
    def apply(db_path,bundle,*,expected_plan_sha256,backup_path):
        assert db_path==str(tmp_path/'stats.db') and bundle=={'verified':'fixture'}
        assert expected_plan_sha256=='a'*64
        backup=Path(backup_path)
        assert backup.parent==tmp_path/'afl-import-backups'
        backup.write_bytes(b'synthetic backup')
        events.append('committed')
        return {'rows_to_insert':[{'player_id':1}],'plan_sha256':'a'*64}
    monkeypatch.setattr(importer,'apply_import',apply)
    app=FastAPI()
    app.include_router(create_router(lambda:str(tmp_path/'stats.db'),lambda:events.append('cache-cleared')))
    response=TestClient(app).post('/internal/afl-finals/apply',headers=AUTH,
                    json={'bundle':{'verified':'fixture'},'expected_plan_sha256':'a'*64})
    assert response.status_code==200 and response.json()['applied'] is True
    assert '/' not in response.json()['backup_file']
    assert events==['committed','cache-cleared']


def test_audit_closes_connection_and_never_accepts_sql_from_request(tmp_path,monkeypatch):
    db=tmp_path/'audit.db'
    with sqlite3.connect(db) as conn:
        conn.executescript('''CREATE TABLE players(player_id,api_player_id,player_name);
            CREATE TABLE teams(team_id,api_team_id,team_name);
            CREATE TABLE venues(venue_id,venue_name);
            CREATE TABLE games(game_id,season_year,game_date);
            CREATE TABLE player_game_stats(stat_id,player_id,team_id,game_id);
            INSERT INTO players VALUES(1,1001,'Test Player');''')
    events=[]
    class Connection(sqlite3.Connection):
        def close(self):
            events.append('closed')
            return super().close()
    original=sqlite3.connect
    monkeypatch.setattr(sqlite3,'connect',lambda *args,**kwargs:original(*args,**kwargs,factory=Connection))
    audit=audit_database(db)
    assert audit['players']==[{'player_id':1,'api_player_id':1001,'player_name':'Test Player'}]
    assert audit['games']==[] and events==['closed']


def test_audit_exposes_only_previously_imported_identity_bindings(tmp_path):
    import json
    db = tmp_path / 'audit.db'
    binding = {'player_id': 1, 'player_name': 'Canonical Player', 'canonical_api_player_id': 1001,
               'source_api_player_id': 2001, 'official_player_number': 7,
               'official_player_name': 'Official Player', 'imported_team_id': 2,
               'identity_source': {'unneeded': 'full original receipt'}}
    with sqlite3.connect(db) as conn:
        conn.executescript('''CREATE TABLE players(player_id,api_player_id,player_name);
            CREATE TABLE teams(team_id,api_team_id,team_name);
            CREATE TABLE venues(venue_id,venue_name);
            CREATE TABLE games(game_id,season_year,game_date);
            CREATE TABLE player_game_stats(stat_id,player_id,team_id,game_id);
            CREATE TABLE afl_verified_final_imports(receipt_json,applied_at);''')
        conn.execute('INSERT INTO afl_verified_final_imports VALUES(?,?)',
                     (json.dumps({'source_identity_overrides': [binding]}), '2026-09-22'))
    result = audit_database(db)
    assert result['verified_identity_bindings'] == [{k: v for k, v in binding.items() if k != 'identity_source'}]
