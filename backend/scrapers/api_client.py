"""
API Client for API-Sports.io AFL API

Handles all API requests with rate limiting and error handling.
"""

import os
import requests
import time
from typing import Optional, Dict, List
import sys

from dotenv import load_dotenv

_here = os.path.abspath(__file__)
_backend_dir = os.path.dirname(os.path.dirname(_here))
load_dotenv(os.path.join(_backend_dir, ".env"))

BASE_URL = "https://v1.afl.api-sports.io"
RATE_LIMIT_DELAY = 6.5  # seconds between requests (10/min = 6 sec, add buffer)


class APIClient:
    """Client for API-Sports.io AFL API"""
    
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = BASE_URL
        self.headers = {
            'x-rapidapi-key': api_key,
            'x-rapidapi-host': 'v1.afl.api-sports.io'
        }
        self.request_count = 0
    
    def _make_request(self, endpoint: str, params: Optional[Dict] = None) -> Optional[Dict]:
        """Make API request with rate limiting and error handling"""
        url = f"{self.base_url}{endpoint}"
        
        self.request_count += 1
        
        try:
            response = requests.get(url, headers=self.headers, params=params, timeout=30)
            
            # Handle rate limiting
            if response.status_code == 429:
                print(f"⚠️  Rate limit hit! Waiting 60 seconds...")
                time.sleep(60)
                return self._make_request(endpoint, params)  # Retry
            
            response.raise_for_status()
            
            # Rate limiting: wait between requests
            if self.request_count > 1:  # Don't wait after first request
                time.sleep(RATE_LIMIT_DELAY)
            
            return response.json()
            
        except requests.exceptions.HTTPError as e:
            print(f"❌ HTTP Error for {endpoint}: {e}")
            if e.response:
                print(f"Response: {e.response.text[:500]}")
            return None
        except Exception as e:
            print(f"❌ Error for {endpoint}: {e}")
            return None
    
    def get_seasons(self) -> List[int]:
        """Get all available seasons"""
        data = self._make_request("/seasons")
        
        if not data or "response" not in data:
            return []
        
        # Response is a list of integers (season years)
        return sorted(data["response"])
    
    def get_teams(self) -> List[Dict]:
        """Get all AFL teams"""
        data = self._make_request("/teams")
        
        if not data or "response" not in data:
            return []
        
        return data["response"]
    
    def get_players_for_team(self, team_id: int, season: int) -> List[Dict]:
        """Get all players for a specific team and season"""
        params = {
            "team": team_id,
            "season": season
        }
        
        data = self._make_request("/players", params=params)
        
        if not data or "response" not in data:
            return []
        
        return data["response"]
    
    def get_all_players_for_season(self, season: int) -> Dict[int, Dict]:
        """Get all unique players for a season across all teams"""
        # First get all teams
        teams = self.get_teams()
        if not teams:
            return {}
        
        # Get players for each team
        all_players: Dict[int, Dict] = {}  # Key: api_player_id
        
        for team in teams:
            team_id = team["id"]
            players = self.get_players_for_team(team_id, season)
            
            # Collect unique players by API ID
            for player in players:
                api_id = player["id"]
                if api_id not in all_players:
                    all_players[api_id] = {
                        "id": player["id"],
                        "name": player["name"]
                    }
        
        return all_players
    
    def get_games_for_season(self, season: int, league: int = 1) -> List[Dict]:
        """Get all games for a season"""
        params = {
            "season": season,
            "league": league
        }
        
        data = self._make_request("/games", params=params)
        
        if not data or "response" not in data:
            return []
        
        return data["response"]
    
    def get_games_with_status(self, season: int, league: int = 1) -> List[Dict]:
        """
        Return a flat list of games with status info, suitable for the auto-updater.

        Each dict has: api_game_id, status_short, status_long, week, round,
        home_team_id, away_team_id, date, venue.

        Status codes from API: "FT" = full time / finished, "NS" = not started,
        "1Q"/"2Q"/etc. = in progress, "POST" = postponed, "CAN" = cancelled.
        """
        raw = self.get_games_for_season(season, league=league)
        games = []
        for r in raw:
            try:
                game_id = (r.get("game") or {}).get("id")
                if not game_id:
                    continue
                status = r.get("status") or {}
                teams = r.get("teams") or {}
                home = (teams.get("home") or {}).get("id")
                away = (teams.get("away") or {}).get("id")
                games.append({
                    "api_game_id": game_id,
                    "status_short": status.get("short"),
                    "status_long": status.get("long"),
                    "week": r.get("week"),
                    "round": r.get("round"),
                    "home_team_id": home,
                    "away_team_id": away,
                    "date": r.get("date"),
                    "venue": r.get("venue"),
                })
            except (KeyError, TypeError, AttributeError):
                continue
        return games

    def get_player_by_id(self, player_id: int) -> Optional[Dict]:
        """Get player info by API player ID. Returns {'id': ..., 'name': ...} or None."""
        data = self._make_request("/players", params={"id": player_id})
        if data and data.get("response"):
            p = data["response"][0]
            return {"id": p.get("id", player_id), "name": p.get("name", f"Unknown_{player_id}")}
        return None

    def get_game_statistics(self, game_id: int) -> Optional[Dict]:
        """Get player statistics for a specific game"""
        params = {
            "id": game_id
        }
        
        data = self._make_request("/games/statistics/players", params=params)
        
        if not data or "response" not in data:
            return None
        
        return data["response"]
    
    def get_request_count(self) -> int:
        """Get the number of API requests made"""
        return self.request_count

