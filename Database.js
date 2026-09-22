
const Database = require("better-sqlite3");

const db = new Database("game.db");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT,
    money INTEGER DEFAULT 1000,
    bank INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    health INTEGER DEFAULT 100,
    last_work INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

function createPlayer(id, name) {
    db.prepare(`
        INSERT OR IGNORE INTO players (id, name)
        VALUES (?, ?)
    `).run(id, name);
}

function getPlayer(id) {
    return db.prepare(`
        SELECT * FROM players WHERE id = ?
    `).get(id);
}

function updatePlayer(id, changes) {
    const allowed = [
        "name",
        "money",
        "bank",
        "level",
        "xp",
        "health",
        "last_work"
    ];

    const keys = Object.keys(changes)
        .filter(key => allowed.includes(key));

    if (!keys.length) return;

    const set = keys.map(key => `${key} = @${key}`).join(", ");

    db.prepare(`
        UPDATE players
        SET ${set}
        WHERE id = @id
    `).run({
        ...changes,
        id
    });
}

module.exports = {
    createPlayer,
    getPlayer,
    updatePlayer
};
