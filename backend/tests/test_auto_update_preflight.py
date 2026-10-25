"""Missing fixtures must never turn a scheduled update into false success."""
from unittest.mock import MagicMock

import pytest

from scripts import auto_update_round as updater


@pytest.fixture
def run_updater(monkeypatch, tmp_path):
    # No actual database, network, process or notification is used in these cases.
    db_path = tmp_path / "unopened.db"
    db_path.touch()
    monkeypatch.setenv("DB_PATH", str(db_path))
    monkeypatch.setenv("AFL_API_KEY", "offline-test-placeholder")
    api, db = MagicMock(), MagicMock()
    monkeypatch.setattr(updater, "APIClient", lambda _key: api)
    monkeypatch.setattr(updater, "DatabaseManager", lambda _path: db)
    blocked_calls = {}
    for name in ("process_game_stats", "load_checkpoint", "save_checkpoint",
                 "update_days_fast", "send_notification"):
        blocked_calls[name] = MagicMock(side_effect=AssertionError(f"Unexpected {name}"))
        monkeypatch.setattr(updater, name, blocked_calls[name])
    process = MagicMock(side_effect=AssertionError("Unexpected subprocess"))
    monkeypatch.setattr(updater.subprocess, "run", process)

    def run(games, existing, populated=(), *, dry_run=False):
        api.get_games_with_status.return_value = games
        monkeypatch.setattr(updater.sys, "argv", ["auto_update_round.py"]
                            + (["--dry-run"] if dry_run else []))
        monkeypatch.setattr(updater, "get_game_id_by_api_id",
                            lambda _db, game_id: {"game_id": game_id} if game_id in existing else None)
        db.stats_exist_for_game.side_effect = lambda game_id: game_id in populated
        code = updater.main()
        for call in blocked_calls.values():
            call.assert_not_called()
        process.assert_not_called()
        db.conn.execute.assert_not_called()
        db.close.assert_called_once()
        return code

    return run


@pytest.mark.parametrize("dry_run", [False, True])
@pytest.mark.parametrize("missing_first", [False, True])
def test_missing_final_stops_before_other_game_collection(run_updater, capsys,
                                                         dry_run, missing_first):
    games = [{"api_game_id": 3631, "status_short": "FT"},
             {"api_game_id": 1, "status_short": "FT"}]
    if not missing_first:
        games.reverse()
    assert run_updater(games, existing={1}, dry_run=dry_run) == 1
    output = capsys.readouterr().out
    assert "INCOMPLETE SOURCE" in output
    assert "3631" in output
    assert "up to date" not in output


@pytest.mark.parametrize("dry_run", [False, True])
def test_only_missing_finals_is_failure(run_updater, capsys, dry_run):
    games = [{"api_game_id": game_id, "status_short": "FT"}
             for game_id in [3632, 3631, 3632]]
    assert run_updater(games, existing=set(), dry_run=dry_run) == 1
    assert "3631, 3632" in capsys.readouterr().out


def test_existing_row_does_not_claim_completeness(run_updater, capsys):
    games = [{"api_game_id": 1, "status_short": "FT"}]
    assert run_updater(games, existing={1}, populated={1}) == 0
    output = capsys.readouterr().out
    assert "completeness" in output and "not verified" in output
    assert "up to date" not in output


@pytest.mark.parametrize("status", ["NS", "1Q", "POST", "CAN"])
def test_unfinished_missing_fixture_does_not_block(run_updater, capsys, status):
    assert run_updater([{"api_game_id": 3631, "status_short": status}], existing=set()) == 0
    assert "INCOMPLETE SOURCE" not in capsys.readouterr().out


def test_known_empty_game_remains_a_dry_run_target(run_updater, capsys):
    assert run_updater([{"api_game_id": 1, "status_short": "FT"}],
                       existing={1}, dry_run=True) == 0
    assert "Will fetch stats for 1 game(s)" in capsys.readouterr().out
