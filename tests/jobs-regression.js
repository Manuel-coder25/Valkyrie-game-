const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), original = fs.readFileSync(path.join(root,'game.db'));
const cwd = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(),'jobs-unit-'));
process.chdir(temp);
const d = require(path.join(root,'database'));
const {createJobs, JOBS} = require(path.join(root,'jobs'));
let db;
(async () => {
    await d.initDatabase(); d.createPlayer('test','Test');
    const SQL = await require('sql.js')();
    db = new SQL.Database(fs.readFileSync('game.db'));
    db.run('UPDATE players SET level = 6');
    let time = 100000, draw = 0, failSave = false;
    const jobs = createJobs({getDb:()=>db, now:()=>time, random:()=>draw,
        save:()=>{if(failSave) throw new Error('disk failure');},
        restore:bytes=>{db.close();db=new SQL.Database(bytes);}});
    const player = () => db.exec('SELECT money, xp, level FROM players')[0].values[0];
    for(const job of JOBS) {
        draw=0;
        assert.equal(jobs.claim('test',job.id,job.id+'min').payout,job.min);
        time+=job.cooldown;
        draw=job.max-job.min;
        assert.equal(jobs.claim('test',job.id,job.id+'max').payout,job.max);
    }
    time+=180000;
    const before=player(), count=jobs.history('test').length;
    draw=-1;
    assert.throws(()=>jobs.claim('test','delivery','retry'),/Invalid random/);
    assert.deepEqual(player(),before); assert.equal(jobs.history('test').length,count);
    draw=0;failSave=true;
    assert.throws(()=>jobs.claim('test','delivery','retry'),/disk failure/);
    assert.deepEqual(player(),before); assert.equal(jobs.history('test').length,count);
    failSave=false;
    assert(jobs.claim('test','delivery','retry').success);
    assert.equal(jobs.claim('missing','delivery','missing').reason,'REGISTER_FIRST');
    assert.equal(jobs.claim('test','delivery','').reason,'MISSING_MESSAGE_ID');
    db.close(); db=null;
    // Exercise the real adapter and mission helper on this temporary database.
    const fixture=new SQL.Database(fs.readFileSync('game.db'));
    fixture.run("INSERT INTO missions (id,type,title,description,requirement,target_amount,reward,active) VALUES ('job_test','complete_job','Job Test','Shift','One shift',1,123,1)");
    fs.writeFileSync('game.db',fixture.export());fixture.close();
    await d.initDatabase();
    const money=d.getPlayer('test').money;
    const r=d.jobs.claim('test','delivery','mission');
    assert.equal(r.missionCompletions.length,1);
    assert.equal(d.getPlayer('test').money,money+r.payout+123);
    assert.equal(d.jobs.claim('test','delivery','mission').reason,'DUPLICATE');
    const missions=d.getPlayerMissions('test');
    assert.equal(missions.find(m=>m.id==='job_test').progress,1);
    assert(missions.filter(m=>m.type!=='complete_job').every(m=>m.progress===0));
    for (const id of ['jobs_25','jobs_100']) assert.equal(missions.find(m=>m.id===id).progress,1);
    console.log('PASS Jobs exact min/max payouts, RNG rollback, save rollback/retry, registration, missing ID, atomic mission reward and mission isolation');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
    if(db)db.close();process.chdir(cwd);
    assert(fs.readFileSync(path.join(root,'game.db')).equals(original));
    fs.rmSync(temp,{recursive:true,force:true});
    console.log('PASS production game.db unchanged');
});
