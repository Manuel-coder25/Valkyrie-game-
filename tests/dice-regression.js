const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'),original=fs.readFileSync(path.join(root,'game.db'));
const cwd=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'valkyrie-dice-'));process.chdir(temp);
const {dicePayout,createCasino,COOLDOWNS}=require(path.join(root,'casino'));
const {casinoCommand,COMMANDS,HELP}=require(path.join(root,'casino-commands'));
const d=require(path.join(root,'database'));
let db,SQL,time=100000,draw=0,fail=false,casino;
const rows=(sql,params=[])=>db.exec(sql,params)[0]?.values||[];
function create(){casino=createCasino({getDb:()=>db,now:()=>time,random:n=>{assert.equal(n,6);return draw;},
    save:()=>{if(fail)throw new Error('disk failure');fs.writeFileSync('dice.db',db.export());},
    restore:bytes=>{db.close();db=new SQL.Database(bytes);}});}
(async()=>{
    assert.deepEqual([1,2,3,4,5,6].map(f=>dicePayout(100,f)),[0,0,100,100,150,220]);
    assert.equal(COOLDOWNS.dice,5000);assert(!COMMANDS.has('slots'));assert(!HELP.toLowerCase().includes('slots'));
    assert(COMMANDS.has('dice'));assert.equal(COOLDOWNS.slots,undefined);
    for(let bet=100;bet<=100000;bet++) {
        const total=[1,2,3,4,5,6].reduce((sum,face)=>sum+dicePayout(bet,face),0);
        assert(total*100<=bet*6*95,'flooring must never exceed theoretical 95% return');
    }
    // Reproducible PRNG with rejection sampling, so mapping uint32 to six faces
    // introduces no modulo bias. Uses the production payout function unchanged.
    let seed=0x6d2b79f5;const counts=[0,0,0,0,0,0];let returned100=0,returned101=0;
    for(let i=0;i<1000000;i++) {
        let value;
        do { seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;value=seed>>>0; } while(value>=4294967292);
        const face=value%6+1;counts[face-1]++;returned100+=dicePayout(100,face);returned101+=dicePayout(101,face);
    }
    const observed=returned100/100000000,roundedObserved=returned101/101000000;
    const roundedTheory=[1,2,3,4,5,6].reduce((n,f)=>n+dicePayout(101,f),0)/606;
    assert(Math.abs(observed-.95)<.003);assert(Math.abs(roundedObserved-roundedTheory)<.003);
    assert(observed<1);assert(roundedObserved<1);
    console.log('PASS 1,000,000 rolls:',JSON.stringify({counts,observed,roundedObserved,roundedTheory,tolerance:0.003}));
    console.log('PASS exact payouts and every integer wager $100–$100,000 has expected return <=95%');
    await d.initDatabase();d.createPlayer('dice','Dice');d.updatePlayer('dice',{money:10000000});
    SQL=await require('sql.js')();db=new SQL.Database(fs.readFileSync('game.db'));create();
    const cash=()=>rows("SELECT money FROM players WHERE id='dice'")[0][0];
    const play=(wager,id)=>casino.play('dice','dice',wager,'',id);
    assert.equal(casino.play('missing','dice',100,'','missing').reason,'REGISTER_FIRST');
    assert.equal(play(100,'').reason,'MISSING_MESSAGE_ID');
    for(const bet of [99,100001,-1,0,100.5,'100x','1e3',null,Infinity]) assert.equal(play(bet,'bad-'+bet).reason,'INVALID_BET');
    assert.equal(casino.play('dice','slots',100,'','removed').reason,'INVALID_GAME');
    db.run("UPDATE players SET money=99 WHERE id='dice'");assert.equal(play(100,'poor').reason,'INSUFFICIENT_CASH');db.run("UPDATE players SET money=10000000 WHERE id='dice'");
    for(let face=1;face<=6;face++) for(const bet of [100,101,100000]) {
        time+=5000;draw=face-1;const prior=cash(),id=`${face}-${bet}`,r=play(bet,id);
        assert.equal(r.payout,dicePayout(bet,face));assert.equal(cash(),prior-bet+r.payout);
        assert(play(bet,id).duplicate);assert.equal(play(bet,id+'other').reason,'COOLDOWN');
        assert.equal(casino.history('dice')[0].game,'dice');
    }
    const history=casino.history('dice'),stats=casino.stats('dice');
    assert.equal(stats.total_games,18);assert.equal(stats.total_wagered,history.reduce((n,h)=>n+h.wager,0));
    assert.equal(stats.net,history.reduce((n,h)=>n+h.net,0));assert.equal(casino.leaderboard()[0].name,'Dice');
    db.close();db=new SQL.Database(fs.readFileSync('dice.db'));create();
    assert.deepEqual(casino.stats('dice'),stats);assert.equal(play(100,'restart-cd').reason,'COOLDOWN');assert(play(100,'6-100000').duplicate);
    time+=4999;assert.equal(play(100,'early').reason,'COOLDOWN');time++;draw=0;assert(play(100,'exact').success);
    time+=5000;const before=cash(),n=casino.history('dice').length;
    draw=6;assert.throws(()=>play(100,'rollback'),/Invalid random/);assert.equal(cash(),before);assert.equal(casino.history('dice').length,n);
    draw=5;fail=true;assert.throws(()=>play(100,'rollback'),/disk failure/);assert.equal(cash(),before);assert.equal(casino.history('dice').length,n);
    fail=false;assert(play(100,'rollback').success);
    time+=5000;const concurrent=await Promise.all(Array.from({length:20},()=>Promise.resolve().then(()=>play(100,'same'))));
    assert.equal(concurrent.filter(r=>r.duplicate).length,19);
    for(const [command,args] of [['dice',['100']],['casino',['dice','100']],['games',['dice','100']]]) {
        time+=5000;assert.match(casinoCommand(casino,'dice',command,args,'route-'+command),/DICE/);
    }
    console.log('PASS Dice bounds, all faces, rounding, cash, exact cooldown, deduplication, rollback, restart, history, statistics, leaderboard and aliases');
    db.close();db=null;
    const fixture=new SQL.Database(fs.readFileSync('game.db'));
    fixture.run("INSERT INTO missions VALUES ('dice_test','play_casino','Dice mission','Play','Play once',1,75,1)");
    fs.writeFileSync('game.db',fixture.export());fixture.close();await d.initDatabase();
    const balance=d.getPlayer('dice').money,r=d.casino.play('dice','dice',100,'','mission-dice');
    assert.equal(r.missionCompletions[0].reward,75);assert.equal(d.getPlayer('dice').money,balance+r.net+75);
    assert(d.casino.play('dice','dice',100,'','mission-dice').duplicate);
    assert.equal(d.getPlayerMissions('dice').find(m=>m.id==='dice_test').rewarded,1);
    console.log('PASS Dice atomic mission integration');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
    if(db)db.close();process.chdir(cwd);assert(fs.readFileSync(path.join(root,'game.db')).equals(original));fs.rmSync(temp,{recursive:true,force:true});
    console.log('PASS production game.db unchanged');
});
