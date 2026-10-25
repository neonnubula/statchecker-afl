#!/usr/bin/env python3
"""
Get player statistics for all games in a season.

This script:
1. Gets all games for a season from database
2. For each game, gets player statistics from API
3. Inserts stats into database
4. Tracks progress with checkpoint support

Usage:
    python scripts/get_stats_for_season.py [SEASON] [API_KEY]
    
Example:
    python scripts/get_stats_for_season.py 2023
"""

import sys
import os
import json
from datetime import datetime

# Add parent directory to path
_current_file = os.path.abspath(__file__)
_scripts_dir = os.path.dirname(_current_file)
_backend_dir = os.path.dirname(_scripts_dir)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from scrapers.api_client import APIClient
from database.db_manager_api import DatabaseManager
# Import helper functions (defined locally to avoid circular imports)
def get_game_id_by_api_id(db: DatabaseManager, api_game_id: int):
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


def get_player_id_by_api_id(db: DatabaseManager, api_player_id: int):
    """Get database player_id from API player_id (honours alias table)."""
    cur = db.conn.execute(
        "SELECT player_id FROM players WHERE api_player_id = ?",
        (api_player_id,)
    )
    row = cur.fetchone()
    cur.close()
    if row:
        return row['player_id']
    # Fall through to alias table (may not exist on older DBs)
    return db._lookup_alias(api_player_id)


def get_team_id_by_api_id(db: DatabaseManager, api_team_id: int):
    """Get database team_id from API team_id"""
    cur = db.conn.execute(
        "SELECT team_id FROM teams WHERE api_team_id = ?",
        (api_team_id,)
    )
    row = cur.fetchone()
    cur.close()
    return row['team_id'] if row else None


def determine_game_time_category(game_time):
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

# Default paths
DEFAULT_DB_PATH = os.path.join(_backend_dir, "database", "afl_stats.db")
DB_PATH = os.getenv("DB_PATH", DEFAULT_DB_PATH)
CHECKPOINT_FILE_TEMPLATE = os.path.join(_scripts_dir, "get_stats_season_{}_checkpoint.json")

# Default API key
DEFAULT_API_KEY = os.getenv("AFL_API_KEY", "")


def load_checkpoint(season: int):
    """Load checkpoint if it exists"""
    checkpoint_file = CHECKPOINT_FILE_TEMPLATE.format(season)
    if os.path.exists(checkpoint_file):
        try:
            with open(checkpoint_file, 'r') as f:
                return json.load(f)
        except:
            return None
    return None


def save_checkpoint(season: int, checkpoint_data):
    """Save checkpoint"""
    checkpoint_file = CHECKPOINT_FILE_TEMPLATE.format(season)
    checkpoint_data['last_updated'] = datetime.now().isoformat()
    checkpoint_data['season'] = season
    with open(checkpoint_file, 'w') as f:
        json.dump(checkpoint_data, f, indent=2)


def get_processed_games(checkpoint):
    """Get set of processed api_game_ids"""
    if not checkpoint:
        return set()
    return set(checkpoint.get('processed_games', []))


def add_processed_game(checkpoint, api_game_id, stats_count):
    """Add a processed game to checkpoint"""
    if not checkpoint:
        checkpoint = {
            'season': None,
            'processed_games': [],
            'total_stats': 0,
            'api_requests': 0
        }
    
    if api_game_id not in checkpoint['processed_games']:
        checkpoint['processed_games'].append(api_game_id)
        checkpoint['total_stats'] = checkpoint.get('total_stats', 0) + stats_count
        checkpoint['api_requests'] = checkpoint.get('api_requests', 0) + 1
    
    return checkpoint


