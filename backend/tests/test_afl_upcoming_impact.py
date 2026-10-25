from datetime import datetime, timezone
import sqlite3
import pytest

from app.afl_upcoming_impact import attach_reviewed_upcoming

NOW = datetime(2026,9,12,1,tzinfo=timezone.utc)


def setup():
    conn=sqlite3.connect(':memory:', check_same_thread=False)
    conn.executescript('CREATE TABLE games(game_id,season_year,home_team_id,away_team_id,game_date); CREATE TABLE teams(team_id,team_name); INSERT INTO teams VALUES(1,"Adelaide Crows");')
    f={'fixture_id':-1,'game_type':'Finals','season_year':2026,'round_number':27,'home_team_name':'Brisbane Lions','away_team_name':'Adelaide Crows', 'starts_at':'2026-09-12T19:35:00+10:00','date_window_start':'2026-09-12','date_window_end':'2026-09-12','checked_at':'2026-09-11T23:00:00+00:00','source_urls':['https://www.afl.com.au/finals/tickets/semi-final-2'],'venue_name':'Gabba'}
    h={'seasons':[{'season':2026,'source_url':'https://api.squiggle.com.au/?q=games&year=2026','retrieved_at':'2026-09-11T22:10:00+00:00','games':[{'source_game_id':'squiggle:1','starts_at':'2026-09-05T09:35:00+00:00','local_date':'2026-09-05','home':'Adelaide','away':'Western Bulldogs','venue':'Adelaide Oval'}]}]}
    v={'Adelaide Oval':{'latitude':-34.9,'longitude':138.6},'Gabba':{'latitude':-27.5,'longitude':153.0}}
    b=[{'key':'band','min_inclusive':0,'max_exclusive':None}]
    result={'rest':{'buckets':b},'travel':{'buckets':b}}
    return conn,f,h,v,result


def call(conn,f,h,v,result):
    return attach_reviewed_upcoming(result,'Adelaide',conn,now=NOW,fixtures=[f],history=h,venues=v)['upcoming']


def test_confirmed_match_auto_uses_previous_club_game_and_designation():
    c,f,h,v,r=setup(); u=call(c,f,h,v,r)
    assert u['available'] and u['start_gap_hours']==168
    assert u['game_type']=='Finals'
    assert u['travel_transition']=='home_to_away' and u['venue_distance_km']>1500
    assert u['rest_bucket']==u['travel_bucket']=='band'
    assert u['retrieved_at']==f['checked_at']  # Never relabel an old review as now.


def test_tbc_time_retains_travel_but_never_invents_rest():
    c,f,h,v,r=setup(); f.update(starts_at=None,date_window_start='2026-09-18',date_window_end='2026-09-19')
    u=call(c,f,h,v,r)
    assert u['available'] and u['travel_bucket']=='band'
    assert u['start_gap_hours'] is None and u['rest_bucket'] is None and u['starts_at'] is None
    assert u['valid_until']=='2026-09-18T00:00:00+10:00'
    assert u['venue_clock_shift_hours'] is None


def test_transition_is_designated_home_away_not_distance():
    c,f,h,v,r=setup();h['seasons'][0]['games'][0].update(home='Western Bulldogs',away='Adelaide',venue='Gabba')
    u=call(c,f,h,v,r)
    assert u['travel_transition']=='away_to_away' and u['venue_distance_km']==0


def test_newer_db_game_blocks_obsolete_previous_ground():
    c,f,h,v,r=setup();c.execute('INSERT INTO games VALUES(2,2026,1,2,"2026-09-10")')
    u=call(c,f,h,v,r); assert not u['available']


def test_unknown_ground_does_not_disable_known_turnaround():
    c,f,h,v,r=setup();f['venue_name']='Unknown'
    u=call(c,f,h,v,r);assert u['start_gap_hours']==168 and u['travel_bucket'] is None
    assert u['venue_clock_shift_hours'] is None


def test_expired_fixture_has_no_automatic_comparison():
    c,f,h,v,r=setup();f['starts_at']='2026-09-12T00:00:00+00:00'
    assert not call(c,f,h,v,r)['available']


