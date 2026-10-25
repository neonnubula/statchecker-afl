import sqlite3

from app.main import _build_stats_query, _normalize_game_type


def test_all_competition_games_excludes_preseason_but_preserves_finals():
    with sqlite3.connect(':memory:') as db:
        db.executescript('''CREATE TABLE games(game_id INTEGER, game_type TEXT);
            CREATE TABLE player_game_stats(player_id INTEGER,game_id INTEGER,disposals INTEGER);
            INSERT INTO games VALUES(1,'Regular Season'),(2,'Finals'),(3,'Pre-Season');
            INSERT INTO player_game_stats VALUES(1,1,10),(1,2,30),(1,3,50);''')
        sql, params = _build_stats_query('disposals', False, None, None, None, None,
                                        None, None, None, _normalize_game_type('all'))
        assert db.execute(sql, {**params, 'player_id':1,'threshold':20}).fetchone() == (1,1)


def test_import_invalidation_prevents_inflight_query_repopulating_current_cache():
    from app import main
    args = (1, 'disposals', 20, False, 2026, 2026, None, None, None, None, None, 'all')
    old_key = main._make_cache_key(*args)
    main._clear_afl_stats_cache()
    main._store_cached_result(old_key, {'over':1,'under':0})
    assert main._get_cached_result(main._make_cache_key(*args)) is None
    main._clear_afl_stats_cache()