def process_game_stats(api_client, db, api_game_id, game_info):
    """Process statistics for a single game"""
    
    # Get game statistics from API
    stats_data = api_client.get_game_statistics(api_game_id)
    
    if not stats_data:
        return None
    
    if not isinstance(stats_data, list) or len(stats_data) == 0:
        return None
    
    game_stats = stats_data[0]
    teams_data = game_stats.get("teams", [])
    
    if len(teams_data) != 2:
        return None
    
    # Process statistics
    inserted_count = 0
    updated_count = 0
    
    game_id = game_info['game_id']
    home_team_id = game_info['home_team_id']
    away_team_id = game_info['away_team_id']
    venue_id = game_info['venue_id']
    game_time_str = game_info['game_time']
    game_time_category = determine_game_time_category(game_time_str)
    
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
        
        players = team_data.get("players", [])
        
        for player_stat in players:
            try:
                api_player_id = player_stat.get("player", {}).get("id")
                if not api_player_id:
                    continue
                
                player_id = get_player_id_by_api_id(db, api_player_id)
                if not player_id:
                    # New player not yet in DB — fetch their name and auto-create
                    player_info = api_client.get_player_by_id(api_player_id)
                    if player_info:
                        player_name = player_info["name"]
                    else:
                        player_name = f"Unknown_{api_player_id}"
                    player_id = db.get_or_create_player(
                        player_name=player_name,
                        api_player_id=api_player_id,
                        team_id=team_id,
                    )
                    print(f"      + Resolved player: {player_name} (api_id={api_player_id}, pid={player_id})")
                if not player_id:
                    continue
                
                disposals = player_stat.get("disposals", 0) or 0
                goals_data = player_stat.get("goals", {})
                goals = goals_data.get("total", 0) if isinstance(goals_data, dict) else (goals_data or 0)
                marks = player_stat.get("marks", 0) or 0
                tackles = player_stat.get("tackles", 0) or 0

                kicks      = player_stat.get("kicks", 0) or 0
                handballs  = player_stat.get("handballs", 0) or 0
                hitouts    = player_stat.get("hitouts", 0) or 0
                clearances = player_stat.get("clearances", 0) or 0
                behinds    = player_stat.get("behinds", 0) or 0

                if disposals + goals + marks + tackles + kicks + handballs + hitouts + clearances + behinds == 0:
                    print(f"      ⏭️  Skipping api_player_id={api_player_id} - emergency/DNP (all stats zero)")
                    continue

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
                           SET disposals = ?, goals = ?, marks = ?, tackles = ?,
                               kicks = ?, handballs = ?, clearances = ?, hit_outs = ?,
                               team_id = ?, opponent_team_id = ?,
                               venue_id = ?, location = ?, game_time = ?
                           WHERE stat_id = ?""",
                        (disposals, goals, marks, tackles,
                         kicks, handballs, clearances, hitouts,
                         team_id, opponent_team_id,
                         venue_id, location, game_time_category, existing['stat_id'])
                    )
                    db.conn.commit()
                    updated_count += 1
                else:
                    stat_id = db.insert_player_stats(
                        player_id=player_id,
                        game_id=game_id,
                        team_id=team_id,
                        opponent_team_id=opponent_team_id,
                        venue_id=venue_id,
                        location=location,
                        game_time=game_time_category,
                        disposals=disposals,
                        goals=goals,
                        marks=marks,
                        tackles=tackles,
                        kicks=kicks,
                        handballs=handballs,
                        clearances=clearances,
                        hit_outs=hitouts,
                    )
                    inserted_count += 1
                    
            except Exception as e:
                import traceback
                print(f"      ⚠️  Error processing player {api_player_id}: {e}")
                traceback.print_exc()
                continue
    
    return inserted_count + updated_count


def main():
    """Main function to get stats for all games in a season"""
    # Parse arguments
    if len(sys.argv) > 1:
        season = int(sys.argv[1])
    else:
        season = 2023
    
    api_key = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_API_KEY
    
    print("="*80)
    print(f"GET GAME STATISTICS FOR SEASON {season}")
    print("="*80)
    print(f"Database: {DB_PATH}")
    print(f"API Key: {api_key[:10]}...{api_key[-4:]}")
    print()
    
    # Load checkpoint
    checkpoint = load_checkpoint(season)
    if checkpoint:
        print(f"📂 Resuming from checkpoint (last updated: {checkpoint.get('last_updated', 'unknown')})")
        print(f"   Already processed: {len(checkpoint.get('processed_games', []))} games")
        print(f"   Total stats inserted: {checkpoint.get('total_stats', 0)}")
        print(f"   API requests made: {checkpoint.get('api_requests', 0)}")
        print()
    else:
        print("🆕 Starting fresh (no checkpoint found)")
        print()
        checkpoint = {
            'season': season,
            'processed_games': [],
            'total_stats': 0,
            'api_requests': 0
        }
    
    # Initialize clients
    api_client = APIClient(api_key)
    db = DatabaseManager(DB_PATH)
    
    try:
        # Step 1: Get all games for season from database
        print(f"Step 1: Getting games for season {season} from database...")
        cur = db.conn.execute(
            "SELECT api_game_id FROM games WHERE season_year = ? AND api_game_id IS NOT NULL ORDER BY game_date",
            (season,)
        )
        games = cur.fetchall()
        cur.close()
        
        if not games:
            print(f"❌ No games found for season {season} in database.")
            print("💡 Run get_games_for_season.py first to add games.")
            return
        
        print(f"✅ Found {len(games)} games")
        print()
        
        # Step 2: Process each game
        print("Step 2: Processing game statistics...")
        print("="*80)
        
        processed = get_processed_games(checkpoint)
        total_games = len(games)
        remaining = total_games - len(processed)
        
        print(f"Total games: {total_games}")
        print(f"Already processed: {len(processed)}")
        print(f"Remaining: {remaining}")
        print()
        
        inserted_total = 0
        updated_total = 0
        error_count = 0
        
        for idx, game_row in enumerate(games, 1):
            api_game_id = game_row['api_game_id']
            
            # Check if already processed
            if api_game_id in processed:
                print(f"  ⏭️  [{idx}/{total_games}] Game {api_game_id} - SKIPPED (already processed)")
                continue
            
            # Get game info
            game_info = get_game_id_by_api_id(db, api_game_id)
            if not game_info:
                print(f"  ⚠️  [{idx}/{total_games}] Game {api_game_id} - SKIPPED (not in database)")
                error_count += 1
                continue
            
            # Process game statistics
            try:
                stats_count = process_game_stats(api_client, db, api_game_id, game_info)
                
                if stats_count:
                    checkpoint = add_processed_game(checkpoint, api_game_id, stats_count)
                    save_checkpoint(season, checkpoint)
                    inserted_total += stats_count
                    print(f"  ✅ [{idx}/{total_games}] Game {api_game_id} - {stats_count} stats processed")
                else:
                    print(f"  ⚠️  [{idx}/{total_games}] Game {api_game_id} - No stats available")
                    checkpoint = add_processed_game(checkpoint, api_game_id, 0)
                    save_checkpoint(season, checkpoint)
                    
            except Exception as e:
                error_count += 1
                print(f"  ❌ [{idx}/{total_games}] Game {api_game_id} - ERROR: {e}")
                # Don't mark as processed if error
                continue
            
            # Show progress every 10 games
            if idx % 10 == 0:
                print(f"  Progress: {idx}/{total_games} games processed ({len(checkpoint['processed_games'])} total)")
        
        print()
        print("="*80)
        print("SUMMARY")
        print("="*80)
        print(f"Season: {season}")
        print(f"Games processed: {len(checkpoint['processed_games'])}")
        print(f"Total stats records: {checkpoint['total_stats']}")
        print(f"API requests made: {checkpoint['api_requests']}")
        if error_count > 0:
            print(f"Errors: {error_count}")
        print()
        print("✅ Complete!")
        print()
        print(f"💡 Checkpoint saved. To clear and start fresh, delete:")
        print(f"   {CHECKPOINT_FILE_TEMPLATE.format(season)}")
        
    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
        print("💡 Checkpoint saved. Run again to resume.")
        save_checkpoint(season, checkpoint)
    except Exception as e:
        print(f"\n\n❌ Error: {e}")
        print("💡 Checkpoint saved. Run again to resume.")
        save_checkpoint(season, checkpoint)
        raise
    finally:
        db.conn.close()


if __name__ == "__main__":
    main()

