"""Build a small, source-stamped schedule sidecar; never modify player databases."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.afl_context import build_context


def build_history(envelopes, venues):
    seasons, seen = [], set()
    for envelope in envelopes:
        context = build_context(envelope, venues)
        season = context['games'][0]['season']
        if season in seen:
            raise ValueError('Duplicate season')
        seen.add(season)
        games = []
        for game in context['games']:
            if game['state'] != 'final':
                continue
            games.append({
                'source_game_id': game['game_id'], 'season': season, 'round': game['round'],
                'starts_at': game['starts_at'], 'local_date': game['source_local_time'][:10],
                'home': game['home_team'], 'away': game['away_team'], 'venue': game['venue'],
                'game_type': 'Finals' if game['is_final'] else 'Regular Season',
                'teams': {name: {field: game['teams'][tid][field] for field in
                                ('start_gap_hours', 'venue_distance_km')}
                          for tid, name in ((game['home_team_id'], game['home_team']),
                                            (game['away_team_id'], game['away_team']))},
            })
        seasons.append({'season': season, 'source_url': context['source_url'],
                        'retrieved_at': context['retrieved_at'], 'source_sha256': envelope['sha256'],
                        'games': games})
    return {'schema_version': 1, 'source': 'squiggle',
            'venue_registry_sha256': hashlib.sha256(json.dumps(venues, sort_keys=True).encode()).hexdigest(),
            'coordinate_attribution': '© OpenStreetMap contributors',
            'coordinate_license': 'ODbL-1.0',
            'coordinate_license_url': 'https://opendatacommons.org/licenses/odbl/1-0/',
            'seasons': sorted(seasons, key=lambda x: x['season'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', action='append', type=Path, required=True)
    parser.add_argument('--venues', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or str(args.output.resolve()).startswith('/mnt/'):
        parser.error('Choose a new sidecar path outside the production volume')
    result = build_history([json.loads(p.read_text()) for p in args.snapshot], json.loads(args.venues.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(',', ':')) + '\n')
    print(json.dumps({'seasons': [s['season'] for s in result['seasons']],
                      'games': sum(len(s['games']) for s in result['seasons']), 'bytes': args.output.stat().st_size}))
