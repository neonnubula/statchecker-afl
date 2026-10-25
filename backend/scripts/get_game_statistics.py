#!/usr/bin/env python3
"""
Get player statistics for a game and insert into database.

This script:
1. Gets player statistics for a specific game (by api_game_id)
2. Maps players by API ID
3. Determines home/away location
4. Inserts player game stats

Usage:
    python scripts/get_game_statistics.py [API_GAME_ID] [API_KEY]
    
Example:
    python scripts/get_game_statistics.py 2524
"""

import sys
import os
from typing import Optional

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

# Default API key (loaded via api_client.py dotenv import)
DEFAULT_API_KEY = os.getenv("AFL_API_KEY", "")


def get_player_id_by_api_id(db: DatabaseManager, api_player_id: int) -> Optional[int]:
    """Get database player_id from API player_id"""
    cur = db.conn.execute(
        "SELECT player_id FROM players WHERE api_player_id = ?",
        (api_player_id,)
    )
    row = cur.fetchone()
    cur.close()
    return row['player_id'] if row else None


def get_game_id_by_api_id(db: DatabaseManager, api_game_id: int) -> Optional[dict]:
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


def get_team_id_by_api_id(db: DatabaseManager, api_team_id: int) -> Optional[int]:
    """Get database team_id from API team_id"""
    cur = db.conn.execute(
        "SELECT team_id FROM teams WHERE api_team_id = ?",
        (api_team_id,)
    )
    row = cur.fetchone()
    cur.close()
    return row['team_id'] if row else None


def determine_game_time_category(game_time: Optional[str]) -> str:
    """Determine game time category (Day/Twilight/Night)"""
    if not game_time:
        return "Day"  # Default
    
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


def main():
    """Main function to get game statistics"""
    # Parse arguments
    if len(sys.argv) > 1:
        api_game_id = int(sys.argv[1])
    else:
        print("Usage: python scripts/get_game_statistics.py [API_GAME_ID] [API_KEY]")
        print("Example: python scripts/get_game_statistics.py 2524")
        return
    
    api_key = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_API_KEY
    
    print("="*80)
    print(f"GET GAME STATISTICS FOR GAME {api_game_id}")
    print("="*80)
    print(f"Database: {DB_PATH}")
    print(f"API Key: {api_key[:10]}...{api_key[-4:]}")
    print()
    
    # Initialize clients
    api_client = APIClient(api_key)
    db = DatabaseManager(DB_PATH)
    
    try:
        # Step 1: Check if game exists in database
        print(f"Step 1: Checking if game {api_game_id} exists in database...")
        game_info = get_game_id_by_api_id(db, api_game_id)
        
        if not game_info:
            print(f"❌ Game {api_game_id} not found in database.")
            print("💡 Run get_games_for_season.py first to add games to database.")
            return
        
        print(f"✅ Game found: game_id={game_info['game_id']}")
        print(f"   Home team: {game_info['home_team_id']}, Away team: {game_info['away_team_id']}")
        print()
        
        # Step 2: Get game statistics from API
        print(f"Step 2: Getting game statistics from API...")
        stats_data = api_client.get_game_statistics(api_game_id)
        
        if not stats_data:
            print("❌ Failed to get game statistics. Check API key and rate limits.")
            return
        
        # Response structure: stats_data is a list, first item has the game data
        if not isinstance(stats_data, list) or len(stats_data) == 0:
            print("❌ Invalid response from API")
            return
        
        game_stats = stats_data[0]  # First (and only) game in response
        teams_data = game_stats.get("teams", [])
        
        if len(teams_data) != 2:
            print(f"⚠️  Expected 2 teams, got {len(teams_data)}")
            return
        
        print(f"✅ Found statistics for {len(teams_data)} teams")
        print()
        
        # Step 3: Process and insert player statistics
        print("Step 3: Processing and inserting player statistics...")
        print("="*80)
        
        inserted_count = 0
        updated_count = 0
        skipped_count = 0
        error_count = 0
        
        game_id = game_info['game_id']
        home_team_id = game_info['home_team_id']
        away_team_id = game_info['away_team_id']
        venue_id = game_info['venue_id']
        game_time_str = game_info['game_time']
        game_time_category = determine_game_time_category(game_time_str)
        
        # Process each team
        for team_data in teams_data:
            api_team_id = team_data.get("team", {}).get("id")
            if not api_team_id:
                continue
            
            # Get database team_id
            team_id = get_team_id_by_api_id(db, api_team_id)
            if not team_id:
                print(f"  ⚠️  Team {api_team_id} not found in database")
                continue
            
            # Determine opponent and location
            if team_id == home_team_id:
                opponent_team_id = away_team_id
                location = "Home"
            elif team_id == away_team_id:
                opponent_team_id = home_team_id
                location = "Away"
            else:
                print(f"  ⚠️  Team {team_id} not in this game")
                continue
            
            players = team_data.get("players", [])
            print(f"  Processing {len(players)} players for team {team_id} ({location})...")
            
            # Process each player
            for player_stat in players:
                try:
                    api_player_id = player_stat.get("player", {}).get("id")
                    if not api_player_id:
                        skipped_count += 1
                        continue
                    
                    # Get database player_id
                    player_id = get_player_id_by_api_id(db, api_player_id)
                    if not player_id:
                        # Player not in database - skip for now
                        skipped_count += 1
                        continue
                    
                    # Extract statistics
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
                        # Update existing stats
                        db.conn.execute(
                            """UPDATE player_game_stats 
                               SET disposals = ?, goals = ?, team_id = ?, opponent_team_id = ?,
                                   venue_id = ?, location = ?, game_time = ?
                               WHERE stat_id = ?""",
                            (disposals, goals, team_id, opponent_team_id, venue_id, location, 
                             game_time_category, existing['stat_id'])
                        )
                        db.conn.commit()
                        updated_count += 1
                    else:
                        # Insert new stats
                        stat_id = db.insert_player_stats(
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
                        inserted_count += 1
                    
                except Exception as e:
                    error_count += 1
                    print(f"    ❌ Error processing player {api_player_id}: {e}")
                    continue
        
        print()
        print("="*80)
        print("SUMMARY")
        print("="*80)
        print(f"Game ID: {api_game_id} (DB game_id: {game_id})")
        print(f"Stats inserted: {inserted_count}")
        print(f"Stats updated: {updated_count}")
        print(f"Players skipped: {skipped_count} (not in database)")
        if error_count > 0:
            print(f"Errors: {error_count}")
        print()
        print("✅ Complete!")
        
    finally:
        db.conn.close()


if __name__ == "__main__":
    main()

