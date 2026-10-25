"""
Database Manager updated for API-Sports.io integration.
Uses API IDs as primary identifiers instead of name + DOB.
"""

import sqlite3
from typing import Optional, Tuple
from datetime import date, datetime

class DatabaseManager:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, timeout=30.0)
        self.conn.row_factory = sqlite3.Row
        # Match the FastAPI app's connection tuning so scripts don't
        # block readers. WAL allows concurrent reads while a writer holds
        # the write lock; synchronous=NORMAL is durable enough for this
        # data + much faster than the default FULL.
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA busy_timeout=30000")

    def close(self) -> None:
        """Release the connection. Safe to call multiple times."""
        try:
            self.conn.close()
        except sqlite3.ProgrammingError:
            pass

    def __enter__(self) -> "DatabaseManager":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
    
    def get_or_create_team(self, team_name: str, api_team_id: Optional[int] = None) -> int:
        """
        Get team_id, create if doesn't exist.
        If api_team_id provided, use it to match existing teams.
        """
        # First try to find by API ID if provided
        if api_team_id:
            cur = self.conn.execute(
                "SELECT team_id FROM teams WHERE api_team_id = ?",
                (api_team_id,)
            )
            row = cur.fetchone()
            cur.close()
            if row:
                return row['team_id']
        
        # Fallback to name matching
        cur = self.conn.execute(
            "SELECT team_id FROM teams WHERE team_name = ?",
            (team_name,)
        )
        row = cur.fetchone()
        cur.close()
        if row:
            # Update with API ID if we have it
            if api_team_id:
                self.conn.execute(
                    "UPDATE teams SET api_team_id = ? WHERE team_id = ?",
                    (api_team_id, row['team_id'])
                ).close()
                self.conn.commit()
            return row['team_id']
        
        # Create new team
        cur = self.conn.execute(
            "INSERT INTO teams (team_name, api_team_id, is_active) VALUES (?, ?, 1)",
            (team_name, api_team_id)
        )
        team_id = cur.lastrowid
        cur.close()
        self.conn.commit()
        return team_id
    
    def get_or_create_venue(self, venue_name: str) -> int:
        """Get venue_id, create if doesn't exist"""
        cur = self.conn.execute(
            "SELECT venue_id FROM venues WHERE venue_name = ?",
            (venue_name,)
        )
        row = cur.fetchone()
        cur.close()
        if row:
            return row['venue_id']
        
        cur = self.conn.execute(
            "INSERT INTO venues (venue_name) VALUES (?)",
            (venue_name,)
        )
        venue_id = cur.lastrowid
        cur.close()
        self.conn.commit()
        return venue_id
    
    def get_or_create_player(
        self,
        player_name: str,
        api_player_id: int,  # ⭐ REQUIRED - API player ID
        date_of_birth: Optional[date] = None,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        debut_year: Optional[int] = None,
        team_id: Optional[int] = None,
    ) -> int:
        """
        Get player_id by API player ID, create if doesn't exist.

        Resolution order:
        1. players.api_player_id matches → return existing pid
        2. api_player_id_aliases.alias_api_player_id matches → return canonical pid
        3. Name matches existing player AND (if team_id provided) that player's
           current team matches → insert alias, return existing pid
        4. Otherwise create new row
        """
        # 1. Direct API ID hit
        cur = self.conn.execute(
            "SELECT player_id FROM players WHERE api_player_id = ?",
            (api_player_id,)
        )
        row = cur.fetchone()
        cur.close()
        if row:
            self.conn.execute(
                "UPDATE players SET player_name = ? WHERE player_id = ?",
                (player_name, row['player_id'])
            ).close()
            self.conn.commit()
            return row['player_id']

        # 2. Alias table (only if the table exists — older DBs may not have it)
        canonical = self._lookup_alias(api_player_id)
        if canonical is not None:
            return canonical

        # 3. Name + current team match → merge instead of creating a duplicate
        cur = self.conn.execute(
            "SELECT player_id, api_player_id FROM players "
            "WHERE player_name = ? AND api_player_id IS NOT NULL",
            (player_name,)
        )
        existing = cur.fetchone()
        cur.close()
        if existing and existing['api_player_id'] != api_player_id:
            same_team = False
            if team_id is not None:
                row = self.conn.execute(
                    "SELECT 1 FROM player_team_history "
                    "WHERE player_id = ? AND team_id = ? AND is_current = 1 LIMIT 1",
                    (existing['player_id'], team_id),
                ).fetchone()
                same_team = row is not None

            if same_team:
                self._add_api_alias(
                    api_player_id,
                    existing['player_id'],
                    reason=f"auto-merge: name+team match for {player_name}",
                )
                print(f"↪ Aliased api_player_id {api_player_id} -> existing "
                      f"player_id {existing['player_id']} ('{player_name}')")
                return existing['player_id']

            print(f"⚠️  WARNING: '{player_name}' exists with api_player_id "
                  f"{existing['api_player_id']} but new record has "
                  f"{api_player_id}. Team mismatch or unknown — creating new row.")

        # 4. Create new player
        cur = self.conn.execute(
            """INSERT INTO players
               (player_name, api_player_id, first_name, last_name, date_of_birth, debut_year)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (player_name, api_player_id, first_name, last_name, date_of_birth, debut_year)
        )
        player_id = cur.lastrowid
        cur.close()
        self.conn.commit()
        return player_id

    def _alias_table_exists(self) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_player_id_aliases'"
        ).fetchone()
        return row is not None

    def _lookup_alias(self, api_player_id: int) -> Optional[int]:
        if not self._alias_table_exists():
            return None
        row = self.conn.execute(
            "SELECT canonical_player_id FROM api_player_id_aliases WHERE alias_api_player_id = ?",
            (api_player_id,),
        ).fetchone()
        return row['canonical_player_id'] if row else None

    def _add_api_alias(self, alias_api_player_id: int, canonical_player_id: int, reason: str) -> None:
        if not self._alias_table_exists():
            return
        self.conn.execute(
            "INSERT OR REPLACE INTO api_player_id_aliases "
            "(alias_api_player_id, canonical_player_id, reason) VALUES (?, ?, ?)",
            (alias_api_player_id, canonical_player_id, reason),
        )
        self.conn.commit()
    
    def get_or_create_game(
        self,
        api_game_id: int,  # ⭐ REQUIRED - API game ID
        season_year: int,
        round_number: Optional[int],
        game_type: str,
        game_date: date,
        game_time: Optional[str],
        venue_id: int,
        home_team_id: int,
        away_team_id: int
    ) -> int:
        """Get game_id by API game ID, create if doesn't exist"""
        # Check by API game ID first
        cur = self.conn.execute(
            "SELECT game_id FROM games WHERE api_game_id = ?",
            (api_game_id,)
        )
        row = cur.fetchone()
        if row:
            return row['game_id']
        
        # Fallback: check by date + teams (in case API ID missing)
        cur = self.conn.execute(
            """SELECT game_id FROM games 
               WHERE season_year = ? 
               AND round_number IS ? 
               AND game_date = ? 
               AND home_team_id = ? 
               AND away_team_id = ?""",
            (season_year, round_number, game_date, home_team_id, away_team_id)
        )
        row = cur.fetchone()
        if row:
            # Update with API ID
            self.conn.execute(
                "UPDATE games SET api_game_id = ? WHERE game_id = ?",
                (api_game_id, row['game_id'])
            )
            self.conn.commit()
            return row['game_id']
        
        # Create new game
        cur = self.conn.execute(
            """INSERT INTO games 
               (api_game_id, season_year, round_number, game_type, game_date, game_time, 
                venue_id, home_team_id, away_team_id) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (api_game_id, season_year, round_number, game_type, game_date, game_time,
             venue_id, home_team_id, away_team_id)
        )
        game_id = cur.lastrowid
        cur.close()
        self.conn.commit()
        return game_id
    
    def insert_player_stats(
        self,
        player_id: int,
        game_id: int,
        team_id: int,
        opponent_team_id: int,
        venue_id: int,
        location: str,
        game_time: Optional[str],
        disposals: int,
        goals: int,
        marks: int = 0,
        tackles: int = 0,
        kicks: Optional[int] = None,
        handballs: Optional[int] = None,
        clearances: Optional[int] = None,
        hit_outs: Optional[int] = None,
    ) -> int:
        """
        Insert player stats and handle team history updates.
        Returns stat_id.

        Extended stats (kicks/handballs/clearances/hit_outs) are optional:
        pass None to leave existing values alone on update, or an int to set.
        """
        # Check if stats already exist — opportunistically backfill any column
        # that's currently NULL or zero when the new value is a real figure.
        cur = self.conn.execute(
            """SELECT stat_id, marks, tackles, kicks, handballs, clearances, hit_outs
               FROM player_game_stats WHERE player_id = ? AND game_id = ?""",
            (player_id, game_id)
        )
        existing = cur.fetchone()
        if existing:
            # Backfill marks/tackles if they were stored as 0 and we now have real values
            if (existing['marks'] == 0 and existing['tackles'] == 0) and (marks > 0 or tackles > 0):
                self.conn.execute(
                    "UPDATE player_game_stats SET marks = ?, tackles = ? WHERE stat_id = ?",
                    (marks, tackles, existing['stat_id'])
                )
                self.conn.commit()
            # Backfill extended stats: update any NULL column when a real int is supplied
            updates = []
            params: list = []
            if kicks is not None and existing['kicks'] is None:
                updates.append("kicks = ?")
                params.append(kicks)
            if handballs is not None and existing['handballs'] is None:
                updates.append("handballs = ?")
                params.append(handballs)
            if clearances is not None and existing['clearances'] is None:
                updates.append("clearances = ?")
                params.append(clearances)
            if hit_outs is not None and existing['hit_outs'] is None:
                updates.append("hit_outs = ?")
                params.append(hit_outs)
            if updates:
                params.append(existing['stat_id'])
                self.conn.execute(
                    f"UPDATE player_game_stats SET {', '.join(updates)} WHERE stat_id = ?",
                    params
                )
                self.conn.commit()
            return existing['stat_id']
        
        # Get game date for team history check
        cur = self.conn.execute(
            "SELECT game_date FROM games WHERE game_id = ?",
            (game_id,)
        )
        game_date_row = cur.fetchone()
        cur.close()
        if not game_date_row:
            return None
        game_date = game_date_row['game_date']
        
        # A historical observation must not replace a newer affiliation.
        # Games may arrive out of order, and roster imports can establish a
        # current team before any stats for that team have been collected.
        cur = self.conn.execute(
            """SELECT g.game_date FROM player_game_stats pgs
               JOIN games g ON g.game_id = pgs.game_id
               WHERE pgs.player_id = ? 
               ORDER BY g.game_date DESC, g.game_id DESC LIMIT 1""",
            (player_id,)
        )
        last_game = cur.fetchone()
        cur.close()
        
        current_history = self.conn.execute(
            "SELECT team_id, start_date FROM player_team_history "
            "WHERE player_id = ? AND is_current = 1",
            (player_id,),
        ).fetchall()
        newer_than_stats = not last_game or game_date > last_game['game_date']
        newer_than_roster = all(game_date > row['start_date'] for row in current_history)
        already_current = any(row['team_id'] == team_id for row in current_history)

        # Same-date conflicting observations need identity review, not an
        # arbitrary ingestion-order tie-break. Preserve the raw stat below.
        if newer_than_stats and newer_than_roster and not already_current:
            cur = self.conn.execute(
                """UPDATE player_team_history 
                   SET end_date = ?, is_current = 0 
                   WHERE player_id = ? AND is_current = 1""",
                (game_date, player_id)
            )
            cur.close()
            
            cur = self.conn.execute(
                """INSERT INTO player_team_history 
                   (player_id, team_id, start_date, is_current) 
                   VALUES (?, ?, ?, 1)""",
                (player_id, team_id, game_date)
            )
            cur.close()
        # Insert stats
        cur = self.conn.execute(
            """INSERT INTO player_game_stats
               (player_id, game_id, team_id, opponent_team_id, venue_id,
                location, game_time, disposals, goals, marks, tackles,
                kicks, handballs, clearances, hit_outs)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (player_id, game_id, team_id, opponent_team_id, venue_id,
             location, game_time, disposals, goals, marks, tackles,
             kicks, handballs, clearances, hit_outs)
        )
        stat_id = cur.lastrowid
        cur.close()
        self.conn.commit()
        return stat_id
    
    def stats_exist_for_game(self, game_id: int) -> bool:
        """Whether any player_game_stats row exists for the given internal game_id."""
        row = self.conn.execute(
            "SELECT 1 FROM player_game_stats WHERE game_id = ? LIMIT 1",
            (game_id,)
        ).fetchone()
        return row is not None

    def find_potential_duplicates(self) -> list:
        """
        Find players with same name but different API IDs.
        Returns list of potential duplicates for manual review.
        """
        cur = self.conn.execute("""
            SELECT 
                player_name,
                COUNT(DISTINCT api_player_id) as different_api_ids,
                COUNT(*) as total_records,
                GROUP_CONCAT(DISTINCT api_player_id) as api_ids,
                GROUP_CONCAT(DISTINCT player_id) as our_ids,
                GROUP_CONCAT(DISTINCT date_of_birth) as birth_dates
            FROM players
            WHERE api_player_id IS NOT NULL
            GROUP BY player_name
            HAVING COUNT(DISTINCT api_player_id) > 1
            ORDER BY different_api_ids DESC, player_name
        """)
        return [dict(row) for row in cur.fetchall()]
    
    def update_days_since_last_game(self):
        """Calculate and update days_since_last_game for all stats"""
        self.conn.execute("""
            WITH ranked_games AS (
                SELECT 
                    pgs.stat_id,
                    pgs.player_id,
                    pgs.game_id,
                    g.game_date,
                    LAG(g.game_date) OVER (
                        PARTITION BY pgs.player_id 
                        ORDER BY g.game_date
                    ) as prev_game_date
                FROM player_game_stats pgs
                JOIN games g ON pgs.game_id = g.game_id
            )
            UPDATE player_game_stats
            SET days_since_last_game = (
                SELECT JULIANDAY(rg.game_date) - JULIANDAY(rg.prev_game_date)
                FROM ranked_games rg
                WHERE rg.stat_id = player_game_stats.stat_id
            )
        """)
        self.conn.commit()
    
    def close(self):
        self.conn.close()
