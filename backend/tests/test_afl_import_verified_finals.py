"""Synthetic import regressions; these fixtures are not acquisition evidence."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest

from scripts.afl_import_verified_finals import STATS, plan_import, apply_import


@pytest.fixture
def case(tmp_path):
    path = tmp_path / 'afl.db'
    with sqlite3.connect(path) as conn:
        schema = Path(__file__).resolve().parents[1] / 'database/schema.sql'
        conn.executescript(schema.read_text())
        conn.execute("INSERT INTO teams(team_id,api_team_id,team_name) VALUES(1,11,'Club A'),(2,22,'Club B')")
        conn.execute("INSERT INTO venues(venue_id,venue_name) VALUES(1,'Verified Ground')")
        conn.executemany('INSERT INTO players(player_id,api_player_id,player_name) VALUES(?,?,?)',
                         [(i,1000+i,f'Player {i}') for i in range(1,47)])
        conn.execute("INSERT INTO games(game_id,api_game_id,season_year,game_type,game_date,game_time,venue_id,home_team_id,away_team_id) VALUES(1,100,2026,'Regular Season','2026-08-28','19:30:00',1,1,2)")
        conn.execute("INSERT INTO player_game_stats(player_id,game_id,team_id,opponent_team_id,venue_id,location,game_time,disposals,goals,marks,tackles,kicks,handballs,clearances,hit_outs) VALUES(1,1,1,2,1,'Home','Night',20,1,2,3,10,10,1,0)")
        # Unaffected player data must remain untouched, including stale derivation.
        conn.execute("INSERT INTO player_game_stats(player_id,game_id,team_id,opponent_team_id,venue_id,location,days_since_last_game) VALUES(46,1,2,1,1,'Away',999)")
    receipt = {'source_url':'https://v1.afl.api-sports.io/games/statistics/players?id=200',
               'retrieved_at':'2026-09-12T01:00:00+00:00','source_sha256':'a'*64}
    schedule = {**receipt,'source_url':'https://api.squiggle.com.au/?q=games;year=2026'}
    rows = [{'api_player_id':1000+i,'player_name':f'Player {i}','api_team_id':11 if i<=22 else 22,
             'participation':'verified','participation_source':receipt.copy(),
             'disposals':20,'goals':1,'marks':2,'tackles':3,'kicks':10,'handballs':10,
             'clearances':1,'hit_outs':0} for i in range(1,45)]
    game = {'api_game_id':200,'game_date':'2026-09-04','game_time':'19:30:00','round_number':26,
            'game_type':'Finals','status':'FT','venue':{'venue_id':1,'venue_name':'Verified Ground'},
            'home':{'api_team_id':11,'team_name':'Club A'},'away':{'api_team_id':22,'team_name':'Club B'},
            'source':receipt,'schedule_source':schedule,'rows':rows}
    bundle = {'schema_version':1,'season':2026,'cutoff_local_date':'2026-09-11','games':[game]}
    return path, bundle


def dump(path):
    with sqlite3.connect(path) as conn:
        return list(conn.iterdump())


def apply(case, tmp_path):
    db, bundle = case
    plan = plan_import(db,bundle)
    return apply_import(db,bundle,expected_plan_sha256=plan['plan_sha256'],backup_path=tmp_path/'backup.db')


def test_dry_run_is_stable_and_does_not_write(case):
    db,bundle = case
    before=dump(db)
    first=plan_import(db,bundle)
    second=plan_import(db,bundle)
    assert first == second
    assert len(first['games_to_insert']) == 1 and len(first['rows_to_insert']) == 44
    assert dump(db) == before


def test_apply_creates_game_preserves_null_and_zero_and_has_recovery_snapshot(case,tmp_path):
    db,bundle=case
    bundle['games'][0]['rows'][0]['marks']=None
    before=dump(db)
    result=apply(case,tmp_path)
    assert dump(tmp_path/'backup.db') == before
    with sqlite3.connect(db) as conn:
        assert conn.execute('SELECT marks,hit_outs,days_since_last_game FROM player_game_stats WHERE player_id=1 AND game_id=2').fetchone() == (None,0,7)
        assert conn.execute('SELECT days_since_last_game FROM player_game_stats WHERE player_id=46').fetchone()[0] == 999
        assert conn.execute("SELECT game_type,game_date,game_time FROM games WHERE api_game_id=200").fetchone() == ('Finals','2026-09-04','19:30:00')
        assert conn.execute('SELECT COUNT(*) FROM players').fetchone()[0] == 46
    assert 46 not in result['affected_player_ids']


def test_reviewed_verified_zero_participant_is_preserved(case,tmp_path):
    case[1]['games'][0]['rows'][0].update({s:0 for s in STATS})
    apply(case,tmp_path)
    with sqlite3.connect(case[0]) as conn:
        assert conn.execute('SELECT disposals,goals FROM player_game_stats WHERE player_id=1 AND game_id=2').fetchone()==(0,0)


def test_repeated_import_is_noop_with_fresh_plan(case,tmp_path):
    apply(case,tmp_path)
    before=dump(case[0])
    plan=plan_import(*case)
    assert plan['already_present_api_game_ids']==[200]
    assert plan['games_to_insert']==plan['rows_to_insert']==plan['days_to_update']==[]
    apply_import(*case,expected_plan_sha256=plan['plan_sha256'],backup_path=None)
    assert dump(case[0])==before


def test_stale_plan_cannot_apply_after_identity_change(case,tmp_path):
    plan=plan_import(*case)
    with sqlite3.connect(case[0]) as conn:
        conn.execute("UPDATE players SET first_name='Edited' WHERE player_id=1")
    before=dump(case[0])
    with pytest.raises(ValueError,match='hash'):
        apply_import(*case,expected_plan_sha256=plan['plan_sha256'],backup_path=tmp_path/'backup.db')
    assert dump(case[0])==before and not (tmp_path/'backup.db').exists()


def test_atomic_rollback_including_new_game_after_mid_import_failure(case,tmp_path):
    with sqlite3.connect(case[0]) as conn:
        conn.execute("CREATE TRIGGER synthetic_failure BEFORE INSERT ON player_game_stats WHEN NEW.player_id=10 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    before=dump(case[0])
    with pytest.raises(sqlite3.IntegrityError,match='synthetic failure'):
        apply(case,tmp_path)
    assert dump(case[0])==before
    assert dump(tmp_path/'backup.db')==before


def test_existing_empty_exact_final_can_receive_stats(case,tmp_path):
    with sqlite3.connect(case[0]) as conn:
        conn.execute("INSERT INTO games(game_id,api_game_id,season_year,round_number,game_type,game_date,game_time,venue_id,home_team_id,away_team_id) VALUES(2,200,2026,26,'Finals','2026-09-04','19:30:00',1,1,2)")
    assert plan_import(*case)['games_to_insert']==[]
    apply(case,tmp_path)
    with sqlite3.connect(case[0]) as conn:
        assert conn.execute('SELECT COUNT(*) FROM games').fetchone()[0]==2


def test_partial_existing_game_aborts_whole_bundle(case,tmp_path):
    test_existing_empty_exact_final_can_receive_stats(case,tmp_path)
    with sqlite3.connect(case[0]) as conn:
        conn.execute('DELETE FROM player_game_stats WHERE game_id=2 AND player_id=44')
    before=dump(case[0])
    with pytest.raises(ValueError,match='partial'):
        plan_import(*case)
    assert dump(case[0])==before


@pytest.mark.parametrize('mutation',['wrong_name','missing_identity','bool_stat','negative','missing_stat',
    'unverified','bad_receipt','wrong_club_name','bad_date','future','nonfinal','not_finished','bad_clock','duplicate_row',
    'wrong_team','arithmetic','duplicate_game','incomplete_team','bool_game_id','wrong_venue'])
def test_invalid_source_bundle_fails_closed(case,mutation):
    db,bundle=case
    game=bundle['games'][0]
    row=game['rows'][0]
    if mutation=='wrong_name':row['player_name']='Different Person'
    elif mutation=='missing_identity':row['api_player_id']=99999
    elif mutation=='bool_stat':row['goals']=True
    elif mutation=='negative':row['marks']=-1
    elif mutation=='missing_stat':del row['hit_outs']
    elif mutation=='unverified':row['participation']='unknown'
    elif mutation=='bad_receipt':row['participation_source']['source_url']='https://untrusted.example/proof'
    elif mutation=='wrong_club_name':game['home']['team_name']='Club X'
    elif mutation=='bad_date':game['game_date']='2026-02-30'
    elif mutation=='future':game['game_date']='2026-09-12'
    elif mutation=='nonfinal':game['game_type']='Regular Season'
    elif mutation=='not_finished':game['status']='NS'
    elif mutation=='bad_clock':game['game_time']='25:00:00'
    elif mutation=='duplicate_row':game['rows'][1]=deepcopy(row)
    elif mutation=='wrong_team':row['api_team_id']=999
    elif mutation=='arithmetic':row['disposals']=21
    elif mutation=='duplicate_game':bundle['games'].append(deepcopy(game))
    elif mutation=='incomplete_team':game['rows'].pop()
    elif mutation=='bool_game_id':game['api_game_id']=True
    else:game['venue']['venue_name']='Unknown'
    before=dump(db)
    with pytest.raises(ValueError):plan_import(db,bundle)
    assert dump(db)==before


def test_existing_fixture_without_api_id_cannot_be_guessed(case):
    with sqlite3.connect(case[0]) as conn:
        conn.execute("INSERT INTO games(season_year,game_type,game_date,venue_id,home_team_id,away_team_id) VALUES(2026,'Finals','2026-09-04',1,1,2)")
    with pytest.raises(ValueError,match='Conflicting existing fixture'):plan_import(*case)


def test_prior_club_conflict_rejects_apparent_direct_id_match(case):
    with sqlite3.connect(case[0]) as conn:conn.execute('UPDATE player_game_stats SET team_id=2 WHERE player_id=1')
    with pytest.raises(ValueError,match='conflicting prior'):plan_import(*case)


def test_backup_cannot_overwrite_existing_artifact(case,tmp_path):
    existing=tmp_path/'backup.db'
    existing.write_bytes(b'keep')
    before=dump(case[0])
    with pytest.raises(ValueError,match='new distinct'):apply(case,tmp_path)
    assert existing.read_bytes()==b'keep' and dump(case[0])==before


def test_new_earlier_game_recomputes_later_row_for_affected_player_only(case,tmp_path):
    with sqlite3.connect(case[0]) as conn:
        conn.execute("INSERT INTO games(game_id,api_game_id,season_year,game_type,game_date,game_time,venue_id,home_team_id,away_team_id) VALUES(2,300,2026,'Finals','2026-09-11','19:30:00',1,1,2)")
        conn.execute("INSERT INTO player_game_stats(player_id,game_id,team_id,opponent_team_id,venue_id,location,days_since_last_game) VALUES(1,2,1,2,1,'Home',14)")
    apply(case,tmp_path)
    with sqlite3.connect(case[0]) as conn:
        assert conn.execute('SELECT days_since_last_game FROM player_game_stats WHERE player_id=1 AND game_id=2').fetchone()[0]==7
        assert conn.execute('SELECT days_since_last_game FROM player_game_stats WHERE player_id=46').fetchone()[0]==999


def test_stale_history_plan_fails_before_snapshot_or_writes(case,tmp_path):
    plan=plan_import(*case)
    with sqlite3.connect(case[0]) as conn:
        conn.execute('UPDATE player_game_stats SET days_since_last_game=5 WHERE player_id=1')
    before=dump(case[0])
    with pytest.raises(ValueError,match='hash'):
        apply_import(*case,expected_plan_sha256=plan['plan_sha256'],backup_path=tmp_path/'backup.db')
    assert dump(case[0])==before and not (tmp_path/'backup.db').exists()


def test_snapshot_includes_committed_wal_pages(case,tmp_path):
    writer=sqlite3.connect(case[0])
    try:
        assert writer.execute('PRAGMA journal_mode=WAL').fetchone()[0]=='wal'
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute("INSERT INTO players(player_id,api_player_id,player_name) VALUES(100,9000,'WAL-only record')")
        writer.commit()
        assert Path(str(case[0])+'-wal').stat().st_size>0
        before=dump(case[0])
        apply(case,tmp_path)
        assert dump(tmp_path/'backup.db')==before
    finally:
        writer.close()


def test_twenty_three_verified_players_per_side_are_supported(case,tmp_path):
    game=case[1]['games'][0]
    for player,team in [(45,11),(46,22)]:
        row=deepcopy(game['rows'][0])
        row.update(api_player_id=1000+player,player_name=f'Player {player}',api_team_id=team)
        game['rows'].append(row)
    assert len(apply(case,tmp_path)['rows_to_insert'])==46


@pytest.mark.parametrize('field,url', [
    ('source','https://v1.afl.api-sports.io/games/statistics/players?id=201'),
    ('source','https://v1.afl.api-sports.io/games/statistics/players?id=200&id=200'),
    ('schedule_source','https://api.squiggle.com.au/?q=games;year=2025')])
def test_receipts_must_bind_to_source_game_and_season(case,field,url):
    case[1]['games'][0][field]['source_url']=url
    with pytest.raises(ValueError,match='receipt does not identify'):plan_import(*case)


def test_multiple_final_games_apply_in_one_transaction(case,tmp_path):
    later=deepcopy(case[1]['games'][0])
    later.update(api_game_id=201,game_date='2026-09-11',round_number=27)
    later['source']['source_url']='https://v1.afl.api-sports.io/games/statistics/players?id=201'
    case[1]['games'].append(later)
    result=apply(case,tmp_path)
    assert len(result['games_to_insert'])==2 and len(result['rows_to_insert'])==88
    with sqlite3.connect(case[0]) as conn:
        assert conn.execute('SELECT days_since_last_game FROM player_game_stats WHERE player_id=1 AND game_id=3').fetchone()[0]==7


def test_player_cannot_change_club_between_finals_in_same_bundle(case):
    later=deepcopy(case[1]['games'][0])
    later.update(api_game_id=201,game_date='2026-09-11')
    later['source']['source_url']='https://v1.afl.api-sports.io/games/statistics/players?id=201'
    later['rows'][1]['api_team_id']=22
    later['rows'][23]['api_team_id']=11
    case[1]['games'].append(later)
    with pytest.raises(ValueError,match='changes club'):plan_import(*case)


def official_override(row, *, raw_id=None, number=3):
    row.update(source_api_player_id=raw_id if raw_id is not None else row['api_player_id'],
               source_player_number=number,official_player_number=number,official_player_name=row['player_name'],
               identity_source={'source_url':'https://www.geelongcats.com.au/news/verified-team',
                    'retrieved_at':'2026-09-12T01:00:00+00:00','source_sha256':'c'*64})


def add_new_player(bundle):
    row=bundle['games'][0]['rows'][-1]
    row.update(api_player_id=None,new_player_key='new-verified-player',player_name='New Verified Player')
    official_override(row,raw_id=7000,number=44)
    declaration={'key':'new-verified-player','player_name':'New Verified Player','api_player_id':None,
        'api_team_id':row['api_team_id'],'official_player_name':'New Verified Player',
        'identity_source':{**row['identity_source'],'source_url':'https://www.geelongcats.com.au/players/999/new-verified-player'}}
    bundle['new_players']=[declaration]
    return row,declaration


def test_explicit_source_identity_override_records_raw_id_without_changing_player_identity(case,tmp_path):
    db,bundle=case
    official_override(bundle['games'][0]['rows'][0],raw_id=9001)
    with sqlite3.connect(db) as conn:
        original=conn.execute('SELECT * FROM players ORDER BY player_id').fetchall()
    result=apply(case,tmp_path)
    assert result['source_identity_overrides'][0]['source_api_player_id']==9001
    assert result['source_identity_overrides'][0]['canonical_api_player_id']==1001
    with sqlite3.connect(db) as conn:
        assert conn.execute('SELECT * FROM players ORDER BY player_id').fetchall()==original
        receipt=json.loads(conn.execute('SELECT receipt_json FROM afl_verified_final_imports').fetchone()[0])
        assert receipt['bundle']['games'][0]['rows'][0]['source_api_player_id']==9001
        assert receipt['source_identity_overrides'][0]['player_id']==1


def test_declared_new_player_has_null_api_id_and_durable_retry_binding(case,tmp_path):
    db,bundle=case
    add_new_player(bundle)
    before=dump(db)
    plan=apply(case,tmp_path)
    assert plan['new_players_to_insert']==[{'player_id':47,'player_name':'New Verified Player','api_player_id':None}]
    with sqlite3.connect(db) as conn:
        assert conn.execute('SELECT player_name,api_player_id FROM players WHERE player_id=47').fetchone()==('New Verified Player',None)
        assert conn.execute('SELECT 1 FROM players WHERE api_player_id=7000').fetchone() is None
        assert conn.execute('SELECT COUNT(*) FROM player_game_stats WHERE player_id=47').fetchone()[0]==1
    assert dump(tmp_path/'backup.db')==before
    retry=plan_import(db,bundle)
    assert retry['new_players_to_insert']==retry['rows_to_insert']==[]
    assert retry['new_player_map'][0]['player_id']==47
    committed=dump(db)
    apply_import(db,bundle,expected_plan_sha256=retry['plan_sha256'],backup_path=None)
    assert dump(db)==committed


def test_existing_same_normalized_name_without_ledger_blocks_creation(case):
    add_new_player(case[1])
    with sqlite3.connect(case[0]) as conn:
        conn.execute("INSERT INTO players(player_name) VALUES('  NEW   VERIFIED PLAYER  ')")
    with pytest.raises(ValueError,match='already exists without'):plan_import(*case)


def test_new_player_same_name_race_cannot_apply(case,tmp_path):
    add_new_player(case[1])
    plan=plan_import(*case)
    with sqlite3.connect(case[0]) as conn:
        conn.execute("INSERT INTO players(player_name) VALUES('New Verified Player')")
    before=dump(case[0])
    with pytest.raises(ValueError):
        apply_import(*case,expected_plan_sha256=plan['plan_sha256'],backup_path=tmp_path/'backup.db')
    assert dump(case[0])==before and not (tmp_path/'backup.db').exists()


def test_identity_receipt_change_cannot_rebind_created_new_player(case,tmp_path):
    _,declaration=add_new_player(case[1])
    apply(case,tmp_path)
    declaration['identity_source']['source_sha256']='d'*64
    with pytest.raises(ValueError,match='differs from durable'):plan_import(*case)


def test_later_global_api_assignment_breaks_null_identity_retry(case,tmp_path):
    add_new_player(case[1])
    apply(case,tmp_path)
    with sqlite3.connect(case[0]) as conn:conn.execute('UPDATE players SET api_player_id=99999 WHERE player_id=47')
    with pytest.raises(ValueError,match='identity has changed'):plan_import(*case)


def test_atomic_failure_rolls_back_new_player_and_ledger(case,tmp_path):
    add_new_player(case[1])
    with sqlite3.connect(case[0]) as conn:
        conn.execute("CREATE TRIGGER synthetic_failure BEFORE INSERT ON player_game_stats WHEN NEW.player_id=10 BEGIN SELECT RAISE(ABORT,'failure'); END")
    before=dump(case[0])
    with pytest.raises(sqlite3.IntegrityError):apply(case,tmp_path)
    assert dump(case[0])==before
    with sqlite3.connect(case[0]) as conn:
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='afl_verified_final_imports'").fetchone() is None
        assert conn.execute('SELECT 1 FROM players WHERE player_id=47').fetchone() is None


def test_same_id_official_override_preserves_historical_club_conflict(case,tmp_path):
    row=case[1]['games'][0]['rows'][0]
    official_override(row)
    with sqlite3.connect(case[0]) as conn:conn.execute('UPDATE player_game_stats SET team_id=2 WHERE player_id=1')
    plan=apply(case,tmp_path)
    assert plan['source_identity_overrides'][0]['prior_2026_club_ids']==[2]
    with sqlite3.connect(case[0]) as conn:
        assert conn.execute('SELECT team_id FROM player_game_stats WHERE player_id=1 ORDER BY game_id').fetchall()==[(2,),(1,)]


@pytest.mark.parametrize('mutation',['missing_declaration','wrong_club','fake_global_api','bad_profile','wrong_official_name',
    'mismatched_number','boolean_number','bad_official_host','missing_raw_id','duplicate_source_id','unused_declaration'])
def test_invalid_identity_creation_and_overrides_fail_closed(case,mutation):
    row,declaration=add_new_player(case[1])
    if mutation=='missing_declaration':del case[1]['new_players']
    elif mutation=='wrong_club':declaration['api_team_id']=11
    elif mutation=='fake_global_api':declaration['api_player_id']=7000
    elif mutation=='bad_profile':declaration['identity_source']['source_url']='https://www.geelongcats.com.au/news/profile'
    elif mutation=='wrong_official_name':declaration['official_player_name']='Someone Else'
    elif mutation=='mismatched_number':row['official_player_number']=4
    elif mutation=='boolean_number':row['official_player_number']=True
    elif mutation=='bad_official_host':row['identity_source']['source_url']='https://v1.afl.api-sports.io/players?id=7000'
    elif mutation=='missing_raw_id':del row['source_api_player_id']
    elif mutation=='duplicate_source_id':row['source_api_player_id']=1001
    else:
        row['api_player_id']=1044
        row['player_name']='Player 44'
        row['official_player_name']='Player 44'
        del row['new_player_key']
    before=dump(case[0])
    with pytest.raises(ValueError):plan_import(*case)
    assert dump(case[0])==before


def test_two_raw_ids_cannot_resolve_to_one_canonical_player(case):
    row=case[1]['games'][0]['rows'][1]
    row.update(api_player_id=1001,player_name='Player 1')
    official_override(row,raw_id=9001)
    with pytest.raises(ValueError,match='same local player'):plan_import(*case)


def test_explicit_existing_null_api_identity_never_creates_or_globally_aliases_player(case,tmp_path):
    with sqlite3.connect(case[0]) as conn:conn.execute('UPDATE players SET api_player_id=NULL WHERE player_id=44')
    row=case[1]['games'][0]['rows'][-1]
    row.update(api_player_id=None,canonical_player_id=44)
    official_override(row,raw_id=9000,number=44)
    plan=apply(case,tmp_path)
    assert plan['new_players_to_insert']==[]
    with sqlite3.connect(case[0]) as conn:
        assert conn.execute('SELECT api_player_id FROM players WHERE player_id=44').fetchone()[0] is None
        assert conn.execute('SELECT COUNT(*) FROM players').fetchone()[0]==46
        assert conn.execute('SELECT COUNT(*) FROM player_game_stats WHERE player_id=44').fetchone()[0]==1
    assert plan_import(*case)['rows_to_insert']==[]


@pytest.mark.parametrize('mutation',['not_null','wrong_name','both_selectors','missing_proof','boolean_id','unknown_id'])
def test_existing_null_identity_resolution_requires_exact_explicit_proof(case,mutation):
    with sqlite3.connect(case[0]) as conn:conn.execute('UPDATE players SET api_player_id=NULL WHERE player_id=44')
    row=case[1]['games'][0]['rows'][-1]
    row.update(api_player_id=None,canonical_player_id=44)
    official_override(row,raw_id=9000,number=44)
    if mutation=='not_null':
        with sqlite3.connect(case[0]) as conn:conn.execute('UPDATE players SET api_player_id=1044 WHERE player_id=44')
    elif mutation=='wrong_name':row['player_name']='Another Player'
    elif mutation=='both_selectors':row['new_player_key']='guess'
    elif mutation=='missing_proof':del row['identity_source']
    elif mutation=='boolean_id':row['canonical_player_id']=True
    else:row['canonical_player_id']=99999
    with pytest.raises(ValueError):plan_import(*case)
