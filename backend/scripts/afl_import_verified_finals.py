#!/usr/bin/env python3
"""Bounded, offline finals import. Dry-run by default; never resolves identities.

The reviewed bundle records completed 2026 fixtures and verified participants.
All eight stat keys are required; explicit null remains SQL NULL. Emergency or
unverified rows belong in the acquisition receipt, not in this import bundle.
Apply requires the exact dry-run plan hash and a new SQLite backup destination.
No other ingestion helpers are called: their per-row commits are unsuitable here.
"""
import argparse
from collections import Counter
from contextlib import closing
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import unicodedata
from urllib.parse import parse_qs, urlsplit

STATS = ('disposals', 'goals', 'marks', 'tackles', 'kicks', 'handballs', 'clearances', 'hit_outs')
GAME_FIELDS = ('game_id', 'api_game_id', 'season_year', 'round_number', 'game_type', 'game_date',
               'game_time', 'venue_id', 'home_team_id', 'away_team_id')
ROW_FIELDS = ('player_id', 'game_id', 'team_id', 'opponent_team_id', 'venue_id', 'location', 'game_time', *STATS)
LEDGER_TABLE = 'afl_verified_final_imports'
OFFICIAL_IDENTITY_DOMAINS = ('afl.com.au', 'geelongcats.com.au', 'fremantlefc.com.au', 'afc.com.au',
    'lions.com.au', 'carltonfc.com.au', 'collingwoodfc.com.au', 'hawthornfc.com.au',
    'melbournefc.com.au', 'sydneyswans.com.au', 'westernbulldogs.com.au')


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _positive(value):
    return type(value) is int and value > 0


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _name(value):
    _require(isinstance(value, str) and 0 < len(value.strip()) <= 120, 'Invalid verified player name')
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def _receipt(value, kind):
    _require(isinstance(value, dict), f'Missing {kind} receipt')
    try:
        url = urlsplit(value['source_url'])
        timestamp = datetime.fromisoformat(value['retrieved_at'].replace('Z', '+00:00'))
        checksum = value['source_sha256']
        host = url.hostname or ''
        official = any(host == domain or host.endswith('.' + domain) for domain in OFFICIAL_IDENTITY_DOMAINS)
        allowed = (host == 'v1.afl.api-sports.io' if kind == 'stats' else
                   host == 'api.squiggle.com.au' if kind == 'schedule' else
                   official if kind == 'identity' else
                   official or host in ('v1.afl.api-sports.io', 'api.squiggle.com.au'))
        _require(url.scheme == 'https' and not url.username and not url.password and not url.fragment
                 and url.port in (None, 443) and allowed and timestamp.utcoffset() is not None
                 and isinstance(checksum, str) and len(checksum) == 64
                 and all(c in '0123456789abcdef' for c in checksum), f'Invalid {kind} receipt')
    except (KeyError, TypeError, AttributeError, ValueError) as exc:
        raise ValueError(f'Invalid {kind} receipt') from exc


def _one(conn, table, column, value):
    rows = [dict(r) for r in conn.execute(f'SELECT * FROM {table} WHERE {column}=?', (value,))]
    _require(len(rows) == 1, f'Unresolved or duplicate {table} {column}={value}')
    return rows[0]


