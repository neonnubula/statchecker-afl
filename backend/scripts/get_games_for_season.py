#!/usr/bin/env python3
"""
Get all games for a season and insert into database.

This script:
1. Gets all games for a specified season
2. Extracts venues and creates them if needed
3. Maps teams to database team_ids
4. Inserts games with api_game_id

Usage:
    python scripts/get_games_for_season.py [SEASON] [API_KEY]
    
Example:
    python scripts/get_games_for_season.py 2023
"""

import sys
import os
from datetime import datetime
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


def parse_game_type(round_text: str) -> str:
    """Parse game type from round text"""
    if "Regular Season" in round_text:
        return "Regular Season"
    elif "Finals" in round_text or "Final" in round_text:
        return "Finals"
    elif "Pre-Season" in round_text or "Pre Season" in round_text:
        return "Pre-Season"
    else:
        return "Regular Season"  # Default


def parse_date(iso_string: str) -> tuple:
    """Parse ISO date string to date and time"""
    # "2023-03-16T19:20:00+00:00" -> date and time
    try:
        dt = datetime.fromisoformat(iso_string.replace('Z', '+00:00'))
        return dt.date(), dt.time().strftime("%H:%M")
    except:
        # Fallback parsing
        date_part = iso_string.split('T')[0]
        time_part = iso_string.split('T')[1].split('+')[0] if 'T' in iso_string else None
        date_obj = datetime.strptime(date_part, '%Y-%m-%d').date()
        time_str = time_part[:5] if time_part else None
        return date_obj, time_str


def get_team_id_by_api_id(db: DatabaseManager, api_team_id: int) -> Optional[int]:
    """Get database team_id from API team_id"""
    cur = db.conn.execute(
        "SELECT team_id FROM teams WHERE api_team_id = ?",
        (api_team_id,)
    )
    row = cur.fetchone()
    cur.close()
    return row['team_id'] if row else None


def main():
    """Main function to get games for a season"""
    # Parse arguments
    if len(sys.argv) > 1:
        season = int(sys.argv[1])
    else:
        season = 2023
    
    api_key = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_API_KEY
    
    print("="*80)
    print(f"GET GAMES FOR SEASON {season}")
    print("="*80)
    print(f"Database: {DB_PATH}")
    print(f"API Key: {api_key[:10]}...{api_key[-4:]}")
    print()
    
    # Initialize clients
    api_client = APIClient(api_key)
    db = DatabaseManager(DB_PATH)
    
    try:
        # Step 1: Get games from API
        print(f"Step 1: Getting games for season {season}...")
        games = api_client.get_games_for_season(season, league=1)
        
        if not games:
            print("❌ Failed to get games. Check API key and rate limits.")
            return
        
        print(f"✅ Found {len(games)} games")
        print()
        
        # Step 2: Process and insert games
        print("Step 2: Processing and inserting games...")
        print("="*80)
        
        inserted_count = 0
        updated_count = 0
        error_count = 0
        
        for idx, game_data in enumerate(games, 1):
            try:
                # Extract game data
                api_game_id = game_data.get("game", {}).get("id")
                if not api_game_id:
                    print(f"  ⚠️  [{idx}/{len(games)}] Skipping game - no API ID")
                    error_count += 1
                    continue
                
                season_year = game_data.get("league", {}).get("season", season)
                round_text = game_data.get("round", "Regular Season")
                week = game_data.get("week")
                date_str = game_data.get("date")
                venue_name = game_data.get("venue")
                
                home_team_api_id = game_data.get("teams", {}).get("home", {}).get("id")
                away_team_api_id = game_data.get("teams", {}).get("away", {}).get("id")
                
                if not home_team_api_id or not away_team_api_id:
                    print(f"  ⚠️  [{idx}/{len(games)}] Skipping game {api_game_id} - missing team IDs")
                    error_count += 1
                    continue
                
                # Parse data
                game_type = parse_game_type(round_text)
                round_number = week if week and "Regular Season" in round_text else None
                game_date, game_time = parse_date(date_str) if date_str else (None, None)
                
                if not game_date:
                    print(f"  ⚠️  [{idx}/{len(games)}] Skipping game {api_game_id} - invalid date")
                    error_count += 1
                    continue
                
                # Get/create venue
                venue_id = db.get_or_create_venue(venue_name) if venue_name else None
                if not venue_id:
                    print(f"  ⚠️  [{idx}/{len(games)}] Skipping game {api_game_id} - no venue")
                    error_count += 1
                    continue
                
                # Get team IDs
                home_team_id = get_team_id_by_api_id(db, home_team_api_id)
                away_team_id = get_team_id_by_api_id(db, away_team_api_id)
                
                if not home_team_id or not away_team_id:
                    print(f"  ⚠️  [{idx}/{len(games)}] Skipping game {api_game_id} - team not found in database")
                    error_count += 1
                    continue
                
                # Check if game already exists
                cur = db.conn.execute(
                    "SELECT game_id FROM games WHERE api_game_id = ?",
                    (api_game_id,)
                )
                existing = cur.fetchone()
                cur.close()
                
                # Insert/update game
                game_id = db.get_or_create_game(
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
                
                if existing:
                    updated_count += 1
                    status = "updated"
                else:
                    inserted_count += 1
                    status = "inserted"
                
                # Show progress
                home_team_name = game_data.get("teams", {}).get("home", {}).get("name", "?")
                away_team_name = game_data.get("teams", {}).get("away", {}).get("name", "?")
                
                if idx % 20 == 0 or idx == len(games):
                    print(f"  [{idx}/{len(games)}] {home_team_name} vs {away_team_name} ({game_date}) - {status}")
                
            except Exception as e:
                error_count += 1
                print(f"  ❌ [{idx}/{len(games)}] Error processing game: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        print()
        print("="*80)
        print("SUMMARY")
        print("="*80)
        print(f"Season: {season}")
        print(f"Games found: {len(games)}")
        print(f"Games inserted: {inserted_count}")
        print(f"Games updated: {updated_count}")
        if error_count > 0:
            print(f"Errors: {error_count}")
        print()
        print("✅ Complete!")
        
    finally:
        db.conn.close()


if __name__ == "__main__":
    main()

