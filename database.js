const fs = require("fs");
const initSqlJs = require("sql.js");
const { MISSION_DEFINITIONS } = require("./missions");
const { WEAPON_CATALOGUE, isWeapon, getWeaponDefinition } = require("./weapons");
const { SHIELD_CATALOGUE, isShield, getShieldDefinition } = require("./shields");

const { SCHEMA: CASINO_SCHEMA, createCasino } = require("./casino");
const { SCHEMA: JOB_SCHEMA, createJobs } = require("./jobs");
const {getMaxHP, getRank, validLevel, addXP} = require('./progression');
const {MEDKIT, AEGIS, medkitHealing, medicPrice} = require('./healing');
const {migrateCore} = require('./core-migration');
let db;
let transactionDepth = 0;
// Reuse synchronous SQL.js transactions. Nested inventory helpers defer saving.
// A failed durable save restores the pre-action in-memory snapshot as well.
function atomic(operation) {
    if (transactionDepth) return operation();
    const snapshot = db.export();
    let committed = false;
    db.run('BEGIN TRANSACTION');
    transactionDepth++;
    try {
        const result = operation();
        if (result?.success === false || result?.duplicate) {
            db.run('ROLLBACK'); transactionDepth--; return result;
        }
        db.run('COMMIT'); committed = true;
        transactionDepth--;
        saveDatabase();
        return result;
    } catch (error) {
        transactionDepth = 0;
        if (!committed) { try { db.run('ROLLBACK'); } catch (_) {} }
        else { const old = db; db = new old.constructor(snapshot); old.close(); }
        throw error;
    }
}
function action(playerId, kind, actionId, operation) {
    return atomic(() => {
        if (actionId !== undefined && (typeof actionId !== 'string' || !actionId)) return {success:false,reason:'MISSING_MESSAGE_ID'};
        if (actionId) {
            const previous = db.exec('SELECT response FROM processed_actions WHERE player_id = ? AND action_id = ?', [playerId,actionId]);
            if (previous.length) return {...JSON.parse(previous[0].values[0][0]), duplicate:true};
        }
        const result = operation();
        if (result.success && actionId) db.run('INSERT INTO processed_actions VALUES (?,?,?,?,?)',
            [playerId,actionId,kind,JSON.stringify(result),Date.now()]);
        return result;
    });
}
const casino = createCasino({
    getDb: () => db,
    save: saveDatabase,
    restore: snapshot => { const old = db; db = new old.constructor(snapshot); old.close(); },
    missionProgress: applyMissionProgress
});
const jobs = createJobs({
    getDb: () => db,
    save: saveDatabase,
    restore: snapshot => { const old = db; db = new old.constructor(snapshot); old.close(); },
    missionProgress: applyMissionProgress
});
const DB_FILE = "./game.db";
const MAX_HEALTH = 500; // Absolute ceiling; individual limits come from getMaxHP(level).
const ATTACK_COOLDOWN = 30 * 1000;
const RECOVERY_DURATION = 10 * 60 * 1000;
const COMBAT_DURATION = 60 * 1000;

function saveDatabase() {
    if (transactionDepth) return;
    const data = db.export();
    // Replace the saved snapshot atomically, so an interrupted write cannot
    // leave half of a combat result (or a truncated database) on disk.
    const temporaryFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, Buffer.from(data));
    fs.renameSync(temporaryFile, DB_FILE);
}