def build_plan(conn, bundle):
    """Return deterministic mutations and preconditions; perform no writes."""
    conn.row_factory = sqlite3.Row
    _require(isinstance(bundle, dict) and type(bundle.get('schema_version')) is int
             and bundle.get('schema_version') == 1 and type(bundle.get('season')) is int
             and bundle.get('season') == 2026, 'Expected 2026 verified finals bundle v1')
    cutoff = date.fromisoformat(bundle['cutoff_local_date'])
    _require(cutoff.year == 2026, 'Cutoff must be in 2026')
    games = bundle.get('games')
    _require(isinstance(games, list) and 1 <= len(games) <= 11 and all(isinstance(g, dict) for g in games), 'Expected 1–11 finals including wildcard matches')
    ids = [g.get('api_game_id') for g in games]
    _require(all(_positive(i) for i in ids) and len(set(ids)) == len(ids), 'Duplicate or invalid source game IDs')
    for table, fields in {'games': GAME_FIELDS, 'player_game_stats': ('stat_id', *ROW_FIELDS, 'days_since_last_game'),
                          'players': ('player_id', 'api_player_id', 'player_name'),
                          'teams': ('team_id', 'api_team_id', 'team_name'), 'venues': ('venue_id', 'venue_name')}.items():
        actual = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
        _require(set(fields) <= actual, f'Unsupported {table} schema')
    plan = {'schema_version': 1, 'bundle_sha256': _digest(bundle), 'games_to_insert': [],
            'rows_to_insert': [], 'days_to_update': [], 'already_present_api_game_ids': [],
            'new_players_to_insert': [], 'new_player_map': [], 'source_identity_overrides': [],
            'preconditions': {'games': [], 'rows': [], 'identities': [], 'histories': []}}
    max_id = conn.execute('SELECT COALESCE(MAX(game_id),0) FROM games').fetchone()[0]
    plan['preconditions']['max_game_id'] = max_id
    max_player_id = conn.execute('SELECT COALESCE(MAX(player_id),0) FROM players').fetchone()[0]
    plan['preconditions']['max_player_id'] = max_player_id
    ledger_exists = conn.execute('SELECT 1 FROM sqlite_master WHERE type="table" AND name=?', (LEDGER_TABLE,)).fetchone()
    ledger = []
    if ledger_exists:
        _require({'bundle_sha256', 'plan_sha256', 'applied_at', 'receipt_json'} <=
                 {r['name'] for r in conn.execute(f'PRAGMA table_info({LEDGER_TABLE})')}, 'Unsupported import ledger schema')
        ledger = [dict(r) for r in conn.execute(f'SELECT * FROM {LEDGER_TABLE} ORDER BY bundle_sha256')]
    plan['preconditions']['ledger_sha256'] = _digest(ledger)
    bindings = {}
    for record in ledger:
        receipt = json.loads(record['receipt_json'])
        for mapping in receipt.get('new_player_map', []):
            existing = bindings.setdefault(mapping['key'], mapping)
            _require(existing == mapping, 'Conflicting durable new-player identity bindings')
    declarations = bundle.get('new_players', [])
    _require(isinstance(declarations, list) and len(declarations) <= 20 and all(isinstance(p, dict) for p in declarations), 'Invalid new player declarations')
    declared = {}
    names = [dict(r) for r in conn.execute('SELECT player_id,player_name,api_player_id FROM players')]
    declared_names = set()
    for entry in declarations:
        key = entry.get('key')
        _require(isinstance(key, str) and 0 < len(key) <= 100 and all(c.isascii() and (c.isalnum() or c in '-_') for c in key)
                 and key not in declared and 'api_player_id' in entry and entry['api_player_id'] is None
                 and _positive(entry.get('api_team_id')), 'Invalid or duplicate declared new player')
        normalized = _name(entry.get('player_name'))
        _require(normalized == _name(entry.get('official_player_name')), 'New player name must match official identity')
        _require(normalized not in declared_names, 'Duplicate declared new player name')
        declared_names.add(normalized)
        _receipt(entry.get('identity_source'), 'identity')
        _require('/players/' in urlsplit(entry['identity_source']['source_url']).path,
                 'New player requires an official player profile receipt')
        team = _one(conn, 'teams', 'api_team_id', entry['api_team_id'])
        declaration_sha = _digest(entry)
        matches = [p for p in names if _name(p['player_name']) == normalized]
        if key in bindings:
            binding = bindings[key]
            _require(binding['declaration_sha256'] == declaration_sha and binding['api_team_id'] == entry['api_team_id'],
                     'New player declaration differs from durable identity binding')
            player = _one(conn, 'players', 'player_id', binding['player_id'])
            _require(len(matches) == 1 and player['player_name'] == entry['player_name'] and player['api_player_id'] is None,
                     'Durably bound new player identity has changed')
            plan['preconditions']['identities'].append({'table': 'players', 'row': player})
        else:
            _require(not matches, 'New player name already exists without an import identity binding')
            max_player_id += 1
            player = {'player_id': max_player_id, 'player_name': entry['player_name'], 'api_player_id': None}
            plan['new_players_to_insert'].append(player)
        mapping = {'key': key, 'player_id': player['player_id'], 'api_team_id': team['api_team_id'],
                   'player_name': player['player_name'], 'declaration_sha256': declaration_sha}
        plan['new_player_map'].append(mapping)
        declared[key] = (player, entry)
    used_declarations = set()
    affected = set()
    seen_appearances = set()
    seen_club_dates = set()
    imported_player_clubs = {}
    for source in sorted(games, key=lambda g: g['api_game_id']):
        api_id = source['api_game_id']
        _receipt(source.get('source'), 'stats')
        _receipt(source.get('schedule_source'), 'schedule')
        stats_url = urlsplit(source['source']['source_url'])
        _require(stats_url.path == '/games/statistics/players'
                 and parse_qs(stats_url.query, keep_blank_values=True) == {'id': [str(api_id)]},
                 'Stats receipt does not identify this game')
        schedule_url = urlsplit(source['schedule_source']['source_url'])
        schedule_query = parse_qs(schedule_url.query.replace(';', '&'), keep_blank_values=True)
        _require(schedule_query.get('q') == ['games'] and schedule_query.get('year') == ['2026'],
                 'Schedule receipt does not identify 2026 games')
        played = date.fromisoformat(source['game_date'])
        _require(played.year == 2026 and played <= cutoff and source.get('game_type') == 'Finals'
                 and source.get('status') == 'FT', f'Fixture {api_id} is not a completed in-scope final')
        clock = source.get('game_time')
        _require(isinstance(clock, str) and len(clock) == 8, 'Require verified local HH:MM:SS clock')
        parsed = datetime.strptime(clock, '%H:%M:%S')
        _require(parsed.strftime('%H:%M:%S') == clock, 'Invalid local clock')
        round_number = source.get('round_number')
        _require(round_number is None or _positive(round_number), 'Invalid round number')
        sides = []
        for side in ('home', 'away'):
            spec = source.get(side)
            _require(isinstance(spec, dict) and _positive(spec.get('api_team_id')), 'Invalid club identity')
            team = _one(conn, 'teams', 'api_team_id', spec['api_team_id'])
            _require(team['team_name'] == spec.get('team_name'), 'Club full name differs from reviewed identity')
            sides.append(team)
            plan['preconditions']['identities'].append({'table': 'teams', 'row': team})
        home, away = sides
        _require(home['team_id'] != away['team_id'], 'Same club on both sides')
        for team in sides:
            club_date = (team['team_id'], source['game_date'])
            _require(club_date not in seen_club_dates, 'Club appears in two imported games on one date')
            seen_club_dates.add(club_date)
        venue_spec = source.get('venue')
        _require(isinstance(venue_spec, dict) and _positive(venue_spec.get('venue_id')), 'Invalid venue identity')
        venue = _one(conn, 'venues', 'venue_id', venue_spec['venue_id'])
        _require(venue['venue_name'] == venue_spec.get('venue_name'), 'Venue name differs from reviewed identity')
        plan['preconditions']['identities'].append({'table': 'venues', 'row': venue})
        existing_games = [dict(r) for r in conn.execute('SELECT * FROM games WHERE api_game_id=?', (api_id,))]
        _require(len(existing_games) <= 1, 'Duplicate local game API identity')
        fixtures = [dict(r) for r in conn.execute('''SELECT * FROM games WHERE season_year=2026 AND game_date=?
            AND ((home_team_id=? AND away_team_id=?) OR (home_team_id=? AND away_team_id=?))''',
            (source['game_date'], home['team_id'], away['team_id'], away['team_id'], home['team_id']))]
        _require(not fixtures or (len(fixtures) == 1 and existing_games and fixtures[0]['game_id'] == existing_games[0]['game_id']),
                 'Conflicting existing fixture by date and clubs')
        if existing_games:
            game_id = existing_games[0]['game_id']
        else:
            max_id += 1
            game_id = max_id
        game = dict(zip(GAME_FIELDS, (game_id, api_id, 2026, round_number, 'Finals', source['game_date'],
                                     clock, venue['venue_id'], home['team_id'], away['team_id'])))
        if existing_games:
            _require(all(existing_games[0][k] == v for k, v in game.items()), 'Existing fixture differs from verified fixture')
        plan['preconditions']['games'].extend(existing_games)
        incoming = source.get('rows')
        _require(isinstance(incoming, list) and 44 <= len(incoming) <= 46 and all(isinstance(r, dict) for r in incoming),
                 'Require complete reviewed 22–23 player sides')
        player_api_ids = [r.get('source_api_player_id', r.get('api_player_id')) for r in incoming]
        _require(all(_positive(i) for i in player_api_ids) and len(set(player_api_ids)) == len(player_api_ids), 'Duplicate or invalid source player API identity')
        _require(all(_positive(r.get('api_team_id')) for r in incoming), 'Invalid player club identity')
        counts = Counter(r['api_team_id'] for r in incoming)
        _require(set(counts) == {home['api_team_id'], away['api_team_id']} and all(22 <= n <= 23 for n in counts.values()), 'Incomplete or unbalanced participating sides')
        desired = []
        resolved_players = set()
        for row in sorted(incoming, key=lambda r: r.get('source_api_player_id', r.get('api_player_id'))):
            _require(row.get('participation') == 'verified', 'Unverified participation cannot be imported')
            _receipt(row.get('participation_source'), 'participation')
            canonical_api = row.get('api_player_id')
            raw_api = row.get('source_api_player_id', canonical_api)
            override = canonical_api is None or raw_api != canonical_api or 'identity_source' in row
            if override:
                _require(_positive(row.get('source_player_number')) and row['source_player_number'] <= 99
                         and type(row.get('official_player_number')) is int
                         and row['source_player_number'] == row['official_player_number'], 'Identity override requires equal verified player numbers')
                _name(row.get('official_player_name'))
                _receipt(row.get('identity_source'), 'identity')
            if canonical_api is None:
                if 'canonical_player_id' in row:
                    _require(_positive(row['canonical_player_id']) and 'new_player_key' not in row,
                             'Invalid explicit existing NULL-API identity')
                    player = _one(conn, 'players', 'player_id', row['canonical_player_id'])
                    _require(player['api_player_id'] is None, 'Explicit local identity is no longer NULL-API')
                else:
                    key = row.get('new_player_key')
                    _require(isinstance(key, str) and key in declared, 'Missing explicit new-player declaration')
                    player, entry = declared[key]
                    _require(row['api_team_id'] == entry['api_team_id'] and row['official_player_name'] == entry['official_player_name'],
                             'New-player row does not match declared official club identity')
                    used_declarations.add(key)
            else:
                _require(_positive(canonical_api) and 'new_player_key' not in row and 'canonical_player_id' not in row,
                         'Invalid canonical player identity')
                player = _one(conn, 'players', 'api_player_id', canonical_api)
            _require(player['player_id'] not in resolved_players, 'Two source rows resolve to the same local player')
            resolved_players.add(player['player_id'])
            _require(player['player_name'] == row.get('player_name'), 'Player full name differs from reviewed identity')
            plan['preconditions']['identities'].append({'table': 'players', 'row': player})
            for stat in STATS:
                _require(stat in row and (row[stat] is None or type(row[stat]) is int and 0 <= row[stat] <= 1000), f'Invalid or missing {stat}')
            if all(row[k] is not None for k in ('disposals', 'kicks', 'handballs')):
                _require(row['disposals'] == row['kicks'] + row['handballs'], 'Disposals arithmetic mismatch')
            team, opponent = (home, away) if row['api_team_id'] == home['api_team_id'] else (away, home)
            prior_imported_club = imported_player_clubs.setdefault(player['player_id'], team['team_id'])
            _require(prior_imported_club == team['team_id'], 'Player changes club inside finals bundle')
            prior_clubs = {r[0] for r in conn.execute('''SELECT DISTINCT s.team_id FROM player_game_stats s
                JOIN games g USING(game_id) WHERE s.player_id=? AND g.season_year=2026 AND g.game_date<?''',
                (player['player_id'], source['game_date']))}
            _require(not prior_clubs or prior_clubs == {team['team_id']} or override,
                     'Player has conflicting prior 2026 club evidence')
            if override:
                plan['source_identity_overrides'].append({
                    'api_game_id': api_id, 'player_id': player['player_id'], 'player_name': player['player_name'],
                    'canonical_api_player_id': canonical_api, 'source_api_player_id': raw_api,
                    'source_player_number': row['source_player_number'], 'official_player_number': row['official_player_number'],
                    'official_player_name': row['official_player_name'], 'identity_source': row['identity_source'],
                    'prior_2026_club_ids': sorted(prior_clubs), 'imported_team_id': team['team_id']})
            appearance = (player['player_id'], source['game_date'])
            _require(appearance not in seen_appearances, 'Player appears in two imported games on one date')
            seen_appearances.add(appearance)
            conflicts = conn.execute('''SELECT s.game_id FROM player_game_stats s JOIN games g USING(game_id)
                WHERE s.player_id=? AND g.game_date=? AND s.game_id<>?''', (*appearance, game_id)).fetchall()
            _require(not conflicts, 'Player already has a different game on the same date')
            category = 'Day' if parsed.hour < 15 else 'Twilight' if parsed.hour < 18 else 'Night'
            desired.append(dict(zip(ROW_FIELDS, (player['player_id'], game_id, team['team_id'], opponent['team_id'],
                venue['venue_id'], 'Home' if team is home else 'Away', category, *(row[s] for s in STATS)))))
        existing_rows = [dict(r) for r in conn.execute('SELECT * FROM player_game_stats WHERE game_id=? ORDER BY player_id', (game_id,))] if existing_games else []
        plan['preconditions']['rows'].extend(existing_rows)
        if existing_rows:
            actual = sorted([{k: r[k] for k in ROW_FIELDS} for r in existing_rows], key=lambda r: r['player_id'])
            _require(actual == sorted(desired, key=lambda r: r['player_id']), 'Existing game is partial or differs from verified stats')
            plan['already_present_api_game_ids'].append(api_id)
        else:
            if not existing_games:
                plan['games_to_insert'].append(game)
            plan['rows_to_insert'].extend(desired)
            affected.update(r['player_id'] for r in desired)
    _require(used_declarations == set(declared), 'Unused new-player declaration')
    _require(not plan['rows_to_insert'] or not any(r['bundle_sha256'] == plan['bundle_sha256'] for r in ledger),
             'Previously recorded import has drifted; requires separate reconciliation')
    game_dates = {g['game_id']: g['game_date'] for g in plan['games_to_insert']}
    for player_id in sorted(affected):
        history = [dict(r) for r in conn.execute('''SELECT s.stat_id,s.game_id,s.days_since_last_game,g.game_date
            FROM player_game_stats s JOIN games g USING(game_id) WHERE s.player_id=? ORDER BY g.game_date,s.game_id''', (player_id,))]
        plan['preconditions']['histories'].append({'player_id': player_id, 'rows': history})
        combined = list(history)
        for row in plan['rows_to_insert']:
            if row['player_id'] == player_id:
                day = game_dates.get(row['game_id']) or conn.execute('SELECT game_date FROM games WHERE game_id=?', (row['game_id'],)).fetchone()[0]
                combined.append({'game_id': row['game_id'], 'game_date': day, 'days_since_last_game': None})
        previous = None
        for row in sorted(combined, key=lambda r: (r['game_date'], r['game_id'])):
            day = date.fromisoformat(row['game_date'])
            days = (day - previous).days if previous else None
            if days != row['days_since_last_game']:
                plan['days_to_update'].append({'player_id': player_id, 'game_id': row['game_id'], 'days_since_last_game': days})
            previous = day
    plan['affected_player_ids'] = sorted(affected)
    plan['plan_sha256'] = _digest(plan)
    return plan


