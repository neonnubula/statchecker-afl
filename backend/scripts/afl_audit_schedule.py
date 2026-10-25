#!/usr/bin/env python3
"""Read-only schedule comparison. Emits review candidates, never migration SQL."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

# Explicit club-name correspondences; provider integer IDs are never equated.
# Squiggle short club labels -> exact labels in the local teams table.
TEAM_NAMES = {
    'Adelaide': 'Adelaide Crows', 'Brisbane Lions': 'Brisbane Lions',
    'Carlton': 'Carlton Blues', 'Collingwood': 'Collingwood Magpies',
    'Essendon': 'Essendon Bombers', 'Fremantle': 'Fremantle Dockers',
    'Geelong': 'Geelong Cats', 'Gold Coast': 'Gold Coast Suns',
    'Greater Western Sydney': 'Greater Western Sydney Giants',
    'Hawthorn': 'Hawthorn Hawks', 'Melbourne': 'Melbourne Demons',
    'North Melbourne': 'North Melbourne Kangaroos', 'Port Adelaide': 'Port Adelaide Power',
    'Richmond': 'Richmond Tigers', 'St Kilda': 'St Kilda Saints',
    'Sydney': 'Sydney Swans', 'West Coast': 'West Coast Eagles',
    'Western Bulldogs': 'Western Bulldogs',
}


def _key(row):
    return row['season_year'], row['round_number'], row['home_name'], row['away_name']


def _clock(value):
    if not value:
        return None
    for fmt in ('%H:%M', '%H:%M:%S', '%I:%M %p'):
        try:
            return datetime.strptime(value.strip().upper(), fmt).strftime('%H:%M')
        except ValueError:
            pass
    return None


def audit(conn, envelope, season):
    conn.row_factory = sqlite3.Row
    games = [dict(r) for r in conn.execute('''
        SELECT g.*,h.team_name home_name,a.team_name away_name,
        (SELECT COUNT(*) FROM player_game_stats s WHERE s.game_id=g.game_id) player_rows
        FROM games g JOIN teams h ON h.team_id=g.home_team_id
        JOIN teams a ON a.team_id=g.away_team_id WHERE g.season_year=?''', (season,))]
    fixtures = [dict(r) for r in conn.execute('''
        SELECT f.*,h.team_name home_name,a.team_name away_name
        FROM fixtures f JOIN teams h ON h.team_id=f.home_team_id
        JOIN teams a ON a.team_id=f.away_team_id WHERE f.season_year=?''', (season,))]
    local = {'games': games, 'fixtures': fixtures}
    indexes = {table: defaultdict(list) for table in local}
    for table, rows in local.items():
        for row in rows:
            indexes[table][_key(row)].append(row)
    source = [g for g in envelope['payload']['games'] if g.get('year') == season]
    source_ids = Counter(g.get('id') for g in source)
    source_keys = Counter((g.get('year'), g.get('round'), TEAM_NAMES.get(g.get('hteam')),
                           TEAM_NAMES.get(g.get('ateam'))) for g in source)
    candidates, unresolved = [], []
    matched = {'games': set(), 'fixtures': set()}
    for game in source:
        key = (game.get('year'), game.get('round'), TEAM_NAMES.get(game.get('hteam')),
               TEAM_NAMES.get(game.get('ateam')))
        base = {'source_id': game.get('id'), 'season': season, 'round': game.get('round'),
                'source_home': game.get('hteam'), 'source_away': game.get('ateam'),
                'source_round_name': game.get('roundname'), 'source_complete': game.get('complete'),
                'source_final': bool(game.get('is_final')), 'source_venue': game.get('venue')}
        if not key[2] or not key[3] or not isinstance(key[1], int):
            unresolved.append({**base, 'reason': 'unknown_team_or_round'})
            continue
        if game.get('id') is None or source_ids[game['id']] != 1 or source_keys[key] != 1:
            unresolved.append({**base, 'reason': 'nonunique_source_identity'})
            continue
        try:
            local_start = datetime.fromisoformat(game['localtime'])
            source_date = local_start.date().isoformat()
            local_clock = local_start.strftime('%H:%M')
            utc_clock = datetime.fromtimestamp(game['unixtime'], timezone.utc).strftime('%H:%M')
        except (KeyError, TypeError, ValueError, OverflowError, OSError):
            unresolved.append({**base, 'reason': 'invalid_source_start'})
            continue
        candidate = {**base, 'source_local_start': game['localtime'],
                     'source_unix_start': game['unixtime'], 'tables': {}}
        for table in local:
            hits = indexes[table].get(key, [])
            if len(hits) > 1:
                candidate['tables'][table] = {'status': 'ambiguous', 'candidate_ids': [
                    r['game_id' if table == 'games' else 'fixture_id'] for r in hits]}
                continue
            if not hits:
                candidate['tables'][table] = {'status': 'missing'}
                continue
            row = hits[0]
            row_id = row['game_id' if table == 'games' else 'fixture_id']
            matched[table].add(row_id)
            old_clock = _clock(row['game_time'])
            differences = {}
            if row['game_date'] != source_date:
                differences['game_date'] = {'old': row['game_date'], 'candidate': source_date}
            if table == 'games':
                expected_type = 'Finals' if game.get('is_final') else 'Regular Season'
                if row['game_type'] != expected_type:
                    differences['game_type'] = {'old': row['game_type'], 'candidate': expected_type}
            # Local DB time convention has not been established. Report the
            # observations without proposing a blind UTC/local conversion.
            candidate['tables'][table] = {
                'status': 'matched', 'local_id': row_id,
                'player_rows': row.get('player_rows'), 'differences': differences,
                'time_review': {'stored': row['game_time'], 'normalized_stored': old_clock,
                                'source_local': local_clock, 'source_utc': utc_clock,
                                'equals_source_local': old_clock == local_clock,
                                'equals_source_utc': old_clock == utc_clock}}
        candidates.append(candidate)
    summary = {'source_games': len(source), 'source_finals': sum(bool(g.get('is_final')) for g in source),
               'source_completed_finals': sum(bool(g.get('is_final')) and g.get('complete') == 100 for g in source),
               'unresolved_source_records': len(unresolved)}
    for table, rows in local.items():
        states = [r['tables'][table] for r in candidates]
        changed = [r for r in states if r['status'] == 'matched' and r['differences']]
        summary[table] = {
            'local_rows': len(rows), 'uniquely_matched': len(matched[table]),
            'source_missing_locally': sum(r['status'] == 'missing' for r in states),
            'ambiguous_source_matches': sum(r['status'] == 'ambiguous' for r in states),
            'date_discrepancies': sum('game_date' in r['differences'] for r in changed),
            'finals_classification_discrepancies': sum('game_type' in r['differences'] for r in changed),
            'affected_existing_player_rows': sum(r.get('player_rows') or 0 for r in changed) if table == 'games' else None,
            'completed_finals_missing': sum(r['source_final'] and r['source_complete'] == 100
                                           and r['tables'][table]['status'] == 'missing' for r in candidates),
        }
    return {
        'mode': 'read_only_review_candidates_not_migration', 'season': season,
        'source_provenance': {k: envelope.get(k) for k in ('source', 'source_url', 'retrieved_at', 'sha256')},
        'mapping': TEAM_NAMES,
        'mapping_basis': 'Explicit geographic club label plus exact local nickname expansion; no fuzzy matching and no cross-provider ID equivalence. Each accepted match requires a unique season/round/home/away tuple on both sides.',
        'local_comparison_rows_sha256': hashlib.sha256(json.dumps(local, sort_keys=True, default=str).encode()).hexdigest(),
        'summary': summary, 'candidates': candidates, 'unresolved_source': unresolved,
        'unmatched_local': {table: [r for r in rows if r['game_id' if table == 'games' else 'fixture_id'] not in matched[table]] for table, rows in local.items()},
        'limits': ['Only the acquired source season is compared; no claim about other seasons.',
                   'Missing or ambiguous identities are not guessed; missing records are not insertion instructions.',
                   'Player-row impact counts existing rows only; missing match statistics cannot be counted.',
                   'Stored game_time convention requires separate review; local/UTC comparisons are diagnostics only.',
                   'Venues and provider game IDs need authoritative mapping before any migration.',
                   'No database writes, network calls, or generated migration statements.'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--season', type=int, default=2026)
    args = parser.parse_args()
    source_bytes = args.source.read_bytes()
    envelope = json.loads(source_bytes)
    with sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True) as conn:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')  # One consistent read snapshot across all tables.
        report = audit(conn, envelope, args.season)
    report['source_envelope_file_sha256'] = hashlib.sha256(source_bytes).hexdigest()
    report['database_path'] = str(args.db.resolve())
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
