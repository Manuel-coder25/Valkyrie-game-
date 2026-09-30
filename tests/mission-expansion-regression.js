const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {fixture} = require('./expansion-fixture');
fixture(async ({d,SQL,rows,edit,player,failSave,root,advance}) => {
    const expected = [
        ['work_25','Honest Hustle','complete_work',25,1000], ['work_100','Clockwork','complete_work',100,3000],
        ['jobs_25','Reliable Worker','complete_job',25,2000], ['jobs_100','Career Builder','complete_job',100,5000],
        ['combat_5','Proven Fighter','win_attack',5,3000], ['combat_20','Arena Regular','win_attack',20,8000],
        ['robbery_5','Repeat Offender','complete_robbery',5,2000], ['robbery_20','Notorious','complete_robbery',20,6000],
        ['purchase_10','Stocking Up','buy_item',10,1000], ['purchase_50','Well Supplied','buy_item',50,3000],
        ['medkits_10','Field Recovery','use_item',10,1000], ['medic_5','Regular Patient','use_medic',5,1500],
        ['casino_25','Table Regular','play_casino',25,500]
    ];
    for (const [id,title,type,target,reward] of expected) {
        assert.deepEqual(rows('SELECT id,title,type,target_amount,reward FROM missions WHERE id=?',[id])[0],
            {id,title,type,target_amount:target,reward});
    }
    assert.equal(expected.reduce((n,m)=>n+m[4],0),37000);
    assert.equal(rows("SELECT count(*) n FROM missions WHERE type LIKE '%bounty%'")[0].n,0);
    assert.equal(rows('SELECT count(*) n FROM missions')[0].n,18);
    for (const id of ['worker','jobber','fighter','victim','buyer','kit','medic','gambler']) player(id);
    // Near-completion fixtures exercise actual action hooks, not manual reward helpers.
    await edit(`UPDATE player_missions SET progress = (SELECT target_amount - 1 FROM missions WHERE id=mission_id)
        WHERE (player_id='worker' AND mission_id IN ('work_25','work_100'))
           OR (player_id='jobber' AND mission_id IN ('jobs_25','jobs_100'))
           OR (player_id='fighter' AND mission_id IN ('combat_5','combat_20'))
           OR (player_id='buyer' AND mission_id IN ('purchase_10','purchase_50'))
           OR (player_id='kit' AND mission_id='medkits_10')
           OR (player_id='medic' AND mission_id='medic_5')
           OR (player_id='gambler' AND mission_id='casino_25')`);
    const state = id => [d.getPlayer(id),d.getPlayerMissions(id)];
    const assertPaid = (id,type,ids) => {
        const missions = d.getPlayerMissions(id);
        for (const name of ids) {
            const m = missions.find(m=>m.id===name);
            assert.equal(m.progress,m.target_amount); assert.equal(m.completed,1); assert.equal(m.rewarded,1);
        }
        assert(missions.filter(m=>m.type!==type).every(m=>m.progress===0),'mission isolation');
    };
    failSave(()=>d.claimWork('worker','work'),()=>state('worker'));
    let before = d.getPlayer('worker').money;
    const work = d.claimWork('worker','work'); assert.equal(d.getPlayer('worker').money,before+work.payout+4000);
    assertPaid('worker','complete_work',['work_25','work_100']);
    assert(d.claimWork('worker','work').duplicate); assert.equal(d.claimWork('worker','cooldown').reason,'COOLDOWN');
    advance(10001); const work2=d.claimWork('worker','work2'); assert.equal(work2.missionCompletions.length,0);
    before=d.getPlayer('jobber').money;
    failSave(()=>d.jobs.claim('jobber','delivery','job'),()=>state('jobber'));
    const job=d.jobs.claim('jobber','delivery','job'); assert.equal(d.getPlayer('jobber').money,before+job.payout+7000);
    assertPaid('jobber','complete_job',['jobs_25','jobs_100']);
    assert.equal(d.jobs.claim('jobber','delivery','job').reason,'DUPLICATE');
    assert.equal(d.jobs.claim('jobber','delivery','job2').reason,'COOLDOWN');
    assert.equal(d.jobs.claim('jobber','technician','locked').reason,'LEVEL');
    d.updatePlayer('victim',{health:5}); before=d.getPlayer('fighter').money;
    failSave(()=>d.executeAttack('fighter','victim','kill'),()=>[...state('fighter'),d.getPlayer('victim')]);
    assert(d.executeAttack('fighter','victim','kill').defeated);
    assert.equal(d.getPlayer('fighter').money,before+12500);
    assertPaid('fighter','win_attack',['combat_5','combat_20']);
    assert.equal(d.executeAttack('fighter','victim','kill').reason,'DUPLICATE');
    before=d.getPlayer('buyer').money;
    failSave(()=>d.buyItem('buyer','medkit',3,'buy'),()=>[...state('buyer'),d.getInventory('buyer')]);
    assert(d.buyItem('buyer','medkit',3,'buy').success);
    assert.equal(d.getPlayer('buyer').money,before-7500+4500);
    assertPaid('buyer','buy_item',['purchase_10','purchase_50']);
    assert(d.buyItem('buyer','medkit',3,'buy').duplicate);
    assert.equal(d.buyItem('buyer','missing',1,'bad-buy').reason,'ITEM_NOT_FOUND');
    d.addItem('kit','medkit',10); d.updatePlayer('kit',{health:1}); before=d.getPlayer('kit').money;
    failSave(()=>d.healPlayer('kit','medkit',10,'kits'),()=>[...state('kit'),d.getInventory('kit')]);
    const kits=d.healPlayer('kit','medkit',10,'kits'); assert.equal(kits.used,10);
    assert.equal(d.getPlayer('kit').money,before+1300); assertPaid('kit','use_item',['medkits_10']);
    assert(d.healPlayer('kit','medkit',10,'kits').duplicate);
    assert.equal(d.healPlayer('kit','medkit',1,'full').reason,'FULL_HP');
    assert.equal(d.healPlayer('medic','medic',1,'full').reason,'FULL_HP');
    await edit("UPDATE players SET health=50,combat_until=? WHERE id='medic'",[Date.now()+1000]);
    assert.equal(d.healPlayer('medic','medic',1,'locked').reason,'COMBAT');
    await edit("UPDATE players SET defeated_until=? WHERE id='medic'",[Date.now()+1000]);
    assert.equal(d.healPlayer('medic','medic',1,'dead').reason,'DEFEATED');
    await edit("UPDATE players SET defeated_until=0,combat_until=0 WHERE id='medic'"); before=d.getPlayer('medic').money;
    failSave(()=>d.healPlayer('medic','medic',1,'medic'),()=>state('medic'));
    const medic=d.healPlayer('medic','medic',1,'medic'); assert.equal(d.getPlayer('medic').money,before-medic.cost+1500);
    assertPaid('medic','use_medic',['medic_5']); assert(d.healPlayer('medic','medic',1,'medic').duplicate);
    before=d.getPlayer('gambler').money;
    failSave(()=>d.casino.play('gambler','coinflip',100,'heads','round'),()=>state('gambler'));
    const round=d.casino.play('gambler','coinflip',100,'heads','round'); assert(round.success);
    assert.equal(d.getPlayer('gambler').money,before-100+round.payout+500);
    assertPaid('gambler','play_casino',['casino_25']); assert(d.casino.play('gambler','coinflip',100,'heads','round').duplicate);
    assert.equal(d.casino.play('gambler','coinflip',100,'heads','round2').success,false);
    const saved = ['worker','jobber','fighter','buyer','kit','medic','gambler'].map(state);
    await d.initDatabase();
    assert.deepEqual(['worker','jobber','fighter','buyer','kit','medic','gambler'].map(state),saved);
    console.log('PASS mission definitions, actual work/job/combat/purchase/healing/casino hooks, capped one-time rewards, rejection/isolation, save rollback and restart');

    // Apply only the new migration to a production snapshot in memory.
    const {migrateExpansion,MIGRATION_ID}=require('../expansion-migration');
    const old = new SQL.Database(fs.readFileSync(path.join(root,'game.db')));
    try {
        const tables = old.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0].values.flat();
        const preserved = tables.filter(t=>!['missions','schema_migrations'].includes(t));
        const snapshot = () => preserved.map(t=>old.exec('SELECT * FROM "'+t+'" ORDER BY rowid'));
        const baseline=snapshot(), oldMissions=old.exec('SELECT * FROM missions ORDER BY id')[0];
        old.run('BEGIN'); assert(migrateExpansion(old)); old.run('ROLLBACK');
        assert.equal(old.exec("SELECT 1 FROM sqlite_master WHERE name='bounties'").length,0);
        old.run('BEGIN'); assert(migrateExpansion(old)); old.run('COMMIT');
        assert.deepEqual(snapshot(),baseline);
        for (const row of oldMissions.values) assert.deepEqual(old.exec('SELECT * FROM missions WHERE id=?',[row[0]])[0].values[0],row);
        const migrated=Buffer.from(old.export()); assert.equal(migrateExpansion(old),false);
        assert(Buffer.from(old.export()).equals(migrated));
        assert.equal(old.exec('SELECT count(*) FROM schema_migrations WHERE id=?',[MIGRATION_ID])[0].values[0][0],1);
        assert.equal(old.exec('SELECT count(*) FROM missions')[0].values[0][0],oldMissions.values.length+13);
    } finally {old.close();}
    console.log('PASS additive migration rollback, idempotence and preservation of all existing production-copy state');
}).catch(error=>{console.error(error);process.exitCode=1;});
