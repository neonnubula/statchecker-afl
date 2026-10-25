"""Reviewed finals fixture facts, isolated from the historical statistics database.

Negative fixture IDs belong to this overlay, never to the SQLite fixtures table.
Unconfirmed dates/opponents stay null. No scheduled start is inferred from a
round window; a known pairing alone is insufficient for next-game modelling.
"""
from datetime import datetime, time, timedelta, timezone
import json
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Australia/Melbourne')
DATA_PATH = Path(__file__).resolve().parents[1] / 'data' / 'afl_remaining_fixtures.json'


def now_local():
    return datetime.now(ZONE)


def _instant(value):
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError('Fixture evidence timestamp requires timezone')
    return result


def _unique_id(conn, table, column, names):
    # Table/column are internal constants; values are always bound.
    if not names:
        return None
    id_column = 'team_id' if table == 'teams' else 'venue_id'
    rows = conn.execute(f'SELECT {id_column} FROM {table} WHERE {column} IN ({",".join("?" for _ in names)})', names).fetchall()
    return rows[0][0] if len(rows) == 1 else None


def remaining_fixtures(conn, *, now=None, data=None):
    """Return None outside overlay scope, [] after its fixtures have elapsed."""
    now = now or now_local()
    if now.tzinfo is None:
        raise ValueError('Current time requires timezone')
    if data is None and not DATA_PATH.exists():
        # Optional: a reviewed list of upcoming fixtures your source has not published yet.
        return None
    data = data if data is not None else json.loads(DATA_PATH.read_text())
    if data.get('schema_version') != 1 or type(data.get('season')) is not int:
        raise ValueError('Invalid fixture overlay')
    season = data['season']
    checked = _instant(data['checked_at'])
    if checked.astimezone(ZONE).year != season:
        raise ValueError('Evidence outside fixture season')
    if now.astimezone(ZONE).year != season or now < checked:
        return None
    rows = data.get('fixtures')
    if not isinstance(rows, list) or len(rows) > 20:
        raise ValueError('Invalid fixture rows')
    fixtures, seen = [], set()
    for row in rows:
        fid = row['fixture_id']
        if type(fid) is not int or fid >= 0 or fid in seen:
            raise ValueError('Invalid overlay fixture identity')
        seen.add(fid)
        for url in row['source_urls']:
            parsed = urlparse(url)
            if parsed.scheme != 'https' or parsed.hostname not in {
                'www.afl.com.au', 'www.sydneyswans.com.au', 'www.hawthornfc.com.au',
                'www.sydneycricketground.com.au', 'www.fremantlefc.com.au',
            } or parsed.username or parsed.password:
                raise ValueError('Fixture requires official source')
        if not row['source_urls']:
            raise ValueError('Missing fixture evidence')
        first = datetime.fromisoformat(row['date_window_start']).date()
        last = datetime.fromisoformat(row['date_window_end']).date()
        if first.year != season or last.year != season or first > last:
            raise ValueError('Invalid fixture date window')
        start = _instant(row['starts_at']) if row.get('starts_at') else None
        if start and not first <= start.astimezone(ZONE).date() <= last:
            raise ValueError('Start conflicts with fixture date window')
        # Expire at kickoff, or after the last possible local match day for TBC.
        expires = start or datetime.combine(last + timedelta(days=1), time.min, ZONE)
        if now >= expires:
            continue
        home, away = row['home_team_name'], row['away_team_name']
        home_id = _unique_id(conn, 'teams', 'team_name', [home]) if home else None
        away_id = _unique_id(conn, 'teams', 'team_name', [away]) if away else None
        known_pairing = bool(home and away)
        confirmed = bool(known_pairing and start and row['venue_name'])
        fixtures.append({
            'fixture_id': fid, 'season_year': season,
            'round_name': row['round_name'], 'round_number': row['round_number'],
            'game_type': 'Finals', 'game_date': start.astimezone(ZONE).date().isoformat() if start else None,
            'game_time': start.astimezone(ZONE).strftime('%-I:%M %p %Z') if start else None,
            'starts_at': start.isoformat() if start else None,
            'date_window_start': first.isoformat(), 'date_window_end': last.isoformat(),
            'home_team_id': home_id, 'home_team_name': home or 'TBC',
            'away_team_id': away_id, 'away_team_name': away or 'TBC',
            'venue_id': _unique_id(conn, 'venues', 'venue_name', row['venue_lookup_names']),
            'venue_name': row['venue_name'] or 'TBC',
            'schedule_status': 'confirmed' if confirmed else 'details_tbc',
            'selectable': confirmed and home_id is not None and away_id is not None,
            'source': 'official_fixture_review', 'source_urls': row['source_urls'],
            'checked_at': data['checked_at'], 'note': row['note'],
        })
    return sorted(fixtures, key=lambda r: (r['date_window_start'], r['round_number'], r['fixture_id']))
