#!/usr/bin/env python3
"""
Master orchestration script to collect all AFL data from 2011-2026.

This script:
1. Collects players for all seasons (using get_all_players_with_checkpoint.py logic)
2. Collects games for all seasons
3. Collects player statistics for all games

Features:
- Checkpoint support for resume capability
- Progress tracking and time estimates
- Safe to interrupt and resume

Usage:
    python scripts/collect_all_seasons.py [API_KEY]

Estimated time: ~11-12 hours with 7,500 requests/day limit
Estimated requests: ~3,433 total
"""

import sys
import os
import json
from datetime import datetime, timedelta
from typing import Optional, Dict, List, Set

# Add parent directory to path
_current_file = os.path.abspath(__file__)
_scripts_dir = os.path.dirname(_current_file)
_backend_dir = os.path.dirname(_scripts_dir)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from scrapers.api_client import APIClient
from database.db_manager_api import DatabaseManager

# Default paths
DEFAULT_DB_PATH = os.path.join(_backend_dir, "database", "afl_stats.db")
DB_PATH = os.getenv("DB_PATH", DEFAULT_DB_PATH)
MASTER_CHECKPOINT_FILE = os.path.join(_scripts_dir, "collect_all_checkpoint.json")

# Default API key (loaded via api_client.py dotenv import)
DEFAULT_API_KEY = os.getenv("AFL_API_KEY", "")

# All seasons to collect
# NOTE: Python range end is exclusive.
ALL_SEASONS = list(range(2011, 2027))  # 2011-2026


def load_checkpoint() -> Dict:
    """Load master checkpoint"""
    if os.path.exists(MASTER_CHECKPOINT_FILE):
        try:
            with open(MASTER_CHECKPOINT_FILE, 'r') as f:
                return json.load(f)
        except:
            pass
    return {
        'phase': 'players',  # 'players', 'games', 'stats', 'complete'
        'players_processed_combinations': [],  # [(team_id, season), ...]
        'games_processed_seasons': [],
        'stats_processed_games': [],
        'total_players': 0,
        'total_games': 0,
        'total_stats': 0,
        'api_requests': 0,
        'start_time': None,
        'last_updated': None
    }


def save_checkpoint(checkpoint: Dict):
    """Save master checkpoint"""
    checkpoint['last_updated'] = datetime.now().isoformat()
    with open(MASTER_CHECKPOINT_FILE, 'w') as f:
        json.dump(checkpoint, f, indent=2)


def get_team_id_by_api_id(db: DatabaseManager, api_team_id: int) -> Optional[int]:
    """Get database team_id from API team_id"""
    cur = db.conn.execute(
        "SELECT team_id FROM teams WHERE api_team_id = ?",
        (api_team_id,)
    )
    row = cur.fetchone()
    cur.close()
    return row['team_id'] if row else None


def get_player_id_by_api_id(db: DatabaseManager, api_player_id: int) -> Optional[int]:
    """Get database player_id from API player_id"""
    cur = db.conn.execute(
        "SELECT player_id FROM players WHERE api_player_id = ?",
        (api_player_id,)
    )
    row = cur.fetchone()
    cur.close()
    return row['player_id'] if row else None


def get_game_info_by_api_id(db: DatabaseManager, api_game_id: int) -> Optional[Dict]:
    """Get game details from API game_id"""
    cur = db.conn.execute(
        """SELECT game_id, home_team_id, away_team_id, venue_id, game_time 
           FROM games WHERE api_game_id = ?""",
        (api_game_id,)
    )
    row = cur.fetchone()
    cur.close()
    if row:
        return {
            'game_id': row['game_id'],
            'home_team_id': row['home_team_id'],
            'away_team_id': row['away_team_id'],
            'venue_id': row['venue_id'],
            'game_time': row['game_time']
        }
    return None


def determine_game_time_category(game_time: Optional[str]) -> str:
    """Determine game time category (Day/Twilight/Night)"""
    if not game_time:
        return "Day"
    try:
        hour = int(game_time.split(":")[0])
        if hour < 15:
            return "Day"
        elif hour < 18:
            return "Twilight"
        else:
            return "Night"
    except:
        return "Day"


def parse_game_type(round_text: str) -> str:
    """Parse game type from round text"""
    if "Regular Season" in round_text:
        return "Regular Season"
    elif "Finals" in round_text or "Final" in round_text:
        return "Finals"
    elif "Pre-Season" in round_text or "Pre Season" in round_text:
        return "Pre-Season"
    else:
        return "Regular Season"