async function initDatabase() {
    const SQL = await initSqlJs({
        locateFile: (file) =>
            require.resolve(`sql.js/dist/${file}`)
    });

    if (fs.existsSync(DB_FILE)) {
        const fileBuffer = fs.readFileSync(DB_FILE);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS robbery_protection (
            target_id TEXT PRIMARY KEY,
            attempts INTEGER DEFAULT 0,
            threshold INTEGER DEFAULT 2,
            protected_until INTEGER DEFAULT 0
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS players (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            money INTEGER DEFAULT 1000,
            bank INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1,
            xp INTEGER DEFAULT 0,
            health INTEGER DEFAULT 100,
            last_work INTEGER DEFAULT 0,
            last_rob INTEGER DEFAULT 0,
            last_daily INTEGER DEFAULT 0,
            deposit_count INTEGER DEFAULT 0,
            deposit_reset INTEGER DEFAULT 0,
            rank TEXT DEFAULT 'PLAYER',
            created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        )
    `);

    const tableInfo = db.exec(
        "PRAGMA table_info(players)"
    );

    const columns =
        tableInfo[0]?.values || [];

    const columnNames = new Set(
        columns.map((row) => row[1])
    );

    for (const column of ["last_attack", "defeated_until"]) {
        if (!columnNames.has(column)) {
            db.run(`ALTER TABLE players ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
        }
    }

    if (!columnNames.has("rank")) {
        db.run(
            "ALTER TABLE players ADD COLUMN rank TEXT DEFAULT 'PLAYER'"
        );
    }

    if (!columnNames.has("last_rob")) {
        db.run(
            "ALTER TABLE players ADD COLUMN last_rob INTEGER DEFAULT 0"
        );
    }

    if (!columnNames.has("last_daily")) {
        db.run(
            "ALTER TABLE players ADD COLUMN last_daily INTEGER DEFAULT 0"
        );
    }

    if (!columnNames.has("deposit_count")) {
        db.run(
            "ALTER TABLE players ADD COLUMN deposit_count INTEGER DEFAULT 0"
        );
    }

    if (!columnNames.has("deposit_reset")) {
        db.run(
            "ALTER TABLE players ADD COLUMN deposit_reset INTEGER DEFAULT 0"
        );
    }

    db.run(`
        UPDATE players
        SET rank = 'PLAYER'
        WHERE rank IS NULL OR rank = ''
    `);

    db.run(`
        UPDATE players
        SET last_rob = 0
        WHERE last_rob IS NULL
    `);

    db.run(`
        UPDATE players
        SET last_daily = 0
        WHERE last_daily IS NULL
    `);

    db.run(`
        UPDATE players
        SET deposit_count = 0
        WHERE deposit_count IS NULL
    `);

    db.run(`
        UPDATE players
        SET deposit_reset = 0
        WHERE deposit_reset IS NULL
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            category TEXT NOT NULL,
            price INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        )
    `);

    const itemColumns = db.exec(
        "PRAGMA table_info(items)"
    )[0]?.values || [];

    const itemColumnNames = new Set(
        itemColumns.map(row => row[1])
    );

    if (!itemColumnNames.has("price")) {
        db.run(
            "ALTER TABLE items ADD COLUMN price INTEGER NOT NULL DEFAULT 0"
        );
    }

    if (!itemColumnNames.has("stackable")) {
        db.run(
            "ALTER TABLE items ADD COLUMN stackable INTEGER NOT NULL DEFAULT 1"
        );
    }

    if (!itemColumnNames.has("max_quantity")) {
        db.run(
            "ALTER TABLE items ADD COLUMN max_quantity INTEGER NOT NULL DEFAULT 999"
        );
    }

    db.run(`
        UPDATE items
        SET price = CASE id
            WHEN 'pocket_knife' THEN 2000
            WHEN 'combat_knife' THEN 5000
            WHEN 'hatchet' THEN 8000
            WHEN 'pistol' THEN 15000
            WHEN 'revolver' THEN 25000
            WHEN 'smg' THEN 45000
            WHEN 'shotgun' THEN 60000
            WHEN 'assault_rifle' THEN 100000
            WHEN 'sniper' THEN 150000
            WHEN 'light_shield' THEN 10000
            WHEN 'reinforced_shield' THEN 20000
            WHEN 'tactical_shield' THEN 35000
            WHEN 'heavy_shield' THEN 50000
            WHEN 'advanced_shield' THEN 75000
            ELSE price
        END
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS player_inventory (
            player_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
            equipped INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0,1)),
            created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
            PRIMARY KEY (player_id, item_id),
            FOREIGN KEY (player_id) REFERENCES players(id),
            FOREIGN KEY (item_id) REFERENCES items(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS missions (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            requirement TEXT NOT NULL,
            target_amount INTEGER NOT NULL CHECK (target_amount > 0),
            reward INTEGER NOT NULL CHECK (reward >= 0),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS player_missions (
            player_id TEXT NOT NULL,
            mission_id TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
            completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
            rewarded INTEGER NOT NULL DEFAULT 0 CHECK (rewarded IN (0,1)),
            completed_at INTEGER DEFAULT 0,
            rewarded_at INTEGER DEFAULT 0,
            PRIMARY KEY (player_id, mission_id),
            FOREIGN KEY (player_id) REFERENCES players(id),
            FOREIGN KEY (mission_id) REFERENCES missions(id)
        )
    `);

    for (const mission of MISSION_DEFINITIONS) {
        db.run(
            `INSERT OR IGNORE INTO missions
             (id, type, title, description, requirement, target_amount, reward, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                mission.id,
                mission.type,
                mission.title,
                mission.description,
                mission.requirement,
                mission.targetAmount,
                mission.reward,
                mission.active ? 1 : 0
            ]
        );
    }

    for (const weapon of Object.values(WEAPON_CATALOGUE)) {
        db.run(
            `INSERT OR IGNORE INTO items
             (id, name, description, category, price, stackable, max_quantity)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                weapon.id,
                weapon.name,
                weapon.description,
                weapon.category,
                weapon.price,
                weapon.stackable ? 1 : 0,
                weapon.maxQuantity
            ]
        );
    }

    for (const shield of Object.values(SHIELD_CATALOGUE)) {
        db.run(
            `INSERT OR IGNORE INTO items
             (id, name, description, category, price, stackable, max_quantity)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                shield.id,
                shield.name,
                shield.description,
                shield.category,
                shield.price,
                shield.stackable ? 1 : 0,
                shield.maxQuantity
            ]
        );
    }

    for (const item of [AEGIS, MEDKIT]) {
        db.run(`INSERT OR IGNORE INTO items (id,name,description,category,price,stackable,max_quantity) VALUES (?,?,?,?,?,?,?)`,
            [item.id,item.name,item.description,item.category,item.price,Number(item.stackable),item.maxQuantity]);
    }

    // NULL means this owned shield has never had its pool initialized.
    // Zero is depleted and must never be reset by equipping or restarting.
    const inventoryColumns = db.exec("PRAGMA table_info(player_inventory)")[0].values;
    if (!inventoryColumns.some(row => row[1] === "shield_remaining")) {
        db.run("ALTER TABLE player_inventory ADD COLUMN shield_remaining INTEGER DEFAULT NULL CHECK (shield_remaining >= 0)");
    }
    db.run(`CREATE TABLE IF NOT EXISTS processed_attacks (
        message_key TEXT PRIMARY KEY,
        attacker_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL
    )`);
    db.run(`UPDATE missions SET active = 1,
        description = 'Defeat another player in combat.',
        requirement = 'Defeat 1 player'
        WHERE id = 'win_first_attack' AND type = 'win_attack'`);

    db.run(CASINO_SCHEMA);
    db.run(JOB_SCHEMA);
    atomic(() => migrateCore(db));

    console.log("✅ Database initialized");
}

function createPlayer(
    id,
    name,
    rank = "PLAYER"
) {
    const existing = getPlayer(id);

    if (existing) {
        return existing;
    }

    db.run(
        `INSERT INTO players
        (
            id,
            name,
            money,
            bank,
            level,
            xp,
            health,
            last_work,
            last_rob,
            last_daily,
            deposit_count,
            deposit_reset,
            rank
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            name || "Player",
            1000,
            0,
            1,
            0,
            100,
            0,
            0,
            0,
            0,
            0,
            rank
        ]
    );

    saveDatabase();

    ensurePlayerMissions(id);

    return getPlayer(id);
}

