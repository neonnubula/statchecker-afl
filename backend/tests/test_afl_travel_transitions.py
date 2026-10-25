from copy import deepcopy
from datetime import datetime, timezone

import pytest

from app.afl_player_context import attach_upcoming, designated_transitions
from app.afl_player_impact import calculate_player_impact


def row(gid, value, direction='home_to_away', distance=1500, season=2026, phase='Regular Season', **extra):
    return dict(game_id=gid, season_year=season, game_type=phase, stat_value=value,
                context={'travel_transition': direction, 'venue_distance_km': distance}, **extra)


def calc(rows):
    return calculate_player_impact(rows, stat='disposals')


def band(result, direction='home_to_away', key='1000_to_2000km'):
    transition = next(t for t in result['travel']['transitions'] if t['key'] == direction)
    return next(b for b in transition['buckets'] if b['key'] == key)


def test_baseline_matches_direction_season_and_phase_before_weighting():
    result = band(calc([row(1, 20), row(2, 10, distance=500),
                       row(3, 999, direction='away_to_home', distance=500),
                       row(4, 100, season=2025), row(5, 80, season=2025, distance=500),
                       row(6, 40, phase='Finals'), row(7, 35, phase='Finals', distance=500)]))
    assert result['target_games'] == result['baseline_games'] == 3
    assert result['delta'] == pytest.approx(35 / 3)
    assert result['small_sample'] and result['included_strata'] == 3


def test_other_direction_cannot_supply_missing_baseline():
    result = band(calc([row(1, 20), row(2, 5, direction='away_to_home', distance=500)]))
    assert not result['available'] and result['excluded_target_games'] == 1
    assert result['strata'][0]['reason'] == 'no_baseline_games'


def test_short_ground_changes_do_not_share_neale_distance_band():
    result = calc([row(1, 30, direction='away_to_home', distance=733),
                   row(2, 20, direction='away_to_home', distance=66),
                   row(3, 24, direction='away_to_home', distance=442),
                   row(4, 999, direction='home_to_away', distance=733)])
    comparison = band(result, 'away_to_home', '500_to_1000km')
    assert comparison['target_games'] == 1 and comparison['target_mean'] == 30
    assert comparison['baseline_games'] == 2 and comparison['baseline_mean'] == 22
    assert comparison['delta'] == 8 and comparison['small_sample']


def test_long_travel_separates_two_thousand_from_three_thousand_kilometres():
    result = calc([row(1, 20, distance=2128), row(2, 30, distance=3290)])
    assert band(result, key='2000_to_3000km')['target_mean'] == 20
    assert band(result, key='3000km_plus')['target_mean'] == 30


def test_unknown_direction_excluded_but_home_to_home_zero_distance_is_real():
    result = calc([row(1, 0, direction='home_to_home', distance=0),
                   row(2, 10, direction='home_to_home'), row(3, 999, direction=None),
                   row(4, 999, direction='interstate')])
    coverage = result['travel']['transition_coverage']
    assert coverage['matched_context_rows'] == 2
    assert coverage['missing_context_rows'] == coverage['invalid_context_rows'] == 1
    b = band(result, 'home_to_home', 'under_50km')
    assert b['target_mean'] == 0 and b['baseline_mean'] == 10


def test_sensitivity_applies_to_direction_buckets_without_changing_primary():
    b = band(calc([row(1, 0, participation_unverified=True), row(2, 20), row(3, 10, distance=500)]))
    assert b['target_mean'] == 10 and b['target_games'] == 2
    assert b['without_unverified_participation']['target_mean'] == 20
    assert b['strata'][0]['without_unverified_participation']['target_games'] == 1


def fixture(gid, day, *, home='Brisbane Lions', away='Adelaide', season=2026, live=False, state='final'):
    game = {'source_game_id': f'squiggle:{gid}', 'season': season, 'home': home, 'away': away,
            'starts_at': f'{season}-09-{day:02d}T09:00:00+00:00', 'venue': 'Neutral Ground'}
    if live:
        game.update(game_id=game.pop('source_game_id'), home_team=game.pop('home'), away_team=game.pop('away'),
                    home_team_id='squiggle:2' if home == 'Brisbane Lions' else 'squiggle:1',
                    away_team_id='squiggle:2' if away == 'Brisbane Lions' else 'squiggle:1',
                    state=state, schedule_verified=True,
                    teams={'squiggle:2': {'start_gap_hours': 168, 'venue_distance_km': 0}})
    return game


@pytest.mark.parametrize('prior,current,expected', [
    (True, False, 'home_to_away'), (False, True, 'away_to_home'),
    (False, False, 'away_to_away'), (True, True, 'home_to_home')])
def test_designations_use_ordered_clubs_even_at_same_neutral_ground(prior, current, expected):
    def game(gid, day, home):
        return fixture(gid, day, home='Brisbane Lions' if home else 'Adelaide',
                       away='Adelaide' if home else 'Brisbane Lions')
    result = designated_transitions([game(2, 8, current), game(1, 1, prior)])
    assert result[('squiggle:2', 'Brisbane Lions')]['travel_transition'] == expected


def test_previous_season_and_duplicate_clocks_do_not_create_transition():
    games = [fixture(9, 28, season=2025), fixture(1, 1), fixture(2, 8),
             fixture(3, 8, away='Sydney'), fixture(4, 15)]
    result = designated_transitions(games)
    assert all(result[(f'squiggle:{gid}', 'Brisbane Lions')]['travel_transition'] is None for gid in (1, 2, 4))


def test_upcoming_automatic_direction_and_band_use_previous_final():
    context = {'status': 'ready', 'stale': False, 'retrieved_at': '2026-09-02T00:00:00Z',
               'games': [fixture(2, 8, home='Adelaide', away='Brisbane Lions', live=True, state='scheduled'),
                         fixture(1, 1, live=True)]}
    original = deepcopy(context)
    result = attach_upcoming(calc([]), 'Brisbane Lions', context, now=datetime(2026, 9, 2, tzinfo=timezone.utc))['upcoming']
    assert result['travel_transition'] == 'home_to_away'
    assert result['rest_bucket'] == '168_to_192h' and result['travel_bucket'] == 'under_50km'
    assert result['previous_designation'] == 'home' and result['current_designation'] == 'away'
    assert 'player_selected' not in result and context == original


def test_unfinished_previous_fixture_does_not_get_skipped():
    context = {'status': 'ready', 'stale': False, 'retrieved_at': '2026-09-04T00:00:00Z',
               'games': [fixture(1, 1, live=True), fixture(2, 3, live=True, state='in_progress'),
                         fixture(3, 8, live=True, state='scheduled')]}
    result = attach_upcoming(calc([]), 'Brisbane Lions', context, now=datetime(2026, 9, 4, tzinfo=timezone.utc))['upcoming']
    assert result['available'] and result['travel_transition'] is None