def parse_date(iso_string: str):
    """Parse ISO date string to date and time"""
    try:
        dt = datetime.fromisoformat(iso_string.replace('Z', '+00:00'))
        return dt.date(), dt.time().strftime("%H:%M")
    except:
        date_part = iso_string.split('T')[0]
        time_part = iso_string.split('T')[1].split('+')[0] if 'T' in iso_string else None
        date_obj = datetime.strptime(date_part, '%Y-%m-%d').date()
        time_str = time_part[:5] if time_part else None
        return date_obj, time_str


def collect_players(api_client: APIClient, db: DatabaseManager, checkpoint: Dict, teams: List[Dict]) -> Dict:
    """Phase 1: Collect all players for all seasons"""
    print("\n" + "="*80)
    print("PHASE 1: COLLECTING PLAYERS")
    print("="*80 + "\n")
    
    processed = set(tuple(x) for x in checkpoint.get('players_processed_combinations', []))
    total_combinations = len(teams) * len(ALL_SEASONS)
    
    print(f"Total team/season combinations: {total_combinations}")
    print(f"Already processed: {len(processed)}")
    print(f"Remaining: {total_combinations - len(processed)}")
    print()
    
    all_players = {}
    
    # Load existing players from database
    cur = db.conn.execute(
        "SELECT api_player_id, player_name FROM players WHERE api_player_id IS NOT NULL"
    )
    for row in cur.fetchall():
        all_players[row['api_player_id']] = {"id": row['api_player_id'], "name": row['player_name']}
    cur.close()
    print(f"Loaded {len(all_players)} existing players from database\n")
    
    combo_count = 0
    for season in ALL_SEASONS:
        print(f"[Season {season}]")
        
        for team in teams:
            team_id = team["id"]
            team_name = team["name"]
            combo_count += 1
            
            if (team_id, season) in processed:
                continue
            
            try:
                players = api_client.get_players_for_team(team_id, season)
                checkpoint['api_requests'] = checkpoint.get('api_requests', 0) + 1
                
                new_count = 0
                for player in players:
                    api_id = player["id"]
                    if api_id not in all_players:
                        all_players[api_id] = {"id": api_id, "name": player["name"]}
                        # Insert into database
                        db.get_or_create_player(
                            player_name=player["name"],
                            api_player_id=api_id
                        )
                        new_count += 1
                
                checkpoint['players_processed_combinations'].append([team_id, season])
                checkpoint['total_players'] = len(all_players)
                save_checkpoint(checkpoint)
                
                print(f"  ✅ {team_name}: {len(players)} players ({new_count} new)")
                
            except Exception as e:
                print(f"  ❌ {team_name}: ERROR - {e}")
                continue
        
        print(f"  Season {season} complete. Total unique players: {len(all_players)}\n")
    
    print(f"\n✅ Player collection complete: {len(all_players)} total players")
    checkpoint['phase'] = 'games'
    save_checkpoint(checkpoint)
    
    return checkpoint


def collect_games(api_client: APIClient, db: DatabaseManager, checkpoint: Dict) -> Dict:
    """Phase 2: Collect all games for all seasons"""
    print("\n" + "="*80)
    print("PHASE 2: COLLECTING GAMES")
    print("="*80 + "\n")
    
    processed_seasons = set(checkpoint.get('games_processed_seasons', []))
    
    print(f"Total seasons: {len(ALL_SEASONS)}")
    print(f"Already processed: {len(processed_seasons)}")
    print(f"Remaining: {len(ALL_SEASONS) - len(processed_seasons)}")
    print()
    
    total_games = 0
    
    for season in ALL_SEASONS:
        if season in processed_seasons:
            print(f"[Season {season}] SKIPPED (already processed)")
            continue
        
        print(f"[Season {season}] Fetching games...")
        
        try:
            games = api_client.get_games_for_season(season, league=1)
            checkpoint['api_requests'] = checkpoint.get('api_requests', 0) + 1
            
            if not games:
                print(f"  ⚠️  No games returned for season {season}")
                checkpoint['games_processed_seasons'].append(season)
                save_checkpoint(checkpoint)
                continue
            
            inserted = 0
            for game_data in games:
                api_game_id = game_data.get("game", {}).get("id")
                if not api_game_id:
                    continue
                
                season_year = game_data.get("league", {}).get("season", season)
                round_text = game_data.get("round", "Regular Season")
                week = game_data.get("week")
                date_str = game_data.get("date")
                venue_name = game_data.get("venue")
                
                home_team_api_id = game_data.get("teams", {}).get("home", {}).get("id")
                away_team_api_id = game_data.get("teams", {}).get("away", {}).get("id")
                
                if not home_team_api_id or not away_team_api_id or not date_str:
                    continue
                
                game_type = parse_game_type(round_text)
                round_number = week if week and "Regular Season" in round_text else None
                game_date, game_time = parse_date(date_str)
                
                # Handle missing venue (common in older seasons)
                if venue_name:
                    venue_id = db.get_or_create_venue(venue_name)
                else:
                    venue_id = db.get_or_create_venue("Unknown")
                
                home_team_id = get_team_id_by_api_id(db, home_team_api_id)
                away_team_id = get_team_id_by_api_id(db, away_team_api_id)
                
                if not home_team_id or not away_team_id:
                    continue
                
                db.get_or_create_game(
                    api_game_id=api_game_id,
                    season_year=season_year,
                    round_number=round_number,
                    game_type=game_type,
                    game_date=game_date,
                    game_time=game_time,
                    venue_id=venue_id,
                    home_team_id=home_team_id,
                    away_team_id=away_team_id
                )
                inserted += 1
            
            total_games += inserted
            checkpoint['games_processed_seasons'].append(season)
            checkpoint['total_games'] = checkpoint.get('total_games', 0) + inserted
            save_checkpoint(checkpoint)
            
            print(f"  ✅ {len(games)} games found, {inserted} inserted/updated")
            
        except Exception as e:
            print(f"  ❌ ERROR: {e}")
            continue
    
    print(f"\n✅ Game collection complete: {checkpoint.get('total_games', 0)} total games")
    checkpoint['phase'] = 'stats'
    save_checkpoint(checkpoint)
    
    return checkpoint