function getPlayer(id) {
    const result = db.exec(
        `SELECT
            id,
            name,
            money,
            bank,
            level,
            xp,
            health,
            combat_until,
            last_attack,
            defeated_until,
            last_work,
            last_rob,
            last_daily,
            deposit_count,
            deposit_reset,
            rank,
            created_at
        FROM players
        WHERE id = ?`,
        [id]
    );

    if (
        !result.length ||
        !result[0].values.length
    ) {
        return null;
    }

    const columns = result[0].columns;
    const values = result[0].values[0];

    const player = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    // Stored rank remains the authorization role; progression rank is derived.
    return {...player, maxHP: getMaxHP(player.level), levelRank: getRank(player.level)};
}

function updatePlayer(
    id,
    updates = {}
) {
    if (Object.prototype.hasOwnProperty.call(updates, "level")) validLevel(updates.level);
    if (Object.prototype.hasOwnProperty.call(updates, "health")) {
        const health = Number(updates.health);
        if (!Number.isFinite(health)) throw new Error("Health must be finite.");
        updates = { ...updates, health: Math.max(0, Math.min(getMaxHP(updates.level ?? getPlayer(id).level), Math.floor(health))) };
    }
    const allowed = new Set([
        "name",
        "money",
        "bank",
        "level",
        "xp",
        "health",
        "last_work",
        "last_rob",
        "last_daily",
        "deposit_count",
        "deposit_reset",
        "rank"
    ]);

    const entries = Object.entries(updates)
        .filter(([key]) =>
            allowed.has(key)
        );

    if (!entries.length) {
        return;
    }

    const setClause = entries
        .map(([key]) =>
            `${key} = ?`
        )
        .join(", ");

    const values = entries.map(
        ([, value]) => value
    );

    values.push(id);

    db.run(
        `UPDATE players
         SET ${setClause}
         WHERE id = ?`,
        values
    );

    saveDatabase();
}

function getRobberyProtection(targetId) {
    const result = db.exec(
        `SELECT
            target_id,
            attempts,
            threshold,
            protected_until
         FROM robbery_protection
         WHERE target_id = ?`,
        [targetId]
    );

    if (
        !result.length ||
        !result[0].values.length
    ) {
        const threshold =
            Math.floor(Math.random() * 6) + 2;

        db.run(
            `INSERT INTO robbery_protection
             (
                 target_id,
                 attempts,
                 threshold,
                 protected_until
             )
             VALUES (?, ?, ?, ?)`,
            [
                targetId,
                0,
                threshold,
                0
            ]
        );

        saveDatabase();

        return {
            target_id: targetId,
            attempts: 0,
            threshold,
            protected_until: 0
        };
    }

    const columns = result[0].columns;
    const values = result[0].values[0];

    return Object.fromEntries(
        columns.map(
            (column, index) =>
                [column, values[index]]
        )
    );
}

function updateRobberyProtection(
    targetId,
    updates = {}
) {
    const allowed = new Set([
        "attempts",
        "threshold",
        "protected_until"
    ]);

    const entries = Object.entries(updates)
        .filter(([key]) =>
            allowed.has(key)
        );

    if (!entries.length) {
        return;
    }

    const setClause = entries
        .map(([key]) =>
            `${key} = ?`
        )
        .join(", ");

    const values = entries.map(
        ([, value]) => value
    );

    values.push(targetId);

    db.run(
        `UPDATE robbery_protection
         SET ${setClause}
         WHERE target_id = ?`,
        values
    );

    saveDatabase();
}

