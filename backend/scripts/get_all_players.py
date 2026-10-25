#!/usr/bin/env python3
"""
Simple script to get all players and their IDs across all seasons.

This script:
1. Gets all available seasons
2. For each season, gets players for each team
3. Collects unique players by API ID
4. Inserts into database

Usage:
    python scripts/get_all_players.py [API_KEY]
    
Note: This will make ~272 API requests (1 for seasons + 1 for teams + ~270 for players)
      On free plan (100 requests/day), this will take ~3 days
"""

import sys
import os

# Add parent directory to path
_current_file = os.path.abspath(__file__)
_scripts_dir = os.path.dirname(_current_file)
_backend_dir = os.path.dirname(_scripts_dir)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from scrapers.api_client import APIClient
from database.db_manager_api import DatabaseManager

# Default database path
DEFAULT_DB_PATH = os.path.join(_backend_dir, "database", "afl_stats.db")
DB_PATH = os.getenv("DB_PATH", DEFAULT_DB_PATH)

# Default API key (loaded via api_client.py dotenv import)
DEFAULT_API_KEY = os.getenv("AFL_API_KEY", "")


def main():
    """Main function to get all players"""
    # Get API key
    api_key = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_API_KEY
    
    print("="*80)
    print("GET ALL PLAYERS AND IDs (ALL SEASONS)")
    print("="*80)
    print(f"Database: {DB_PATH}")
    print(f"API Key: {api_key[:10]}...{api_key[-4:]}")
    print()
    
    # Initialize clients
    api_client = APIClient(api_key)
    db = DatabaseManager(DB_PATH)
    
    try:
        # Step 1: Get available seasons
        print("Step 1: Getting available seasons...")
        seasons = api_client.get_seasons()
        if not seasons:
            print("❌ Failed to get seasons. Check API key and rate limits.")
            return
        
        print(f"✅ Found {len(seasons)} seasons: {seasons[0]} to {seasons[-1]}")
        print(f"   Seasons: {seasons}")
        print()
        
        # Step 2: Get teams (if needed)
        print("Step 2: Getting teams...")
        teams = api_client.get_teams()
        if not teams:
            print("❌ Failed to get teams. Check API key and rate limits.")
            return
        
        print(f"✅ Found {len(teams)} teams")
        print()
        
        # Step 3: Get players for each season
        print("Step 3: Getting players for each season...")
        print("="*80)
        
        all_players: dict = {}  # Key: api_player_id, Value: player data
        
        total_requests = 2  # seasons + teams
        estimated_requests = 1 + 1 + (len(teams) * len(seasons))
        
        print(f"Estimated API requests: {estimated_requests}")
        print(f"On free plan (100/day), this will take ~{estimated_requests // 100 + 1} days")
        print()
        
        for season_idx, season in enumerate(seasons, 1):
            print(f"[{season_idx}/{len(seasons)}] Processing season {season}...")
            season_players = {}
            
            for team_idx, team in enumerate(teams, 1):
                team_id = team["id"]
                team_name = team["name"]
                
                players = api_client.get_players_for_team(team_id, season)
                total_requests += 1
                
                # Collect unique players by API ID
                for player in players:
                    api_id = player["id"]
                    if api_id not in all_players:
                        all_players[api_id] = {
                            "id": player["id"],
                            "name": player["name"]
                        }
                    if api_id not in season_players:
                        season_players[api_id] = all_players[api_id]
                
                print(f"  Team {team_idx}/{len(teams)}: {team_name} - {len(players)} players "
                      f"(total unique: {len(all_players)})")
            
            print(f"  Season {season}: {len(season_players)} players this season, "
                  f"{len(all_players)} total unique players")
            print()
        
        print("="*80)
        print(f"Total unique players across all seasons: {len(all_players)}")
        print(f"Total API requests made: {total_requests}")
        print()
        
        # Step 4: Insert players into database
        print("Step 4: Inserting players into database...")
        print("="*80)
        
        inserted_count = 0
        updated_count = 0
        error_count = 0
        
        for idx, (api_id, player_data) in enumerate(all_players.items(), 1):
            player_name = player_data["name"]
            
            try:
                # Check if player already exists
                cur = db.conn.execute(
                    "SELECT player_id FROM players WHERE api_player_id = ?",
                    (api_id,)
                )
                existing = cur.fetchone()
                cur.close()
                
                # Use database manager method
                player_id = db.get_or_create_player(
                    player_name=player_name,
                    api_player_id=api_id
                )
                
                if existing:
                    updated_count += 1
                else:
                    inserted_count += 1
                
                if idx % 100 == 0:
                    print(f"  Processed {idx}/{len(all_players)} players...")
                    
            except Exception as e:
                error_count += 1
                print(f"  ❌ Error inserting player {player_name} (ID: {api_id}): {e}")
                continue
        
        print()
        print("="*80)
        print("SUMMARY")
        print("="*80)
        print(f"Seasons processed: {len(seasons)}")
        print(f"Total unique players: {len(all_players)}")
        print(f"Players inserted: {inserted_count}")
        print(f"Players updated: {updated_count}")
        if error_count > 0:
            print(f"Errors: {error_count}")
        print(f"API requests made: {total_requests}")
        print()
        print("✅ Complete!")
        
    finally:
        db.conn.close()


if __name__ == "__main__":
    main()