def collect_stats(api_client: APIClient, db: DatabaseManager, checkpoint: Dict) -> Dict:
    """Phase 3: Collect player statistics for all games"""
    print("\n" + "="*80)
    print("PHASE 3: COLLECTING PLAYER STATISTICS")
    print("="*80 + "\n")
    
    processed_games = set(checkpoint.get('stats_processed_games', []))
    
    # Get all games with api_game_id
    cur = db.conn.execute(
        "SELECT api_game_id FROM games WHERE api_game_id IS NOT NULL ORDER BY season_year, game_date"
    )
    all_games = [row['api_game_id'] for row in cur.fetchall()]
    cur.close()
    
    print(f"Total games in database: {len(all_games)}")
    print(f"Already processed: {len(processed_games)}")
    print(f"Remaining: {len(all_games) - len(processed_games)}")
    print()
    
    total_stats = 0
    
    for idx, api_game_id in enumerate(all_games, 1):
        if api_game_id in processed_games:
            continue
        
        game_info = get_game_info_by_api_id(db, api_game_id)
        if not game_info:
            continue
        
        try:
            stats_data = api_client.get_game_statistics(api_game_id)
            checkpoint['api_requests'] = checkpoint.get('api_requests', 0) + 1
            
            stats_count = 0
            
            if stats_data and isinstance(stats_data, list) and len(stats_data) > 0:
                game_stats = stats_data[0]
                teams_data = game_stats.get("teams", [])
                
                game_id = game_info['game_id']
                home_team_id = game_info['home_team_id']
                away_team_id = game_info['away_team_id']
                venue_id = game_info['venue_id']
                game_time_category = determine_game_time_category(game_info['game_time'])
                
                for team_data in teams_data:
                    api_team_id = team_data.get("team", {}).get("id")
                    if not api_team_id:
                        continue
                    
                    team_id = get_team_id_by_api_id(db, api_team_id)
                    if not team_id:
                        continue
                    
                    if team_id == home_team_id:
                        opponent_team_id = away_team_id
                        location = "Home"
                    elif team_id == away_team_id:
                        opponent_team_id = home_team_id
                        location = "Away"
                    else:
                        continue
                    
                    for player_stat in team_data.get("players", []):
                        api_player_id = player_stat.get("player", {}).get("id")
                        if not api_player_id:
                            continue
                        
                        player_id = get_player_id_by_api_id(db, api_player_id)
                        if not player_id:
                            continue
                        
                        disposals = player_stat.get("disposals", 0) or 0
                        goals_data = player_stat.get("goals", {})
                        goals = goals_data.get("total", 0) if isinstance(goals_data, dict) else (goals_data or 0)
                        
                        # Check if stats already exist
                        cur = db.conn.execute(
                            "SELECT stat_id FROM player_game_stats WHERE player_id = ? AND game_id = ?",
                            (player_id, game_id)
                        )
                        existing = cur.fetchone()
                        cur.close()
                        
                        if existing:
                            db.conn.execute(
                                """UPDATE player_game_stats 
                                   SET disposals = ?, goals = ?, team_id = ?, opponent_team_id = ?,
                                       venue_id = ?, location = ?, game_time = ?
                                   WHERE stat_id = ?""",
                                (disposals, goals, team_id, opponent_team_id, venue_id, location, 
                                 game_time_category, existing['stat_id'])
                            )
                        else:
                            db.insert_player_stats(
                                player_id=player_id,
                                game_id=game_id,
                                team_id=team_id,
                                opponent_team_id=opponent_team_id,
                                venue_id=venue_id,
                                location=location,
                                game_time=game_time_category,
                                disposals=disposals,
                                goals=goals
                            )
                        stats_count += 1
                
                db.conn.commit()
            
            checkpoint['stats_processed_games'].append(api_game_id)
            checkpoint['total_stats'] = checkpoint.get('total_stats', 0) + stats_count
            total_stats += stats_count
            
            # Save checkpoint every 10 games
            if idx % 10 == 0:
                save_checkpoint(checkpoint)
                print(f"  [{idx}/{len(all_games)}] Processed {len(checkpoint['stats_processed_games'])} games, "
                      f"{checkpoint['total_stats']} total stats, "
                      f"{checkpoint['api_requests']} API requests")
            
        except Exception as e:
            print(f"  ❌ Game {api_game_id}: ERROR - {e}")
            save_checkpoint(checkpoint)
            continue
    
    save_checkpoint(checkpoint)
    print(f"\n✅ Stats collection complete: {checkpoint.get('total_stats', 0)} total player stats")
    checkpoint['phase'] = 'complete'
    save_checkpoint(checkpoint)
    
    return checkpoint


