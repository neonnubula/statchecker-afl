"""Verified missing-game stats for impact research; never writes to SQLite.

A whole existing game must be empty. Fixture/player API IDs are local provider
mappings, not Squiggle IDs. Sourced schedule phase and clocks stay with Squiggle.
"""
from collections import Counter, defaultdict
from datetime import datetime
from functools import lru_cache
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit

from app.afl_player_impact import VALID_STATS

SUPPLEMENT_PATH = Path(__file__).resolve().parents[1] / 'data' / 'afl_impact_stat_supplement.json'


@lru_cache(maxsize=1)
def load_supplement():
    return json.loads(SUPPLEMENT_PATH.read_text())


def _valid_receipt(receipt, path, query):
    if not isinstance(receipt, dict):
        return False
    try:
        url = urlsplit(receipt['source_url'])
        retrieved = datetime.fromisoformat(receipt['retrieved_at'].replace('Z', '+00:00'))
        return (url.scheme == 'https' and url.netloc == 'v1.afl.api-sports.io'
                and url.path == path and not url.fragment
                and parse_qs(url.query, keep_blank_values=True) == query
                and retrieved.utcoffset() is not None
                and isinstance(receipt.get('source_sha256'), str)
                and re.fullmatch(r'[0-9a-f]{64}', receipt['source_sha256']) is not None)
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def get_supplemental_appearances(conn, player_id, stat, local_games, matched_games, supplement=None):
    if stat not in VALID_STATS:
        raise ValueError('Unsupported stat')
    report = {'rows_added': 0, 'games_skipped': {}, 'sources': []}
    required = {'players': {'player_id', 'api_player_id'}, 'teams': {'team_id', 'api_team_id', 'team_name'},
                'games': {'game_id', 'api_game_id', 'season_year'},
                'player_game_stats': {'player_id', 'game_id', 'team_id'}}
    if any(not fields.issubset({r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}) for table, fields in required.items()):
        return [], report
    if supplement is None and not SUPPLEMENT_PATH.exists():
        # Optional: a reviewed correction file for games your source left incomplete.
        return [], report
    supplement = load_supplement() if supplement is None else supplement
    if (not isinstance(supplement, dict) or type(supplement.get('schema_version')) is not int
            or supplement.get('schema_version') != 1 or supplement.get('source') != 'api-sports'
            or supplement.get('seasons') != [2013] or not isinstance(supplement.get('games'), list)
            or not 1 <= len(supplement['games']) <= 20):
        raise ValueError('Invalid verified stat supplement')
    for game in supplement['games']:
        if (not isinstance(game, dict) or type(game.get('api_game_id')) is not int
                or game['api_game_id'] <= 0
                or not _valid_receipt(game, '/games/statistics/players', {'id': [str(game['api_game_id'])]})
                or not _valid_receipt(game.get('schedule_source'), '/games', {'season': ['2013'], 'league': ['1']})):
            raise ValueError('Invalid verified stat supplement provenance')
    local_by_api, players_by_api = defaultdict(list), defaultdict(list)
    for g in local_games:
        if g.get('api_game_id') is not None:
            local_by_api[g['api_game_id']].append(g)
    for p in conn.execute('SELECT player_id,api_player_id FROM players'):
        if p['api_player_id'] is not None:
            players_by_api[p['api_player_id']].append(p['player_id'])
    teams = {t['team_id']: dict(t) for t in conn.execute('SELECT team_id,api_team_id,team_name FROM teams')}
    game_api_counts = Counter(r['api_game_id'] for r in conn.execute('SELECT api_game_id FROM games'))
    team_api_counts = Counter(t['api_team_id'] for t in teams.values())
    target_api = [api for api, ids in players_by_api.items() if ids == [player_id]]
    if len(target_api) != 1:
        return [], report
    historical = defaultdict(set)
    for row in conn.execute('''SELECT g.season_year,s.team_id FROM player_game_stats s
            JOIN games g ON g.game_id=s.game_id WHERE s.player_id=?''', (player_id,)):
        historical[row['season_year']].add(row['team_id'])
    skipped, added = Counter(), []
    source_ids = Counter(g.get('api_game_id') for g in supplement['games'])
    for g in supplement['games']:
        api_gid = g.get('api_game_id')
        candidates = local_by_api.get(api_gid, [])
        if source_ids[api_gid] != 1 or len(candidates) != 1 or game_api_counts[api_gid] != 1:
            skipped['nonunique_game_mapping'] += 1
            continue
        local = candidates[0]
        if local['game_id'] not in matched_games:
            skipped['unmatched_sourced_schedule'] += 1
            continue
        if conn.execute('SELECT 1 FROM player_game_stats WHERE game_id=? LIMIT 1', (local['game_id'],)).fetchone():
            skipped['game_already_has_recorded_stats'] += 1
            continue
        home, away = teams.get(local['home_team_id']), teams.get(local['away_team_id'])
        if (g.get('season') != 2013 or local['season_year'] != g['season'] or local['game_date'] != g.get('local_date')
                or not home or not away or home['team_id'] == away['team_id']
                or any(team_api_counts[t['api_team_id']] != 1 for t in (home, away))
                or any(not isinstance(g.get(side), dict) or type(g[side].get('api_team_id')) is not int
                       or g[side]['api_team_id'] <= 0 for side in ('home', 'away'))
                or g.get('home') != {'api_team_id': home['api_team_id'], 'name': home['team_name']}
                or g.get('away') != {'api_team_id': away['api_team_id'], 'name': away['team_name']}):
            skipped['fixture_precondition_mismatch'] += 1
            continue
        rows = g.get('rows')
        if not isinstance(rows, list) or len(rows) != 44 or any(not isinstance(r, dict) for r in rows):
            skipped['invalid_source_lineup'] += 1
            continue
        ids = [r.get('api_player_id') for r in rows]
        if (any(type(pid) is not int or pid <= 0 for pid in ids) or len(set(ids)) != 44
                or any(type(r.get('api_team_id')) is not int or r['api_team_id'] <= 0 for r in rows)
                or any(len(players_by_api.get(pid, [])) != 1 for pid in ids)
                or Counter(r.get('api_team_id') for r in rows) != Counter({home['api_team_id']:22, away['api_team_id']:22})):
            skipped['unresolved_source_identities'] += 1
            continue
        if any(any(type(r.get(field)) is not int or not 0 <= r[field] <= 1000 for field in VALID_STATS)
               or not any(r[field] > 0 for field in VALID_STATS)
               or r['disposals'] != r['kicks'] + r['handballs'] for r in rows):
            skipped['unverified_source_stats_or_participation'] += 1
            continue
        row = next((r for r in rows if r['api_player_id'] == target_api[0]), None)
        if row is None:
            continue
        team, opponent = (home, away) if row['api_team_id'] == home['api_team_id'] else (away, home)
        # Missing-season evidence must precede that season; future club records
        # cannot establish the player's club at the time of this appearance.
        prior_clubs = {club for year, clubs in historical.items()
                       if type(year) is int and year < g['season'] for club in clubs}
        known_clubs = historical.get(g['season'], prior_clubs)
        if known_clubs != {team['team_id']}:
            skipped['target_historical_club_unverified'] += 1
            continue
        added.append({'game_id':local['game_id'], 'season_year':g['season'], 'team_id':team['team_id'],
                      'opponent_team_id':opponent['team_id'], 'stat_value':row[stat],
                      **{f'observed_{field}':row[field] for field in VALID_STATS}})
        report['sources'].append({k:g[k] for k in ('api_game_id','source_url','retrieved_at','source_sha256')})
    report.update(rows_added=len(added), games_skipped=dict(skipped))
    return added, report