def test_api_uses_reviewed_context_without_requesting_live_feed(monkeypatch):
    from fastapi.testclient import TestClient
    import app.main as main
    import app.afl_player_context as reader
    import app.afl_upcoming_impact as reviewed
    import app.afl_context_api as live
    c,f,h,v,r=setup()
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):
            return NOW if tz else NOW.replace(tzinfo=None)
    monkeypatch.setenv('INTERNAL_API_SECRET','test-automatic-context')
    monkeypatch.setattr(main,'datetime',Clock)
    monkeypatch.setattr(main,'get_connection',lambda:c)
    monkeypatch.setattr(main,'_resolve_player_id',lambda *a,**kw:1)
    monkeypatch.setattr(reader,'read_player_impact',lambda *a,**kw:(r,'Adelaide'))
    monkeypatch.setattr(reviewed,'remaining_fixtures',lambda *a,**kw:[f])
    monkeypatch.setattr(reviewed,'load_history',lambda:h)
    def unavailable(*a,**kw):
        raise AssertionError('Reviewed next fixture must not depend on the live feed')
    monkeypatch.setattr(live,'get_context',unavailable)
    response=TestClient(main.app).get('/search/player-impact?player_id=1&stat=disposals',headers={'x-internal-secret':'test-automatic-context'})
    assert response.status_code==200
    assert response.json()['upcoming']['start_gap_hours']==168


def test_tbc_context_expires_before_first_possible_match_day():
    c,f,h,v,r=setup();f.update(starts_at=None,date_window_start='2026-09-18',date_window_end='2026-09-19')
    after_first_possible_start=datetime(2026,9,18,0,tzinfo=timezone.utc)
    u=attach_reviewed_upcoming(r,'Adelaide',c,now=after_first_possible_start,fixtures=[f],history=h,venues=v)['upcoming']
    assert not u['available']


@pytest.mark.parametrize('previous_zone,next_zone,start,expected', [
    ('Australia/Sydney','Australia/Brisbane','2026-09-12T09:35:00+00:00',0),
    ('Australia/Adelaide','Australia/Melbourne','2026-09-12T09:35:00+00:00',0.5),
    ('Australia/Melbourne','Australia/Adelaide','2026-09-12T09:35:00+00:00',-0.5),
    ('Australia/Perth','Australia/Sydney','2026-09-12T09:35:00+00:00',2),
    ('Australia/Sydney','Australia/Perth','2026-09-12T09:35:00+00:00',-2),
    ('Australia/Perth','Australia/Sydney','2026-10-10T09:35:00+00:00',3),
    ('Australia/Sydney','Australia/Perth','2026-10-10T09:35:00+00:00',-3),
    ('Australia/Sydney','Australia/Brisbane','2026-10-10T09:35:00+00:00',-1),
    ('Australia/Brisbane','Australia/Sydney','2026-10-10T09:35:00+00:00',1),
    ('Australia/Adelaide','Australia/Perth','2026-10-10T09:35:00+00:00',-2.5),
    # Crossing a daylight-saving change between matches creates no shift when
    # both grounds use the same zone: both offsets use the next match instant.
    ('Australia/Sydney','Australia/Sydney','2026-10-10T09:35:00+00:00',0),
])
def test_reviewed_clock_context_uses_destination_minus_origin_at_next_kickoff(previous_zone,next_zone,start,expected):
    c,f,h,v,r=setup()
    v['Adelaide Oval']['timezone']=previous_zone
    v['Gabba']['timezone']=next_zone
    f.update(starts_at=start,date_window_start=start[:10],date_window_end=start[:10])
    u=call(c,f,h,v,r)
    assert u['available'] and u['venue_clock_shift_hours']==expected
    assert r['rest']['buckets']==r['travel']['buckets']==[{'key':'band','min_inclusive':0,'max_exclusive':None}]


@pytest.mark.parametrize('missing', ['previous_zone','next_zone','invalid_zone','tbc_start'])
def test_clock_context_is_unknown_without_definite_kickoff_and_valid_zone_metadata(missing):
    c,f,h,v,r=setup()
    v['Adelaide Oval']['timezone']='Australia/Adelaide'
    v['Gabba']['timezone']='Australia/Brisbane'
    if missing=='previous_zone':del v['Adelaide Oval']['timezone']
    elif missing=='next_zone':del v['Gabba']['timezone']
    elif missing=='invalid_zone':v['Gabba']['timezone']='Unknown/Zone'
    else:f.update(starts_at=None,date_window_start='2026-09-18',date_window_end='2026-09-19')
    u=call(c,f,h,v,r)
    assert u['available'] and u['venue_distance_km'] is not None
    assert u['venue_clock_shift_hours'] is None