def main():
    """Main orchestration function"""
    api_key = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_API_KEY
    
    print("="*80)
    print("AFL DATA COLLECTION - ALL SEASONS (2011-2025)")
    print("="*80)
    print(f"Database: {DB_PATH}")
    print(f"API Key: {api_key[:10]}...{api_key[-4:]}")
    print(f"Seasons: {ALL_SEASONS[0]} to {ALL_SEASONS[-1]} ({len(ALL_SEASONS)} seasons)")
    print()
    
    # Load checkpoint
    checkpoint = load_checkpoint()
    
    if checkpoint.get('phase') == 'complete':
        print("✅ Collection already complete!")
        print(f"   Total players: {checkpoint.get('total_players', 0)}")
        print(f"   Total games: {checkpoint.get('total_games', 0)}")
        print(f"   Total stats: {checkpoint.get('total_stats', 0)}")
        print(f"   API requests: {checkpoint.get('api_requests', 0)}")
        print()
        print("To restart, delete the checkpoint file:")
        print(f"   {MASTER_CHECKPOINT_FILE}")
        return
    
    if checkpoint.get('start_time'):
        print(f"📂 Resuming from checkpoint")
        print(f"   Phase: {checkpoint.get('phase', 'players')}")
        print(f"   API requests so far: {checkpoint.get('api_requests', 0)}")
        print(f"   Last updated: {checkpoint.get('last_updated', 'unknown')}")
    else:
        print("🆕 Starting fresh collection")
        checkpoint['start_time'] = datetime.now().isoformat()
        save_checkpoint(checkpoint)
    
    print()
    
    # Initialize clients
    api_client = APIClient(api_key)
    db = DatabaseManager(DB_PATH)
    
    try:
        # Get teams first (needed for all phases)
        print("Fetching teams...")
        teams = api_client.get_teams()
        checkpoint['api_requests'] = checkpoint.get('api_requests', 0) + 1
        
        if not teams:
            print("❌ Failed to fetch teams. Check API key.")
            return
        
        print(f"✅ Found {len(teams)} teams\n")
        
        # Phase 1: Players
        if checkpoint.get('phase', 'players') == 'players':
            checkpoint = collect_players(api_client, db, checkpoint, teams)
        
        # Phase 2: Games
        if checkpoint.get('phase') == 'games':
            checkpoint = collect_games(api_client, db, checkpoint)
        
        # Phase 3: Stats
        if checkpoint.get('phase') == 'stats':
            checkpoint = collect_stats(api_client, db, checkpoint)
        
        # Summary
        print("\n" + "="*80)
        print("COLLECTION COMPLETE!")
        print("="*80)
        print(f"Total players: {checkpoint.get('total_players', 0)}")
        print(f"Total games: {checkpoint.get('total_games', 0)}")
        print(f"Total player stats: {checkpoint.get('total_stats', 0)}")
        print(f"API requests: {checkpoint.get('api_requests', 0)}")
        
        if checkpoint.get('start_time'):
            start = datetime.fromisoformat(checkpoint['start_time'])
            elapsed = datetime.now() - start
            print(f"Total time: {elapsed}")
        
        print()
        print("✅ All data collected successfully!")
        
    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
        print("💡 Checkpoint saved. Run again to resume.")
        save_checkpoint(checkpoint)
    except Exception as e:
        print(f"\n\n❌ Error: {e}")
        print("💡 Checkpoint saved. Run again to resume.")
        save_checkpoint(checkpoint)
        raise
    finally:
        db.conn.close()


if __name__ == "__main__":
    main()

