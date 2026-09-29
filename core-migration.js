const {LEVELS} = require('./progression');
const {WEAPON_CATALOGUE} = require('./weapons');
const {MEDKIT, AEGIS} = require('./healing');
const MIGRATION_ID = 'core_game_v1_level50_healing_dice';
// Caller owns one synchronous transaction and the durable snapshot save.
function migrateCore(db) {
    db.run('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    if (db.exec('SELECT 1 FROM schema_migrations WHERE id = ?', [MIGRATION_ID]).length) return false;
    // Never silently lower an out-of-range legacy level or discard an owned item.
    if (db.exec('SELECT 1 FROM players WHERE level IS NULL OR level < 1 OR level > 50 OR level != CAST(level AS INTEGER)').length) {
        throw new Error('Core migration blocked: legacy levels outside 1–50 require review.');
    }
    const columns = db.exec('PRAGMA table_info(players)')[0].values;
    if (!columns.some(row => row[1] === 'combat_until')) db.run('ALTER TABLE players ADD COLUMN combat_until INTEGER NOT NULL DEFAULT 0');
    db.run(`CREATE TABLE level_definitions (
        level INTEGER PRIMARY KEY CHECK(level BETWEEN 1 AND 50), max_hp INTEGER NOT NULL,
        xp_to_next INTEGER, title TEXT NOT NULL UNIQUE);
        CREATE TABLE processed_actions (
        player_id TEXT NOT NULL, action_id TEXT NOT NULL, kind TEXT NOT NULL,
        response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(player_id, action_id));`);
    for (const l of LEVELS) db.run('INSERT INTO level_definitions VALUES (?,?,?,?)', [l.level,l.maxHP,l.xp,l.rank]);
    // One-time heal preserves all identity/economy/progression/inventory fields,
    // including defeat timers. A full HP bar cannot bypass an active defeat timer.
    db.run('UPDATE players SET health = (SELECT max_hp FROM level_definitions WHERE level = players.level)');
    // Preserve any attack cooldown already active at deployment.
    db.run(`UPDATE players SET combat_until = MAX(combat_until,
        CASE WHEN last_attack > 0 THEN last_attack + 60000 ELSE 0 END,
        COALESCE((SELECT MAX(processed_at) + 60000 FROM processed_attacks
            WHERE attacker_id = players.id OR target_id = players.id),0))`);
    db.run(`CREATE TRIGGER players_level_insert BEFORE INSERT ON players
        WHEN NEW.level IS NULL OR NEW.level NOT BETWEEN 1 AND 50 OR NEW.level != CAST(NEW.level AS INTEGER)
        BEGIN SELECT RAISE(ABORT, 'Level must be between 1 and 50'); END;
        CREATE TRIGGER players_level_update BEFORE UPDATE OF level ON players
        WHEN NEW.level IS NULL OR NEW.level NOT BETWEEN 1 AND 50 OR NEW.level != CAST(NEW.level AS INTEGER)
        BEGIN SELECT RAISE(ABORT, 'Level must be between 1 and 50'); END;
        CREATE TRIGGER players_hp_insert AFTER INSERT ON players
        BEGIN UPDATE players SET health = MAX(0, MIN(COALESCE(NEW.health,0),
            (SELECT max_hp FROM level_definitions WHERE level = NEW.level))) WHERE id = NEW.id; END;
        CREATE TRIGGER players_hp_update AFTER UPDATE OF health, level ON players
        WHEN NEW.health IS NULL OR NEW.health < 0 OR NEW.health > (SELECT max_hp FROM level_definitions WHERE level = NEW.level)
        BEGIN UPDATE players SET health = MAX(0, MIN(COALESCE(NEW.health,0),
            (SELECT max_hp FROM level_definitions WHERE level = NEW.level))) WHERE id = NEW.id; END;`);
    for (const item of [WEAPON_CATALOGUE.valkyrie_executioner, WEAPON_CATALOGUE.reaper,
        WEAPON_CATALOGUE.dominator, WEAPON_CATALOGUE.warhammer, MEDKIT, AEGIS]) {
        db.run(`INSERT OR IGNORE INTO items (id,name,description,category,price,stackable,max_quantity) VALUES (?,?,?,?,?,?,?)`,
            [item.id,item.name,item.description,item.category,item.price,Number(item.stackable),item.maxQuantity]);
        db.run('UPDATE items SET price = ?, stackable = ?, max_quantity = ? WHERE id = ?',
            [item.price,Number(item.stackable),item.maxQuantity,item.id]);
    }
    db.run("UPDATE items SET price = 0 WHERE id = 'market_test_item'");
    db.run(`DELETE FROM items WHERE id = 'inventory_test_item'
        AND NOT EXISTS (SELECT 1 FROM player_inventory WHERE item_id = 'inventory_test_item')`);
    // Remove only records explicitly identifying the retired game. Balances and
    // unrelated history remain unchanged; rebuild aggregates only if needed.
    const affectedPlayers = db.exec("SELECT DISTINCT player_id FROM casino_history WHERE game = 'slots'")[0]?.values || [];
    db.run("DELETE FROM casino_history WHERE game = 'slots'");
    db.run("DELETE FROM casino_cooldowns WHERE game = 'slots'");
    const actions = db.exec('SELECT player_id,action_id,response FROM casino_actions')[0]?.values || [];
    for (const [player, action, response] of actions) {
        let parsed; try { parsed = JSON.parse(response); } catch (_) { continue; }
        if (parsed.game === 'slots') db.run('DELETE FROM casino_actions WHERE player_id = ? AND action_id = ?', [player,action]);
    }
    for (const [playerId] of affectedPlayers) {
        db.run('DELETE FROM casino_stats WHERE player_id = ?', [playerId]);
        db.run(`INSERT INTO casino_stats (player_id,total_games,total_wagered,total_won,total_lost,net,biggest_win)
            SELECT player_id,COUNT(*),SUM(wager),SUM(MAX(net,0)),SUM(MAX(-net,0)),SUM(net),MAX(MAX(net,0))
            FROM casino_history WHERE player_id = ? GROUP BY player_id`, [playerId]);
    }
    db.run('INSERT INTO schema_migrations VALUES (?,?)', [MIGRATION_ID,Date.now()]);
    return true;
}
module.exports = {MIGRATION_ID, migrateCore};
