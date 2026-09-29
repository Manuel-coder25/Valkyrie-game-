const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname,'..'), original = fs.readFileSync(path.join(root,'game.db'));
const cwd = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(),'valkyrie-core-'));
process.chdir(temp);
const d = require(path.join(root,'database'));
const p = require(path.join(root,'progression'));
const {WEAPON_CATALOGUE} = require(path.join(root,'weapons'));
const {medicPrice,medkitHealing} = require(path.join(root,'healing'));
const {migrateCore,MIGRATION_ID} = require(path.join(root,'core-migration'));
let SQL, time = Date.now(); const realNow = Date.now; Date.now = () => time;
const rows = (db,sql,params=[]) => { const r=db.exec(sql,params)[0]; return r ? r.values.map(v=>Object.fromEntries(r.columns.map((c,i)=>[c,v[i]]))) : []; };
function copyDb() { return new SQL.Database(fs.readFileSync('game.db')); }
function fixture(sql,params=[]) { const db=copyDb(); db.run(sql,params); fs.writeFileSync('game.db',db.export()); db.close(); }
function player(id,level=1,health=p.getMaxHP(level)) {
    d.createPlayer(id,id); d.updatePlayer(id,{level,health,money:100000000}); return d.getPlayer(id);
}
function failSave(operation, watched) {
    const bytes=fs.readFileSync('game.db'), before=watched();
    const rename=fs.renameSync;
    fs.renameSync=()=>{throw new Error('injected durable failure');};
    try { assert.throws(operation,/injected durable failure/); } finally { fs.renameSync=rename; }
    assert.deepEqual(watched(),before,'in-memory state must roll back');
    assert(fs.readFileSync('game.db').equals(bytes),'durable file must remain unchanged');
}
(async()=>{
    SQL=await require('sql.js')();
    assert.equal(p.LEVELS.length,50); assert.equal(new Set(p.LEVELS.map(l=>l.rank)).size,50);
    assert.equal(p.getMaxHP(1),100); assert.equal(p.getMaxHP(50),500);
    for(const l of p.LEVELS) {
        assert.equal(p.getRank(l.level),l.rank);
        if(l.level>1) assert(l.maxHP>p.getMaxHP(l.level-1));
        if(l.level<50) {
            const before=p.addXP(l.level,l.xp-1,0); assert.equal(before.level,l.level);
            const after=p.addXP(l.level,l.xp-1,1); assert.equal(after.level,l.level+1); assert.equal(after.xp,0);
            if(l.level>1) assert(l.xp>p.getNextLevelXP(l.level-1));
        }
    }
    assert.equal(p.getNextLevelXP(50),null);
    assert.equal(p.addXP(49,0,1000000000000).level,50);
    assert.deepEqual([p.addXP(50,900,1000).level,p.addXP(50,900,1000).xp],[50,1900]);
    assert.throws(()=>p.addXP(51,0,1),/Level/);
    assert.throws(()=>p.addXP(50,Number.MAX_SAFE_INTEGER,1),/XP/);
    assert.equal(p.LEVELS.reduce((n,l)=>n+(l.xp||0),0),3170300);
    console.log('PASS all 50 HP/XP/rank rows, strict HP growth, boundary levels, overflow and level-51 rejection');

    // Actual production snapshot, only in memory and a disposable directory.
    const legacy=new SQL.Database(Uint8Array.from(original));
    const beforePlayers=rows(legacy,'SELECT * FROM players ORDER BY id');
    const beforeInventory=rows(legacy,'SELECT * FROM player_inventory ORDER BY player_id,item_id');
    const beforeHistory=rows(legacy,'SELECT * FROM casino_history ORDER BY id');
    const beforeStats=rows(legacy,'SELECT * FROM casino_stats ORDER BY player_id');
    const beforeItems=rows(legacy,'SELECT * FROM items ORDER BY id');
    legacy.run('BEGIN'); assert.equal(migrateCore(legacy),true); legacy.run('COMMIT');
    const migrated=rows(legacy,'SELECT * FROM players ORDER BY id');
    assert.equal(migrated.length,beforePlayers.length);
    for(let i=0;i<migrated.length;i++) {
        const {combat_until,health,...kept}=migrated[i]; const {health:oldHP,...old}=beforePlayers[i];
        assert.deepEqual(kept,old); assert.equal(health,p.getMaxHP(old.level));
    }
    assert.deepEqual(rows(legacy,'SELECT * FROM player_inventory ORDER BY player_id,item_id'),beforeInventory);
    assert.deepEqual(rows(legacy,'SELECT * FROM casino_history ORDER BY id'),beforeHistory);
    assert.deepEqual(rows(legacy,'SELECT * FROM casino_stats ORDER BY player_id'),beforeStats);
    for(const item of beforeItems) {
        const after=rows(legacy,'SELECT * FROM items WHERE id=?',[item.id])[0];
        if(item.id==='inventory_test_item') { assert.equal(after,undefined); continue; }
        assert(after);
        if(!['market_test_item','valkyrie_executioner','aegis_shield'].includes(item.id)) assert.deepEqual(after,item);
    }
    assert.equal(rows(legacy,"SELECT price FROM items WHERE id='market_test_item'")[0].price,0);
    assert.equal(rows(legacy,"SELECT count(*) n FROM player_inventory WHERE item_id='market_test_item'")[0].n,2);
    const idempotent=legacy.export(); assert.equal(migrateCore(legacy),false); assert(Buffer.from(legacy.export()).equals(Buffer.from(idempotent)));
    assert.equal(rows(legacy,'SELECT count(*) n FROM schema_migrations WHERE id=?',[MIGRATION_ID])[0].n,1);
    assert.throws(()=>legacy.run('UPDATE players SET level=51'),/Level/);
    fs.writeFileSync('game.db',legacy.export()); legacy.close();
    await d.initDatabase();
    assert.equal(d.getItem('valkyrie_executioner').price,1000000);
    assert.equal(d.getItem('aegis_shield').price,250000);
    assert.equal(d.getItem('medkit').price,2500);
    assert(!d.getMarketItems().some(i=>i.id.includes('test_item')));
    assert.equal(d.buyItem(beforePlayers[0].id,'market_test_item').reason,'ITEM_NOT_FOUND');
    assert.equal(new Set(d.getMarketItems().map(i=>i.id)).size,d.getMarketItems().length);
    assert(!Object.keys(WEAPON_CATALOGUE).some(id=>/apocalypse|valkyrie_prime|godslayer/.test(id)));
    console.log('PASS production-copy migration preserves every player field except HP/combat lock, every inventory row, roles, equipment, Aegis, history and stats; idempotent catalogue cleanup');

    // Synthetic legacy grandfathering, an owned temporary item, and selective game cleanup.
    const synthetic=new SQL.Database(Uint8Array.from(original));
    synthetic.run("INSERT INTO players (id,name,level,xp,money,bank,health) VALUES ('grandfather','Grandfather',20,777,123456,654321,30)");
    synthetic.run("INSERT INTO player_inventory (player_id,item_id,quantity) VALUES ('grandfather','inventory_test_item',1)");
    synthetic.run("INSERT INTO casino_history (player_id,game,wager,outcome,payout,net,created_at) VALUES ('grandfather','slots',100,'{}',700,600,1)");
    synthetic.run("INSERT INTO casino_history (player_id,game,wager,outcome,payout,net,created_at) VALUES ('grandfather','coinflip',100,'{}',200,100,2)");
    synthetic.run("INSERT INTO casino_actions VALUES ('grandfather','old','{\"game\":\"slots\"}',1)");
    synthetic.run("INSERT INTO casino_actions VALUES ('grandfather','keep','{\"game\":\"coinflip\"}',2)");
    synthetic.run("INSERT INTO casino_cooldowns VALUES ('grandfather','slots',123)");
    const snapshot=synthetic.export();
    synthetic.run(`CREATE TRIGGER fail_migration BEFORE UPDATE OF health ON players BEGIN SELECT RAISE(ABORT,'migration failure'); END;`);
    synthetic.run('BEGIN'); assert.throws(()=>migrateCore(synthetic),/migration failure/); synthetic.run('ROLLBACK');
    assert.equal(rows(synthetic,"SELECT count(*) n FROM sqlite_master WHERE name='schema_migrations'")[0].n,0);
    assert.equal(rows(synthetic,"SELECT health FROM players WHERE id='grandfather'")[0].health,30);
    synthetic.close();
    const retry=new SQL.Database(snapshot); retry.run('BEGIN');migrateCore(retry);retry.run('COMMIT');
    const gp=rows(retry,"SELECT * FROM players WHERE id='grandfather'")[0];
    assert.deepEqual([gp.level,gp.xp,gp.money,gp.bank,gp.health],[20,777,123456,654321,255]);
    assert(rows(retry,"SELECT * FROM items WHERE id='inventory_test_item'").length,'unexpected ownership prevents deletion');
    assert.equal(rows(retry,"SELECT * FROM casino_history WHERE game='slots'").length,0);
    assert.equal(rows(retry,"SELECT * FROM casino_actions WHERE action_id='old'").length,0);
    assert.equal(rows(retry,"SELECT * FROM casino_actions WHERE action_id='keep'").length,1);
    assert.equal(rows(retry,"SELECT net FROM casino_stats WHERE player_id='grandfather'")[0].net,100);
    retry.close();
    console.log('PASS level-20 grandfathering, migration rollback/retry, owned-item guard and Slots-only cleanup/stat rebuilding');

    player('level',1,60); d.updatePlayer('level',{level:2}); assert.equal(d.getPlayer('level').health,60);
    d.updatePlayer('level',{health:999}); assert.equal(d.getPlayer('level').health,108);
    d.updatePlayer('level',{level:1}); assert.equal(d.getPlayer('level').health,100);
    d.updatePlayer('level',{health:60,xp:499});
    const work=d.claimWork('level','level-up'); assert.equal(work.progression.level,2); assert.equal(d.getPlayer('level').health,60);
    await d.initDatabase(); assert.equal(d.getPlayer('level').health,60,'migration must never reheal on restart');
    assert(d.claimWork('level','level-up').duplicate);
    for(const level of [1,2,25,49,50]) {
        player('hp-'+level,level,1); assert.equal(d.getPlayer('hp-'+level).maxHP,p.getMaxHP(level));
        d.updatePlayer('hp-'+level,{health:9999}); assert.equal(d.getPlayer('hp-'+level).health,p.getMaxHP(level));
    }
    assert.throws(()=>d.updatePlayer('level',{level:51}),/Level/);
    console.log('PASS persisted HP ceiling, no level-up healing, work deduplication and migration one-time healing');

    const expectedDamage={unarmed:5,pocket_knife:10,combat_knife:15,hatchet:20,pistol:25,revolver:30,smg:35,shotgun:45,assault_rifle:55,sniper:70,valkyrie_executioner:150,reaper:180,dominator:220,warhammer:275};
    for(const level of [1,50]) for(const [id,base] of Object.entries(expectedDamage)) {
        const attacker=`${level}-${id}`,target=`target-${attacker}`;player(attacker);player(target,level);
        if(id!=='unarmed') { d.addItem(attacker,id,WEAPON_CATALOGUE[id].stackable?7:1);d.equipItem(attacker,id); }
        const r=d.executeAttack(attacker,target,attacker);
        assert.equal(r.baseDamage,base);assert.equal(r.damage,Math.min(base,Math.floor(p.getMaxHP(level)/2)));
        assert.equal(r.health,p.getMaxHP(level)-r.damage);
        assert.equal(d.executeAttack(attacker,target,attacker).reason,'DUPLICATE');
        assert.equal(d.executeAttack(attacker,target,attacker+'again').reason,'COOLDOWN');
        d.updatePlayer(attacker,{health:50}); d.addItem(attacker,'medkit'); d.addItem(target,'medkit');
        for(const who of [attacker,target]) for(const kind of ['medkit','medic']) assert.equal(d.healPlayer(who,kind,1).reason,'COMBAT');
    }
    player('shield-attacker');player('shield-target');d.addItem('shield-attacker','warhammer');d.equipItem('shield-attacker','warhammer');
    d.addItem('shield-target','light_shield');d.equipItem('shield-target','light_shield');
    let hit=d.executeAttack('shield-attacker','shield-target','shield1');assert.equal(hit.shieldAbsorbed,25);assert.equal(hit.health,75);
    assert.equal(hit.shieldRemaining,0);time+=30001;
    d.equipItem('shield-target','light_shield');await d.initDatabase();assert.equal(d.getEquippedShield('shield-target').remaining,0);
    hit=d.executeAttack('shield-attacker','shield-target','shield2');assert.equal(hit.health,25);time+=30001;
    hit=d.executeAttack('shield-attacker','shield-target','shield3');assert(hit.defeated);
    for(const kind of ['medkit','medic']) assert.equal(d.healPlayer('shield-target',kind).reason,'DEFEATED');
    assert.equal(d.executeAttack('shield-target','shield-attacker','deadattack').reason,'ATTACKER_DEFEATED');
    assert.equal(d.executeAttack('shield-attacker','shield-target','deadtarget').reason,'TARGET_DEFEATED');
    time+=d.RECOVERY_DURATION+1;d.recoverPlayers();assert.equal(d.getPlayer('shield-target').health,100);
    player('immune',50);d.updatePlayer('immune',{rank:'KAMIO'});hit=d.executeAttack('shield-attacker','immune','immune1');
    assert(hit.immune);assert.equal(hit.healthDamage,0);assert.equal(d.getPlayer('immune').health,500);
    d.updatePlayer('shield-attacker',{rank:'KAMIO'});
    assert(d.executeAttack('shield-attacker','immune','immune2').success);
    assert(d.executeAttack('shield-attacker','immune','immune3').success);
    assert.equal(d.executeAttack('shield-attacker','immune','immune3').reason,'DUPLICATE');
    console.log('PASS every weapon/unarmed at levels 1/50, quantity independence, damage cap, shields/depletion, cooldowns, duplicate attacks, defeat/recovery and KAMIO');

    time+=30001;player('healer',50,200);d.addItem('healer','medkit',3);d.addItem('healer','medkit',2);
    assert.equal(d.getInventoryItem('healer','medkit').quantity,5);
    const concurrent=await Promise.all([1,2].map(i=>Promise.resolve().then(()=>d.healPlayer('healer','medkit',30,'heal-'+i))));
    assert.equal(concurrent.filter(r=>r.success).length,1);assert.equal(d.getPlayer('healer').health,450);
    assert.equal(d.getInventoryItem('healer','medkit'),null);assert.equal(concurrent[1].reason,'NO_MEDKITS');
    d.addItem('healer','medkit',30);const top=d.healPlayer('healer','medkit',30,'top');assert.equal(top.used,1);assert.equal(top.health,500);
    assert.equal(d.getInventoryItem('healer','medkit').quantity,29);
    assert.equal(d.healPlayer('healer','medkit',30,'full').reason,'FULL_HP');assert.equal(d.healPlayer('healer','medic',1,'full2').reason,'FULL_HP');
    assert(d.healPlayer('healer','medkit',30,'top').duplicate);assert.equal(d.getInventoryItem('healer','medkit').quantity,29);
    d.updatePlayer('healer',{health:499});assert.equal(d.healPlayer('healer','medkit',1,'last').healed,1);
    d.updatePlayer('healer',{health:100});for(const invalid of [0,-1,'1.5','1e2','NaN',Infinity]) assert.equal(d.healPlayer('healer','medkit',invalid).reason,'INVALID_AMOUNT');
    const beforeCash=d.getPlayer('healer').money;const med=d.healPlayer('healer','medic',1,'med');assert.equal(med.cost,40000);assert.equal(med.health,500);
    assert.equal(d.getPlayer('healer').money,beforeCash-40000);assert(d.healPlayer('healer','medic',1,'med').duplicate);
    d.updatePlayer('healer',{health:100,money:0});assert.equal(d.healPlayer('healer','medic').reason,'INSUFFICIENT_FUNDS');assert.equal(d.getPlayer('healer').health,100);
    assert.equal(medicPrice(1,50),7850);assert.equal(medicPrice(25,148),16250);assert.equal(medicPrice(50,250),25000);
    assert.equal(medkitHealing(1),10);assert.equal(medkitHealing(50),50);assert.equal(medkitHealing(2),10);
    d.updatePlayer('healer',{money:1000000});
    for(const kind of ['medkit','medic']) {
        failSave(()=>d.healPlayer('healer',kind,1,'rollback-'+kind),()=>[d.getPlayer('healer'),d.getInventory('healer'),d.getPlayerMissions('healer')]);
        assert(d.healPlayer('healer',kind,1,'rollback-'+kind).success);d.updatePlayer('healer',{health:100});
    }
    fixture(`CREATE TRIGGER prevent_heal BEFORE UPDATE OF health ON players WHEN NEW.id='healer'
        BEGIN SELECT RAISE(ABORT,'health failure'); END;`);await d.initDatabase();
    const inv=d.getInventory('healer'),money=d.getPlayer('healer').money;
    assert.throws(()=>d.healPlayer('healer','medkit',1,'sql-kit'),/health failure/);
    assert.throws(()=>d.healPlayer('healer','medic',1,'sql-medic'),/health failure/);
    assert.deepEqual(d.getInventory('healer'),inv);assert.equal(d.getPlayer('healer').money,money);
    fixture('DROP TRIGGER prevent_heal');await d.initDatabase();
    console.log('PASS Medkit stacking, partial availability, exact consumption, full HP, cap, duplicate/rapid commands, Medic pricing, insufficient cash and SQL/durable rollback');

    player('buyer');
    const watchBuyer=()=>[d.getPlayer('buyer'),d.getInventory('buyer'),d.getPlayerMissions('buyer')];
    failSave(()=>d.buyItem('buyer','reaper',1,'buy-fail'),watchBuyer);
    const bought=d.buyItem('buyer','reaper',1,'buy-fail');assert(bought.success);assert(d.buyItem('buyer','reaper',1,'buy-fail').duplicate);
    assert.equal(d.buyItem('buyer','reaper').reason,'ITEM_NOT_STACKABLE');assert.throws(()=>d.addItem('buyer','reaper'),/Maximum/);
    failSave(()=>d.equipItem('buyer','reaper','equip-fail'),watchBuyer);assert(d.equipItem('buyer','reaper','equip-fail').success);
    failSave(()=>d.unequipItem('buyer','reaper','unequip-fail'),watchBuyer);assert(d.unequipItem('buyer','reaper','unequip-fail').success);
    const two=await Promise.all([1,2].map(i=>Promise.resolve().then(()=>d.buyItem('buyer','warhammer',1,'war-'+i))));assert.equal(two.filter(r=>r.success).length,1);
    const cash=d.getPlayer('buyer').money;
    const kits=await Promise.all([1,2].map(()=>Promise.resolve().then(()=>d.buyItem('buyer','medkit',30,'buy-duplicate'))));assert(kits[1].duplicate);
    assert.equal(d.getInventoryItem('buyer','medkit').quantity,30);assert.equal(d.getPlayer('buyer').money,cash-75000);
    player('rollback-attacker');player('rollback-target',50);d.addItem('rollback-target','light_shield');d.equipItem('rollback-target','light_shield');
    const watchCombat=()=>[d.getPlayer('rollback-attacker'),d.getPlayer('rollback-target'),d.getInventory('rollback-target')];
    failSave(()=>d.executeAttack('rollback-attacker','rollback-target','attack-fail'),watchCombat);
    assert(d.executeAttack('rollback-attacker','rollback-target','attack-fail').success);
    player('worker');failSave(()=>d.claimWork('worker','work-fail'),()=>d.getPlayer('worker'));
    assert(d.claimWork('worker','work-fail').success);
    await d.initDatabase();assert(d.buyItem('buyer','medkit',30,'buy-duplicate').duplicate);assert(d.claimWork('worker','work-fail').duplicate);
    player('reward-attacker');player('reward-target',50,25);
    d.addItem('reward-attacker','reaper');d.equipItem('reward-attacker','reaper');
    const watchReward=()=>[d.getPlayer('reward-attacker'),d.getPlayer('reward-target'),d.getPlayerMissions('reward-attacker')];
    failSave(()=>d.executeAttack('reward-attacker','reward-target','reward-fail'),watchReward);
    const rewardCash=d.getPlayer('reward-attacker').money;
    assert(d.executeAttack('reward-attacker','reward-target','reward-fail').defeated);
    assert.equal(d.getPlayer('reward-attacker').money,rewardCash+1500);
    assert.equal(d.executeAttack('reward-attacker','reward-target','reward-fail').reason,'DUPLICATE');
    assert.equal(d.getPlayer('reward-attacker').money,rewardCash+1500);
    time+=d.RECOVERY_DURATION+1;
    failSave(()=>d.recoverPlayers(),()=>d.getPlayer('reward-target'));
    d.recoverPlayers();assert.equal(d.getPlayer('reward-target').health,500);
    fixture(`CREATE TRIGGER prevent_purchase BEFORE INSERT ON player_inventory WHEN NEW.player_id='buyer'
        BEGIN SELECT RAISE(ABORT,'inventory failure'); END;`);await d.initDatabase();
    const purchaseBefore=watchBuyer();
    assert.throws(()=>d.buyItem('buyer','smg',1,'sql-buy'),/inventory failure/);assert.deepEqual(watchBuyer(),purchaseBefore);
    fixture('DROP TRIGGER prevent_purchase');await d.initDatabase();assert(d.buyItem('buyer','smg',1,'sql-buy').success);
    console.log('PASS combat mission reward and level-50 recovery rollback/retry, duplicate reward prevention, purchase SQL rollback');
    console.log('PASS purchase/equip/unequip/combat/work save rollback, retry, purchase caps, concurrent purchases and restart deduplication');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
    Date.now=realNow;process.chdir(cwd);assert(fs.readFileSync(path.join(root,'game.db')).equals(original));
    fs.rmSync(temp,{recursive:true,force:true});console.log('PASS production game.db unchanged');
});