def import_bundle(db_path, bundle, *, apply=False, expected_plan_sha256=None, backup_path=None):
    """Validate/review or atomically apply; return the full reviewable plan.

    A backup uses SQLite's online backup API while a RESERVED write lock blocks
    concurrent writers. Failure rolls back the transaction, never copies files
    over an active database. The snapshot remains available for later recovery.
    """
    db_path = Path(db_path).resolve()
    _require(db_path.is_file(), 'Database must already exist')
    conn = sqlite3.connect(db_path.as_uri() + ('?mode=rw' if apply else '?mode=ro'), uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        plan = build_plan(conn, bundle)
        if not apply:
            conn.rollback()
            return plan
        _require(expected_plan_sha256 == plan['plan_sha256'], 'Reviewed plan hash no longer matches database and bundle')
        if not plan['rows_to_insert']:
            conn.rollback()
            return plan
        _require(backup_path is not None, 'Apply requires a new backup path')
        backup = Path(backup_path).resolve()
        _require(backup != db_path and not backup.exists(), 'Backup must be a new distinct file')
        # Reserve the path exclusively, then copy through SQLite (WAL-aware).
        with backup.open('xb'):
            pass
        with closing(sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)) as reader, closing(sqlite3.connect(backup)) as target:
            reader.backup(target)
            _require(target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Backup integrity failure')
        before_fk = {tuple(r) for r in conn.execute('PRAGMA foreign_key_check')}
        conn.execute(f'''CREATE TABLE IF NOT EXISTS {LEDGER_TABLE} (
            bundle_sha256 TEXT PRIMARY KEY, plan_sha256 TEXT NOT NULL,
            applied_at TEXT NOT NULL, receipt_json TEXT NOT NULL)''')
        for player in plan['new_players_to_insert']:
            conn.execute('INSERT INTO players(player_id,player_name,api_player_id) VALUES(?,?,NULL)',
                         (player['player_id'], player['player_name']))
        for game in plan['games_to_insert']:
            conn.execute(f"INSERT INTO games ({','.join(GAME_FIELDS)}) VALUES ({','.join('?' for _ in GAME_FIELDS)})", tuple(game[k] for k in GAME_FIELDS))
        for row in plan['rows_to_insert']:
            conn.execute(f"INSERT INTO player_game_stats ({','.join(ROW_FIELDS)}) VALUES ({','.join('?' for _ in ROW_FIELDS)})", tuple(row[k] for k in ROW_FIELDS))
        for row in plan['days_to_update']:
            cursor = conn.execute('UPDATE player_game_stats SET days_since_last_game=? WHERE player_id=? AND game_id=?',
                                 (row['days_since_last_game'], row['player_id'], row['game_id']))
            _require(cursor.rowcount == 1, 'Derived update target is not unique')
        _require({tuple(r) for r in conn.execute('PRAGMA foreign_key_check')} <= before_fk, 'Import introduced foreign key failures')
        _require(conn.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'Database quick check failed')
        receipt = {'bundle': bundle, 'new_player_map': plan['new_player_map'],
                   'source_identity_overrides': plan['source_identity_overrides'],
                   'inserted_game_ids': [g['game_id'] for g in plan['games_to_insert']]}
        conn.execute(f'INSERT INTO {LEDGER_TABLE}(bundle_sha256,plan_sha256,applied_at,receipt_json) VALUES(?,?,?,?)',
                     (plan['bundle_sha256'], plan['plan_sha256'], datetime.now(timezone.utc).isoformat(),
                      json.dumps(receipt, sort_keys=True, separators=(',', ':'), allow_nan=False)))
        conn.commit()
        return plan
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def plan_import(db_path, bundle):
    return import_bundle(db_path, bundle)


def apply_import(db_path, bundle, *, expected_plan_sha256, backup_path):
    return import_bundle(db_path, bundle, apply=True, expected_plan_sha256=expected_plan_sha256, backup_path=backup_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-plan-sha256')
    parser.add_argument('--backup')
    args = parser.parse_args()
    try:
        bundle = json.loads(Path(args.bundle).read_text())
        plan = import_bundle(args.db, bundle, apply=args.apply,
                             expected_plan_sha256=args.expected_plan_sha256, backup_path=args.backup)
        print(json.dumps({'mode': 'applied' if args.apply else 'dry-run', 'plan': plan}, indent=2))
        return 0
    except (ValueError, KeyError, TypeError, sqlite3.Error, OSError) as exc:
        print(f'Import rejected: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
