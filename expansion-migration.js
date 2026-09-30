const {EXPANSION_MISSIONS} = require('./missions');
const MIGRATION_ID = 'valkyrie_v1_1_bounties_missions';

// The caller owns the existing atomic transaction and durable snapshot save.
function migrateExpansion(db) {
    if (db.exec('SELECT 1 FROM schema_migrations WHERE id = ?', [MIGRATION_ID]).length) return false;
    db.run(`CREATE TABLE valkyrie_reserve (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        balance INTEGER NOT NULL DEFAULT 0 CHECK(typeof(balance) = 'integer' AND balance BETWEEN 0 AND 9007199254740991)
    );
    INSERT OR IGNORE INTO valkyrie_reserve (id,balance) VALUES (1,0);
    CREATE TABLE bounties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_id TEXT NOT NULL, target_id TEXT NOT NULL,
        creator_identity TEXT NOT NULL, target_identity TEXT NOT NULL,
        creator_name TEXT NOT NULL, target_name TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount BETWEEN 10000 AND 9007199254740991),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','claimed','refunded')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at = created_at + 86400000),
        claimant_id TEXT, attack_message_key TEXT, closed_at INTEGER,
        creation_action_key TEXT NOT NULL UNIQUE,
        CHECK(creator_id != target_id AND creator_identity != target_identity),
        CHECK((status = 'active' AND claimant_id IS NULL AND attack_message_key IS NULL AND closed_at IS NULL)
           OR (status = 'claimed' AND claimant_id IS NOT NULL AND claimant_id != creator_id
               AND attack_message_key IS NOT NULL AND closed_at >= created_at AND closed_at < expires_at)
           OR (status = 'refunded' AND claimant_id IS NULL AND attack_message_key IS NULL AND closed_at >= expires_at))
    );
    CREATE INDEX bounties_expiry ON bounties(status,expires_at);
    CREATE INDEX bounties_target ON bounties(target_id,status,expires_at);
    CREATE INDEX bounties_target_identity ON bounties(target_identity,status,expires_at);
    CREATE INDEX bounties_creator ON bounties(creator_id,created_at);
    CREATE INDEX bounties_claimant ON bounties(claimant_id,closed_at);
    CREATE TABLE bounty_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bounty_id INTEGER NOT NULL REFERENCES bounties(id),
        event_type TEXT NOT NULL CHECK(event_type IN ('created','claimed','expired')),
        actor_id TEXT, recipient_id TEXT,
        amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount BETWEEN 10000 AND 9007199254740991),
        timestamp INTEGER NOT NULL, source_action_key TEXT NOT NULL
    );
    CREATE INDEX bounty_events_bounty ON bounty_events(bounty_id,id);
    CREATE UNIQUE INDEX bounty_events_creation ON bounty_events(bounty_id) WHERE event_type = 'created';
    CREATE UNIQUE INDEX bounty_events_terminal ON bounty_events(bounty_id) WHERE event_type IN ('claimed','refunded');
    CREATE TRIGGER bounty_commitment_immutable BEFORE UPDATE ON bounties
        WHEN OLD.id IS NOT NEW.id OR OLD.creator_id IS NOT NEW.creator_id OR OLD.target_id IS NOT NEW.target_id
          OR OLD.creator_identity IS NOT NEW.creator_identity OR OLD.target_identity IS NOT NEW.target_identity
          OR OLD.creator_name IS NOT NEW.creator_name OR OLD.target_name IS NOT NEW.target_name
          OR OLD.amount IS NOT NEW.amount OR OLD.created_at IS NOT NEW.created_at
          OR OLD.expires_at IS NOT NEW.expires_at OR OLD.creation_action_key IS NOT NEW.creation_action_key
          OR OLD.status != 'active' OR NEW.status NOT IN ('claimed','refunded')
        BEGIN SELECT RAISE(ABORT,'Immutable bounty commitment'); END;
    CREATE TRIGGER bounties_no_delete BEFORE DELETE ON bounties
        BEGIN SELECT RAISE(ABORT,'Bounty history cannot be deleted'); END;
    CREATE TRIGGER bounty_events_no_update BEFORE UPDATE ON bounty_events
        BEGIN SELECT RAISE(ABORT,'Bounty events are append-only'); END;
    CREATE TRIGGER bounty_events_no_delete BEFORE DELETE ON bounty_events
        BEGIN SELECT RAISE(ABORT,'Bounty events are append-only'); END;
    CREATE TRIGGER bounty_event_matches BEFORE INSERT ON bounty_events
        WHEN NOT EXISTS (SELECT 1 FROM bounties WHERE id = NEW.bounty_id AND amount = NEW.amount
            AND ((NEW.event_type = 'created' AND status = 'active')
              OR (NEW.event_type = 'claimed' AND status = 'claimed')
              OR (NEW.event_type = 'expired' AND status = 'refunded')))
        BEGIN SELECT RAISE(ABORT,'Bounty event does not match commitment'); END;
    CREATE TRIGGER bounty_active_player_delete BEFORE DELETE ON players
        WHEN EXISTS (SELECT 1 FROM bounties WHERE status = 'active' AND (creator_id = OLD.id OR target_id = OLD.id))
        BEGIN SELECT RAISE(ABORT,'Player has active bounties'); END;`);
    for (const m of EXPANSION_MISSIONS) {
        db.run(`INSERT OR IGNORE INTO missions
            (id,type,title,description,requirement,target_amount,reward,active) VALUES (?,?,?,?,?,?,?,?)`,
            [m.id,m.type,m.title,m.description,m.requirement,m.targetAmount,m.reward,m.active]);
    }
    db.run('INSERT INTO schema_migrations VALUES (?,?)', [MIGRATION_ID,Date.now()]);
    return true;
}
module.exports = {MIGRATION_ID,migrateExpansion};
