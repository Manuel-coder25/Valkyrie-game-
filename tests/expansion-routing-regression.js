const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {fixture} = require('./expansion-fixture');
fixture(async ({d,root,player,edit,advance,setNow}) => {
    const handlers={}, sent=[], errors=[], timers=[];
    const group='900@g.us', creator='101@lid', creatorPN='201@s.whatsapp.net';
    const target='102@lid', targetPN='202@s.whatsapp.net', hunter='103@lid', hunterPN='203@s.whatsapp.net';
    const kamio='104@lid', kamioPN='204@s.whatsapp.net';
    const members=[{id:creator,lid:creator,phoneNumber:creatorPN},{id:target,lid:target,phoneNumber:targetPN},
        {id:hunter,lid:hunter,phoneNumber:hunterPN},{id:kamio,lid:kamio,phoneNumber:kamioPN}];
    let roll=0;
    const sock={ev:{on:(event,callback)=>{handlers[event]=callback;}},
        groupMetadata:async()=>({participants:members}),
        signalRepository:{lidMapping:{getPNForLID:async id=>members.find(m=>m.lid===id)?.phoneNumber}},
        sendMessage:async(jid,payload)=>{sent.push({jid,...payload});}};
    const context=vm.createContext({require:name=>{
        if(name==='@whiskeysockets/baileys') return {default:()=>sock,useMultiFileAuthState:async()=>({state:{},saveCreds(){}})};
        if (name === './whatsapp-lifecycle') return require('./lifecycle-routing-stub');
        if(name==='pino') return ()=>({});
        return require(path.join(root,name));
    },console:{log(){},error:(...args)=>errors.push(args)},setTimeout,Date,
    setInterval:(callback,ms)=>{timers.push({callback,ms});return {unref(){}};},
    Math:Object.assign(Object.create(Math),{random:()=>roll})});
    vm.runInContext(fs.readFileSync(path.join(root,'index.js'),'utf8'),context);
    for(let i=0;!handlers['messages.upsert']&&i<100;i++) await new Promise(r=>setTimeout(r,20));
    assert(handlers['messages.upsert']);
    player(creator);player(target);player(hunter);player(kamio,{rank:'KAMIO'});
    let sequence=0;
    const message=(text,sender=creatorPN,mentioned=targetPN,id='route-'+(++sequence),alt=creator)=>({
        key:{remoteJid:group,participant:sender,participantAlt:alt,id},
        message:{extendedTextMessage:{text,contextInfo:{mentionedJid:[mentioned]}}}
    });
    const dispatch=async msg=>{
        const start=sent.length;
        await handlers['messages.upsert']({type:'notify',messages:[msg]});
        const output=sent.slice(start);
        assert(output.length,'expected command reply');
        const reply=output.find(x=>x.jid===group);
        assert(reply.mentions.includes(msg.key.participant));
        return reply;
    };
    const command=async(text,sender,mention,alt)=>dispatch(message(text,sender,mention,undefined,alt));
    assert.match((await command('.bounty @201 10000',creator,creatorPN,creatorPN)).text,/yourself/);
    assert.match((await command('.bounty @999 10000',creatorPN,'999@lid',creator)).text,/not registered/);
    assert.match((await command('.bounty @202 10000','888@lid',targetPN,undefined)).text,/Register/);
    assert.match((await command('.bounty @202 Infinity')).text,/whole-dollar/);
    assert.match((await command('.bounty @202 1000001')).text,/maximum/);
    const creation=message('.bounty @202 10000');
    const before=d.getPlayer(creator).money;
    const reply=await dispatch(creation); assert.match(reply.text,/BOUNTY #/); assert(reply.mentions.includes(targetPN));
    const b=d.listBounties(creator)[0]; assert.equal(b.creator_id,creator); assert.equal(b.target_id,target);
    assert.equal(b.creator_identity,creatorPN); assert.equal(b.target_identity,targetPN);
    await Promise.all([dispatch(creation),dispatch(creation)]);
    assert.equal(d.getPlayer(creator).money,before-10000); assert.equal(d.bountyHistory(b.id).length,1);
    assert.match((await command('.bounties')).text,/ACTIVE BOUNTIES/);
    assert.match((await command('.mybounties')).text,/MY BOUNTIES/);
    assert.match((await command('.bountyinfo '+b.id)).text,/ACTIVE/);
    assert.match((await command('.bountyinfo invalid')).text,/Use/);
    assert.match((await command('.bountyinfo 999999')).text,/not found/);
    assert.match((await command('.bounty @202 1000001',kamioPN,targetPN,kamio)).text,/BOUNTY #/);
    await command('.bounty @204 10000',creatorPN,kamioPN,creator);
    const immortal=d.listBounties(creator)[0];
    assert.match((await command('.attack @204',hunterPN,kamioPN,hunter)).text,/Immune/);
    assert.equal(d.getBounty(immortal.id).status,'active');
    // Attacker's own bounty must remain active even when PN/LID forms differ.
    await command('.bounty @202 10000',hunterPN,targetPN,hunter);
    const own=d.listBounties(hunter)[0];
    advance(30001); d.updatePlayer(target,{health:5});
    const kill=message('.attack @202',hunter,targetPN,'kill-alias',hunterPN);
    const killed=await dispatch(kill); assert.match(killed.text,/Bounties claimed: 2/);
    assert(killed.mentions.includes(hunter)); assert.equal(d.getBounty(own.id).status,'active');
    const paid=d.getPlayer(hunter).money;
    await handlers['messages.upsert']({type:'notify',messages:[kill]});
    assert.equal(d.getPlayer(hunter).money,paid);
    setNow(immortal.expires_at); await command('.bounties');
    assert.equal(d.getBounty(immortal.id).status,'refunded');
    assert.equal(d.getBounty(b.id).status,'claimed');
    await command('.bounty @204 10000',creatorPN,kamioPN,creator);
    const timed=d.listBounties(creator)[0];setNow(timed.expires_at);
    const timer=timers.find(t=>t.ms===60000);assert(timer);timer.callback();
    assert.equal(d.getBounty(timed.id).status,'refunded');
    assert.equal(errors.length,0);
    console.log('PASS actual bounty commands, PN/LID self rejection and account resolution, mentions, roles, immunity, attack response, creator exclusion and timer/command expiry');

    // Robbery must persist cooldown, tool consumption, transfer and missions together.
    player('301@s.whatsapp.net');player('302@lid');
    const robber='301@s.whatsapp.net', victim='302@lid';
    await edit("INSERT OR IGNORE INTO items (id,name,description,category,price,stackable,max_quantity) VALUES ('lockpick','Lockpick','Test tool','Tools',1000,1,999)");
    d.addItem(robber,'lockpick',3);
    await edit(`UPDATE player_missions SET progress=(SELECT target_amount-1 FROM missions WHERE id=mission_id)
        WHERE player_id=? AND mission_id IN ('robbery_5','robbery_20','medkits_10')`,[robber]);
    const rob=message('.rob @302 lockpick',robber,victim,'rob-once',undefined);
    const watch=()=>[d.getPlayer(robber),d.getPlayer(victim),d.getInventory(robber),d.getPlayerMissions(robber)];
    const snapshot=watch(),bytes=fs.readFileSync('game.db'),rename=fs.renameSync;
    fs.renameSync=()=>{throw new Error('injected save failure');};
    try {assert.match((await dispatch(rob)).text,/could not be saved/);} finally {fs.renameSync=rename;}
    assert.deepEqual(watch(),snapshot);assert(fs.readFileSync('game.db').equals(bytes));
    errors.length=0;
    const cash=d.getPlayer(robber).money;
    assert.match((await dispatch(rob)).text,/ROBBERY SUCCESSFUL/);
    assert.equal(d.getPlayer(robber).money,cash+100+1000+2000+6000+300+1000);
    for(const id of ['robbery_5','robbery_20','medkits_10']) {
        const m=d.getPlayerMissions(robber).find(m=>m.id===id);assert.equal(m.progress,m.target_amount);assert.equal(m.rewarded,1);
    }
    const saved=watch(); await dispatch(rob); assert.deepEqual(watch(),saved);
    await command('.rob @302 lockpick',robber,victim,undefined);assert.deepEqual(watch(),saved);
    await d.initDatabase(); assert.deepEqual(watch(),saved);await dispatch(rob);assert.deepEqual(watch(),saved);
    // Failed, Aegis-blocked and invalid attempts cannot progress robbery missions.
    const failedRobber='303@s.whatsapp.net';player(failedRobber);
    d.addItem(victim,'aegis_shield');
    const missionBefore=d.getPlayerMissions(failedRobber);
    assert.match((await command('.rob @302',failedRobber,victim,undefined)).text,/ROBBERY BLOCKED/);
    assert.deepEqual(d.getPlayerMissions(failedRobber),missionBefore);
    advance(60001);roll=0.99;
    assert.match((await command('.rob @302',failedRobber,victim,undefined)).text,/ROBBERY FAILED/);
    assert.deepEqual(d.getPlayerMissions(failedRobber),missionBefore);
    advance(60001);roll=0;
    await command('.rob @303',failedRobber,failedRobber,undefined);
    assert.deepEqual(d.getPlayerMissions(failedRobber),missionBefore);
    assert.equal(errors.length,0);
    console.log('PASS real robbery route atomic cash/tools/cooldown/missions, save rollback/retry, one-time rewards, duplicate/restart protection and failed/blocked/rejected isolation');
}).catch(error=>{console.error(error);process.exitCode=1;});