function createItem(
    itemId,
    name,
    description = "",
    category,
    price = 0,
    stackable = 1,
    maxQuantity = 999
) {
    if (!itemId || !name || !category) {
        throw new Error(
            "Item ID, name, and category are required."
        );
    }

    const itemPrice = Number(price);

    if (
        !Number.isInteger(itemPrice) ||
        itemPrice < 0
    ) {
        throw new Error(
            "Price must be a non-negative integer."
        );
    }

    const itemMaxQuantity = Number(maxQuantity);

    if (
        !Number.isInteger(itemMaxQuantity) ||
        itemMaxQuantity < 1
    ) {
        throw new Error(
            "Maximum quantity must be a positive integer."
        );
    }

    const existing = db.exec(
        `SELECT id FROM items WHERE id = ?`,
        [itemId]
    );

    if (
        existing.length &&
        existing[0].values.length
    ) {
        throw new Error("Item already exists.");
    }

    db.run(
        `INSERT INTO items
         (id, name, description, category, price, stackable, max_quantity)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            itemId,
            name,
            description,
            category,
            itemPrice,
            stackable ? 1 : 0,
            itemMaxQuantity
        ]
    );

    saveDatabase();

    return getItem(itemId);
}

function getItem(itemId) {
    const result = db.exec(
        `SELECT id, name, description, category, price, stackable, max_quantity, created_at
         FROM items WHERE id = ?`,
        [itemId]
    );

    if (!result.length || !result[0].values.length) {
        return null;
    }

    const columns = result[0].columns;
    const values = result[0].values[0];

    return Object.fromEntries(
        columns.map((column, index) => [column, values[index]])
    );
}

function getInventory(playerId) {
    const result = db.exec(
        `SELECT
            pi.player_id,
            pi.item_id,
            i.name,
            i.description,
            i.category,
            pi.quantity,
            pi.equipped,
            pi.shield_remaining,
            pi.created_at
         FROM player_inventory pi
         INNER JOIN items i
             ON pi.item_id = i.id
         WHERE pi.player_id = ?
         ORDER BY i.category, i.name`,
        [playerId]
    );

    if (
        !result.length ||
        !result[0].values.length
    ) {
        return [];
    }

    const columns = result[0].columns;
    const values = result[0].values;

    return values.map(row =>
        Object.fromEntries(
            columns.map(
                (column, index) =>
                    [column, row[index]]
            )
        )
    );
}

function getInventoryItem(
    playerId,
    itemId
) {
    const result = db.exec(
        `SELECT
            pi.player_id,
            pi.item_id,
            i.name,
            i.description,
            i.category,
            pi.quantity,
            pi.equipped,
            pi.shield_remaining,
            pi.created_at
         FROM player_inventory pi
         INNER JOIN items i
             ON pi.item_id = i.id
         WHERE pi.player_id = ?
           AND pi.item_id = ?`,
        [
            playerId,
            itemId
        ]
    );

    if (
        !result.length ||
        !result[0].values.length
    ) {
        return null;
    }

    const columns = result[0].columns;
    const values = result[0].values[0];

    return Object.fromEntries(
        columns.map(
            (column, index) =>
                [column, values[index]]
        )
    );
}

function addItem(
    playerId,
    itemId,
    quantity = 1
) {
    const amount =
        Number(quantity);

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        throw new Error(
            "Quantity must be a positive integer."
        );
    }

    const player =
        getPlayer(playerId);

    if (!player) {
        throw new Error(
            "Player does not exist."
        );
    }

    const itemResult = db.exec(
        `SELECT id
         FROM items
         WHERE id = ?`,
        [itemId]
    );

    if (
        !itemResult.length ||
        !itemResult[0].values.length
    ) {
        throw new Error(
            "Item does not exist."
        );
    }

    const existing =
        getInventoryItem(
            playerId,
            itemId
        );

    const definition = getItem(itemId);
    if (Number(existing?.quantity || 0) + amount > Number(definition.max_quantity) ||
        (!Number(definition.stackable) && Number(existing?.quantity || 0) + amount > 1)) {
        throw new Error(`Maximum ${definition.name} quantity is ${definition.max_quantity}.`);
    }

    if (existing) {
        db.run(
            `UPDATE player_inventory
             SET quantity = quantity + ?
             WHERE player_id = ?
               AND item_id = ?`,
            [
                amount,
                playerId,
                itemId
            ]
        );
    } else {
        db.run(
            `INSERT INTO player_inventory
             (
                 player_id,
                 item_id,
                 quantity,
                 equipped
             )
             VALUES (?, ?, ?, 0)`,
            [
                playerId,
                itemId,
                amount
            ]
        );
    }

    saveDatabase();

    return getInventoryItem(
        playerId,
        itemId
    );
}

function removeItem(
    playerId,
    itemId,
    quantity = 1
) {
    const amount =
        Number(quantity);

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        throw new Error(
            "Quantity must be a positive integer."
        );
    }

    const existing =
        getInventoryItem(
            playerId,
            itemId
        );

    if (!existing) {
        return false;
    }

    const currentQuantity =
        Number(existing.quantity);

    if (
        amount > currentQuantity
    ) {
        return false;
    }

    const newQuantity =
        currentQuantity - amount;

    if (newQuantity === 0) {
        db.run(
            `DELETE FROM player_inventory
             WHERE player_id = ?
               AND item_id = ?`,
            [
                playerId,
                itemId
            ]
        );
    } else {
        db.run(
            `UPDATE player_inventory
             SET quantity = ?
             WHERE player_id = ?
               AND item_id = ?`,
            [
                newQuantity,
                playerId,
                itemId
            ]
        );
    }

    saveDatabase();

    return true;
}

function equipItem(playerId, itemId, actionId) {
    return action(playerId, 'equip', actionId, () => {
        const item = getInventoryItem(playerId, itemId);
        if (!item || Number(item.quantity) <= 0) return {success:false,reason:'ITEM_NOT_OWNED'};
        const catalogue = isWeapon(itemId) ? WEAPON_CATALOGUE : isShield(itemId) ? SHIELD_CATALOGUE : null;
        if (!catalogue) return {success:false,reason:'ITEM_NOT_EQUIPPABLE'};
        const ids = Object.keys(catalogue);
        db.run(`UPDATE player_inventory SET equipped = 0 WHERE player_id = ? AND item_id IN (${ids.map(() => '?').join(',')})`, [playerId,...ids]);
        if (isShield(itemId)) db.run(`UPDATE player_inventory SET shield_remaining = ?
            WHERE player_id = ? AND item_id = ? AND shield_remaining IS NULL`, [getShieldDefinition(itemId).absorption,playerId,itemId]);
        db.run('UPDATE player_inventory SET equipped = 1 WHERE player_id = ? AND item_id = ? AND quantity > 0', [playerId,itemId]);
        if (db.getRowsModified() !== 1) throw new Error('Equip failed');
        return {success:true,item:getInventoryItem(playerId,itemId)};
    });
}
function unequipItem(playerId, itemId, actionId) {
    return action(playerId, 'unequip', actionId, () => {
        const item = getInventoryItem(playerId,itemId);
        if (!item || Number(item.quantity) <= 0) return {success:false,reason:'ITEM_NOT_OWNED'};
        db.run('UPDATE player_inventory SET equipped = 0 WHERE player_id = ? AND item_id = ?', [playerId,itemId]);
        if (db.getRowsModified() !== 1) throw new Error('Unequip failed');
        return {success:true,item:getInventoryItem(playerId,itemId)};
    });
}

function setEquipped(playerId, itemId, equipped) {
    const result = equipped
        ? equipItem(playerId, itemId)
        : unequipItem(playerId, itemId);
    return result.success ? result.item : false;
}

function hasItem(
    playerId,
    itemId
) {
    const result = db.exec(
        `SELECT 1
         FROM player_inventory
         WHERE player_id = ?
           AND item_id = ?
           AND quantity > 0
         LIMIT 1`,
        [
            playerId,
            itemId
        ]
    );

    return Boolean(
        result.length &&
        result[0].values.length
    );
}

function getMarketItems() {
    const result = db.exec(`
        SELECT id, name, description, category, price
        FROM items
        WHERE price > 0 AND id NOT IN ('market_test_item', 'inventory_test_item')
        ORDER BY category, price
    `);

    if (!result.length || !result[0].values.length) {
        return [];
    }

    const columns = result[0].columns;
    return result[0].values.map(row =>
        Object.fromEntries(
            columns.map((column, index) => [column, row[index]])
        )
    );
}

function buyItem(playerId, itemId, quantity = 1, actionId) {
    return action(playerId, 'buy', actionId, () => {
        const amount = Number(quantity);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Quantity must be a positive safe integer.');
        const player = getPlayer(playerId);
        if (!player) throw new Error('Player does not exist.');
        const item = getItem(itemId);
        if (!item || item.price <= 0 || ['market_test_item','inventory_test_item'].includes(itemId)) return {success:false,reason:'ITEM_NOT_FOUND'};
        const currentQuantity = Number(getInventoryItem(playerId,itemId)?.quantity || 0);
        if (!item.stackable && currentQuantity > 0) return {success:false,reason:'ITEM_NOT_STACKABLE',item};
        if (currentQuantity + amount > item.max_quantity) return {success:false,reason:'MAX_QUANTITY',item};
        const total = item.price * amount;
        if (!Number.isSafeInteger(total) || !Number.isSafeInteger(player.money)) throw new Error('Unsafe purchase');
        if (player.money < total) return {success:false,reason:'INSUFFICIENT_FUNDS',item,total,balance:player.money};
        db.run('UPDATE players SET money = money - ? WHERE id = ? AND money >= ?', [total,playerId,total]);
        if (db.getRowsModified() !== 1) throw new Error('Purchase debit failed');
        addItem(playerId,itemId,amount);
        db.run('INSERT OR IGNORE INTO player_missions (player_id,mission_id) SELECT ?,id FROM missions WHERE active = 1', [playerId]);
        const missionCompletions = applyMissionProgress(playerId,'buy_item',amount,Date.now());
        return {success:true,item,quantity:amount,total,balance:getPlayer(playerId).money,missionCompletions};
    });
}

function healPlayer(playerId, kind, amount = 1, actionId) {
    return action(playerId, kind, actionId, () => {
        if (!['medkit','medic'].includes(kind)) return {success:false,reason:'INVALID_SERVICE'};
        const player = getPlayer(playerId);
        if (!player) return {success:false,reason:'REGISTER_FIRST'};
        if (isDefeated(player)) return {success:false,reason:'DEFEATED',recoveryAt:player.defeated_until};
        const restrictedUntil = Math.max(Number(player.combat_until), (Number(player.last_attack) > 0 ? Number(player.last_attack) + COMBAT_DURATION : 0));
        if (restrictedUntil > Date.now()) return {success:false,reason:'COMBAT',remainingMs:restrictedUntil-Date.now()};
        const maxHP = getMaxHP(player.level), missing = maxHP - player.health;
        if (missing <= 0) return {success:false,reason:'FULL_HP'};
        let used = 0, cost = 0, health = maxHP;
        if (kind === 'medkit') {
            if (!/^[1-9][0-9]*$/.test(String(amount)) || !Number.isSafeInteger(Number(amount))) return {success:false,reason:'INVALID_AMOUNT'};
            const available = Number(getInventoryItem(playerId,'medkit')?.quantity || 0);
            // A requested quantity is a maximum. Do not spend kits beyond those
            // owned or needed; zero ownership is the only quantity failure.
            used = Math.min(Number(amount),available,Math.ceil(missing / medkitHealing(player.level)));
            if (!used) return {success:false,reason:'NO_MEDKITS'};
            health = Math.min(maxHP, player.health + used * medkitHealing(player.level));
            if (!removeItem(playerId,'medkit',used)) throw new Error('Medkit consumption failed');
        } else {
            cost = medicPrice(player.level,player.health);
            if (!Number.isSafeInteger(player.money) || player.money < cost) return {success:false,reason:'INSUFFICIENT_FUNDS',cost};
            db.run('UPDATE players SET money = money - ? WHERE id = ? AND money >= ?', [cost,playerId,cost]);
            if (db.getRowsModified() !== 1) throw new Error('Medic debit failed');
        }
        db.run('UPDATE players SET health = ? WHERE id = ?', [health,playerId]);
        if (db.getRowsModified() !== 1) throw new Error('Heal failed');
        let missionCompletions = [];
        if (used) {
            db.run('INSERT OR IGNORE INTO player_missions (player_id,mission_id) SELECT ?,id FROM missions WHERE active = 1', [playerId]);
            missionCompletions = applyMissionProgress(playerId,'use_item',used,Date.now());
        }
        return {success:true,used,cost,health,maxHP,healed:health-player.health,missionCompletions};
    });
}

function claimWork(playerId, actionId, now = Date.now()) {
    return action(playerId, 'work', actionId, () => {
        const player = getPlayer(playerId);
        if (!player) return {success:false,reason:'REGISTER_FIRST'};
        const remainingMs = 10000 - (now - player.last_work);
        if (remainingMs > 0) return {success:false,reason:'COOLDOWN',remainingMs};
        const {randomInt} = require('node:crypto');
        const payout = randomInt(100,501), xp = randomInt(5,16);
        if (!Number.isSafeInteger(player.money+payout)) throw new Error('Unsafe work reward');
        const progression = addXP(player.level,player.xp,xp);
        db.run('UPDATE players SET money = money + ?, xp = ?, level = ?, last_work = ? WHERE id = ?',
            [payout,progression.xp,progression.level,now,playerId]);
        return {success:true,payout,xp,progression,balance:getPlayer(playerId).money};
    });
}

function completeRobbery(
    attackerId,
    targetId,
    amount
) {
    const stolen = Number(amount);

    if (
        !attackerId ||
        !targetId ||
        attackerId === targetId ||
        !Number.isInteger(stolen) ||
        stolen <= 0
    ) {
        return false;
    }

    db.run("BEGIN TRANSACTION");

    try {
        const target = getPlayer(targetId);
        const attacker = getPlayer(attackerId);

        if (
            !target ||
            !attacker ||
            isDefeated(attacker) ||
            Number(target.money) < stolen
        ) {
            db.run("ROLLBACK");
            return false;
        }

        db.run(
            `UPDATE players
             SET money = money - ?
             WHERE id = ?
               AND money >= ?`,
            [stolen, targetId, stolen]
        );

        if (db.getRowsModified() !== 1) {
            db.run("ROLLBACK");
            return false;
        }

        db.run(
            `UPDATE players
             SET money = money + ?
             WHERE id = ?`,
            [stolen, attackerId]
        );

        if (db.getRowsModified() !== 1) {
            db.run("ROLLBACK");
            return false;
        }

        db.run("COMMIT");
        saveDatabase();
        return true;
    } catch (error) {
        try {
            db.run("ROLLBACK");
        } catch (_) {
            // Preserve the original database error.
        }

        throw error;
    }
}

function ensurePlayerMissions(playerId) {
    const player = getPlayer(playerId);

    if (!player) {
        return;
    }

    db.run(
        `INSERT OR IGNORE INTO player_missions (player_id, mission_id)
         SELECT ?, id FROM missions WHERE active = 1`,
        [playerId]
    );

    if (db.getRowsModified() > 0) {
        saveDatabase();
    }
}

function getPlayerMissions(playerId) {
    ensurePlayerMissions(playerId);

    const result = db.exec(
        `SELECT
            m.id,
            m.type,
            m.title,
            m.description,
            m.requirement,
            m.target_amount,
            m.reward,
            m.active,
            pm.progress,
            pm.completed,
            pm.rewarded,
            pm.completed_at,
            pm.rewarded_at
         FROM missions m
         INNER JOIN player_missions pm
             ON pm.mission_id = m.id
            AND pm.player_id = ?
         WHERE m.active = 1
         ORDER BY m.id`,
        [playerId]
    );

    if (!result.length || !result[0].values.length) {
        return [];
    }

    const columns = result[0].columns;
    return result[0].values.map(row =>
        Object.fromEntries(
            columns.map((column, index) => [column, row[index]])
        )
    );
}

function recordMissionProgress(
    playerId,
    type,
    amount = 1
) {
    const increment = Number(amount);

    if (
        !Number.isSafeInteger(increment) ||
        increment <= 0
    ) {
        return [];
    }

    if (!getPlayer(playerId)) {
        return [];
    }

    ensurePlayerMissions(playerId);

    db.run("BEGIN TRANSACTION");
    try {
        const completions = applyMissionProgress(playerId, type, increment, Date.now());
        db.run("COMMIT");
        saveDatabase();
        return completions;
    } catch (error) {
        try { db.run("ROLLBACK"); } catch (_) {}
        throw error;
    }
}

// Caller owns the transaction. Never saves or starts a nested transaction.
function applyMissionProgress(playerId, type, increment, now) {
    const completedNow = [];
    const result = db.exec(
        `SELECT
            m.id,
            m.title,
            m.target_amount,
            m.reward,
            pm.progress,
            pm.completed,
            pm.rewarded
         FROM missions m
         INNER JOIN player_missions pm
             ON pm.mission_id = m.id
            AND pm.player_id = ?
         WHERE m.active = 1
           AND m.type = ?`,
        [playerId, type]
    );

    const rows = result.length ? result[0].values : [];

    for (const row of rows) {
        const [
            missionId,
            title,
            targetAmount,
            reward,
            progress,
            completed,
            rewarded
        ] = row;

        if (Number(completed) === 1) {
            continue;
        }

        const nextProgress = Math.min(
            Number(targetAmount),
            Number(progress) + increment
        );

        const isComplete =
            nextProgress >= Number(targetAmount);

        db.run(
            `UPDATE player_missions
             SET progress = ?,
                 completed = ?,
                 completed_at = ?
             WHERE player_id = ?
               AND mission_id = ?
               AND completed = 0`,
            [
                nextProgress,
                isComplete ? 1 : 0,
                isComplete ? now : 0,
                playerId,
                missionId
            ]
        );

        if (
            isComplete &&
            Number(rewarded) === 0
        ) {
            db.run(
                `UPDATE player_missions
                 SET rewarded = 1,
                     rewarded_at = ?
                 WHERE player_id = ?
                   AND mission_id = ?
                   AND completed = 1
                   AND rewarded = 0`,
                [now, playerId, missionId]
            );

            if (db.getRowsModified() !== 1) {
                continue;
            }

            db.run(
                `UPDATE players
                 SET money = money + ?
                 WHERE id = ?`,
                [Number(reward), playerId]
            );

            if (db.getRowsModified() !== 1) {
                throw new Error(
                    "Mission reward player update failed."
                );
            }

            completedNow.push({
                id: missionId,
                title,
                reward: Number(reward)
            });
        }
    }

    return completedNow;
}

function isDefeated(player) {
    return Boolean(player && player.rank !== "KAMIO" &&
        (Number(player.health) <= 0 || Number(player.defeated_until) > 0));
}

// Called by the recovery timer and before commands, including after downtime.
function recoverPlayers(now = Date.now()) {
    const needed = db.exec(`SELECT 1 FROM players
        WHERE (defeated_until > 0 AND (defeated_until <= ? OR rank = 'KAMIO'))
        OR (health <= 0 AND defeated_until = 0 AND rank != 'KAMIO') LIMIT 1`, [now]);
    if (!needed.length) return 0;
    return atomic(() => {
        db.run(`UPDATE players SET health = (SELECT max_hp FROM level_definitions WHERE level = players.level), defeated_until = 0
            WHERE defeated_until > 0 AND (defeated_until <= ? OR rank = 'KAMIO')`, [now]);
        let changed = db.getRowsModified();
        db.run(`UPDATE players SET defeated_until = ?
            WHERE health <= 0 AND defeated_until = 0 AND rank != 'KAMIO'`, [now + RECOVERY_DURATION]);
        changed += db.getRowsModified();
        return changed;
    });
}

function getEquippedWeapon(playerId) {
    const item = getInventory(playerId).find(item =>
        Number(item.equipped) === 1 && Number(item.quantity) > 0 && isWeapon(item.item_id));
    return item ? { ...item, ...getWeaponDefinition(item.item_id) } : null;
}

function getEquippedShield(playerId) {
    const item = getInventory(playerId).find(item =>
        Number(item.equipped) === 1 && Number(item.quantity) > 0 && isShield(item.item_id));
    if (!item) return null;
    const definition = getShieldDefinition(item.item_id);
    return {
        ...item,
        ...definition,
        remaining: item.shield_remaining === null
            ? definition.absorption
            : Math.max(0, Math.min(definition.absorption, Number(item.shield_remaining)))
    };
}

function executeAttack(attackerId, targetId, messageKey) {
    if (!attackerId || !targetId || attackerId === targetId) {
        return { success: false, reason: "INVALID_TARGET" };
    }
    // Fail closed when WhatsApp does not supply an ID suitable for deduplication.
    if (typeof messageKey !== "string" || !messageKey) {
        return { success: false, reason: "MISSING_MESSAGE_ID" };
    }
    const now = Date.now();
    recoverPlayers(now);
    return atomic(() => {
        const reject = (reason, extra = {}) => {
            return { success: false, reason, ...extra };
        };
        const duplicate = db.exec(
            "SELECT 1 FROM processed_attacks WHERE message_key = ?", [messageKey]);
        if (duplicate.length) return reject("DUPLICATE");

        const attacker = getPlayer(attackerId);
        const target = getPlayer(targetId);
        if (!attacker || !target) return reject("PLAYER_NOT_FOUND");
        if (isDefeated(attacker)) {
            return reject("ATTACKER_DEFEATED", { recoveryAt: attacker.defeated_until });
        }
        if (isDefeated(target)) {
            return reject("TARGET_DEFEATED", { recoveryAt: target.defeated_until });
        }
        const attackerIsKamio = attacker.rank === "KAMIO";
        const immune = target.rank === "KAMIO";
        const remainingCooldown = ATTACK_COOLDOWN - (now - Number(attacker.last_attack));
        if (!attackerIsKamio && Number(attacker.last_attack) > 0 && remainingCooldown > 0) {
            return reject("COOLDOWN", { remainingMs: remainingCooldown });
        }

        const weapon = getEquippedWeapon(attackerId);
        const shield = getEquippedShield(targetId);
        const baseDamage = weapon ? weapon.damage : 5;
        const maxHP = getMaxHP(target.level);
        const damage = Math.min(baseDamage, Math.floor(maxHP / 2));
        const shieldAbsorbed = immune ? damage : Math.min(damage, shield?.remaining || 0);
        const shieldRemaining = shield ? shield.remaining - (immune ? 0 : shieldAbsorbed) : 0;
        const oldHealth = Math.max(0, Math.min(maxHP, Number(target.health)));
        const health = immune ? maxHP : Math.max(0, oldHealth - (damage - shieldAbsorbed));
        const healthDamage = immune ? 0 : oldHealth - health;
        const defeated = !immune && health === 0;
        const recoveryAt = defeated ? now + RECOVERY_DURATION : 0;

        if (!attackerIsKamio) {
            db.run("UPDATE players SET last_attack = ? WHERE id = ?", [now, attackerId]);
        }
        if (!immune) {
            db.run("UPDATE players SET health = ?, defeated_until = ? WHERE id = ?",
                [health, recoveryAt, targetId]);
            if (shield) {
                db.run(`UPDATE player_inventory SET shield_remaining = ?
                    WHERE player_id = ? AND item_id = ?`,
                    [shieldRemaining, targetId, shield.item_id]);
            }
        }
        db.run('UPDATE players SET combat_until = MAX(combat_until, ?) WHERE id IN (?,?)',
            [now + COMBAT_DURATION,attackerId,targetId]);
        let missionCompletions = [];
        if (defeated) {
            db.run(`INSERT OR IGNORE INTO player_missions (player_id, mission_id)
                SELECT ?, id FROM missions WHERE active = 1`, [attackerId]);
            missionCompletions = applyMissionProgress(attackerId, "win_attack", 1, now);
        }
        db.run(`INSERT INTO processed_attacks
            (message_key, attacker_id, target_id, processed_at) VALUES (?, ?, ?, ?)`,
            [messageKey, attackerId, targetId, now]);
        return {
            success: true, weapon: weapon?.name || "Unarmed", baseDamage, damage, maxHP,
            shieldAbsorbed, shieldRemaining, healthDamage, health,
            defeated, recoveryAt, immune, missionCompletions,
            shieldDepleted: Boolean(!immune && shield && shield.remaining > 0 && shieldRemaining === 0)
        };
    });
}

function deletePlayer(id) {
    db.run(
        "DELETE FROM player_missions WHERE player_id = ?",
        [id]
    );

    db.run(
        "DELETE FROM players WHERE id = ?",
        [id]
    );

    saveDatabase();
}

module.exports = {
    healPlayer,
    claimWork,
    jobs,
    casino,
    MAX_HEALTH,
    ATTACK_COOLDOWN,
    COMBAT_DURATION,
    RECOVERY_DURATION,
    recoverPlayers,
    isDefeated,
    getEquippedWeapon,
    getEquippedShield,
    executeAttack,
    initDatabase,
    createPlayer,
    getPlayer,
    updatePlayer,
    deletePlayer,

    getRobberyProtection,
    updateRobberyProtection,
    completeRobbery,

    getPlayerMissions,
    recordMissionProgress,

    getInventory,
    getInventoryItem,
    addItem,
    removeItem,
    equipItem,
    unequipItem,
    setEquipped,
    hasItem,
    createItem,
    getItem,
    getMarketItems,
    buyItem
};
