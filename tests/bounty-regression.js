const assert = require('node:assert/strict');
const {fixture} = require('./expansion-fixture');
fixture(async ({d,rows,edit,player,failSave,now,setNow,advance}) => {
    let sequence = 0;
    const place = (creator='creator',target='target',amount=10000,identity) =>
        d.createBounty(creator,target,amount,'create-'+(++sequence),identity);
    player('creator'); player('other'); player('target'); player('hunter');
    player('kamio',{rank:'KAMIO'}); player('impostor',{name:'KAMIO'});
    for (const value of [9999,0,-1,10000.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'NaN','Infinity','1e4','10,000','10000x',' 10000',null,{},true]) {
        assert.equal(place('creator','target',value).reason,'INVALID_AMOUNT');
    }
    assert.equal(place('creator','target',1000001).reason,'MAXIMUM');
    assert.equal(place('impostor','target',1000001).reason,'MAXIMUM');
    assert.equal(place('creator','creator').reason,'SELF_TARGET');
    assert.equal(place('creator','other',10000,{creator:'same',target:'same'}).reason,'SELF_TARGET');
    assert.equal(place('creator','missing').reason,'PLAYER_NOT_FOUND');
    assert.equal(d.createBounty('creator','target',10000,null).reason,'MISSING_MESSAGE_ID');
    player('poor',{money:9999}); assert.equal(place('poor').reason,'INSUFFICIENT_FUNDS');
    const cash = d.getPlayer('creator').money;
    const first = d.createBounty('creator','target','10000','once').bounty;
    assert.equal(d.getPlayer('creator').money,cash-10000);
    assert.equal(d.createBounty('creator','target','10000','once').reason,'DUPLICATE');
    assert.equal(rows("SELECT count(*) n FROM bounties WHERE creation_action_key='once'")[0].n,1);
    assert.equal(d.bountyHistory(first.id).length,1);
    assert.equal(d.bountyHistory(first.id)[0].amount,10000);
    assert.equal(d.getPlayer('creator').money,cash-10000);
    assert(place('creator','target',1000000).success);
    assert(place('kamio','target',1000001).success);
    assert(place('kamio','target',10000).success);
    const second = place('other').bounty;
    const own = place('hunter').bounty;
    const aliased = place('other','target',10000,{creator:'hunter-phone',target:'target'}).bounty;
    assert.equal(d.deletePlayer('creator').reason,'ACTIVE_BOUNTIES');
    const targetedKamio = place('creator','kamio').bounty;
    assert(d.executeAttack('hunter','kamio','immune').immune);
    assert.equal(d.getBounty(targetedKamio.id).status,'active');
    advance(30001);
    const nonlethal = d.executeAttack('hunter','target','hit');
    assert.equal(nonlethal.defeated,false); assert.equal(nonlethal.bountyClaims.length,0);
    assert.equal(d.executeAttack('hunter','target','cooldown').reason,'COOLDOWN');
    assert.equal(d.executeAttack('missing','target','missing').reason,'PLAYER_NOT_FOUND');
    assert.equal(d.executeAttack('hunter','target',null).reason,'MISSING_MESSAGE_ID');
    advance(30001); d.updatePlayer('target',{health:5});
    const eligible = rows("SELECT * FROM bounties WHERE target_id='target' AND creator_id!='hunter' AND creator_identity!='hunter-phone'");
    const total = eligible.reduce((sum,b)=>sum+b.amount,0), before = d.getPlayer('hunter').money;
    const watch = () => [d.getPlayer('hunter'),d.getPlayer('target'),d.getBounty(first.id),d.bountyHistory(first.id),d.getPlayerMissions('hunter')];
    failSave(()=>d.executeAttack('hunter','target','lethal',{attacker:'hunter-phone'}),watch);
    const claim = d.executeAttack('hunter','target','lethal',{attacker:'hunter-phone'});
    assert(claim.defeated); assert.equal(claim.bountyClaims.length,eligible.length);
    assert.equal(d.getPlayer('hunter').money,before+total+1500); // Existing first-defeat mission.
    for (const b of eligible) {
        assert.equal(d.getBounty(b.id).status,'claimed'); assert.equal(d.getBounty(b.id).claimant_id,'hunter');
        assert.equal(d.bountyHistory(b.id).filter(e=>e.event_type==='claimed').length,1);
    }
    assert.equal(d.getBounty(own.id).status,'active'); assert.equal(d.getBounty(aliased.id).status,'active');
    const paid = d.getPlayer('hunter').money;
    assert.equal(d.executeAttack('hunter','target','lethal').reason,'DUPLICATE');
    assert.equal(d.getPlayer('hunter').money,paid);
    await d.initDatabase(); assert.equal(d.executeAttack('hunter','target','lethal').reason,'DUPLICATE');
    console.log('PASS bounty validation, roles, escrow, targeting, immunity, all eligible claims, creator exclusions, save rollback and restart deduplication');

    // One winner across concurrent final blows from different attackers.
    player('race-target',{health:5}); player('hunter2');
    const race = place('creator','race-target').bounty; advance(30001);
    const results = await Promise.all(['hunter','hunter2'].map(id=>Promise.resolve().then(()=>d.executeAttack(id,'race-target','race-'+id))));
    assert.equal(results.filter(r=>r.defeated).length,1);
    assert.equal(d.bountyHistory(race.id).filter(e=>e.event_type==='claimed').length,1);

    player('edge-target',{health:5}); player('edge-hunter');
    const edge = place('creator','edge-target').bounty;
    setNow(edge.expires_at-1); d.expireBounties(); assert.equal(d.getBounty(edge.id).status,'active');
    // Other due bounties may refund here, so capture balance after that sweep.
    const refundBefore = d.getPlayer('creator').money, reserveBefore = d.getReserveBalance();
    setNow(edge.expires_at);
    failSave(()=>d.expireBounties(),()=>[d.getPlayer('creator'),d.getBounty(edge.id),d.bountyHistory(edge.id)]);
    const exact = d.executeAttack('edge-hunter','edge-target','deadline');
    assert(exact.defeated); assert.equal(exact.bountyClaims.length,0);
    assert.equal(d.getBounty(edge.id).status,'refunded');
    assert.equal(d.getPlayer('creator').money,refundBefore);
    assert.equal(d.getReserveBalance(),reserveBefore+edge.amount);
    d.expireBounties(); advance(1); d.expireBounties();
    assert.equal(d.bountyHistory(edge.id).filter(e=>e.event_type==='expired').length,1);
    assert.equal(d.getBounty(first.id).status,'claimed');
    assert.equal(d.bountyHistory(first.id).filter(e=>e.event_type==='expired').length,0);
    assert.equal(d.getBounty(second.id).status,'claimed');
    player('early-target',{health:5}); player('early-hunter');
    const early = place('creator','early-target').bounty; setNow(early.expires_at-1);
    assert.equal(d.executeAttack('early-hunter','early-target','before-deadline').bountyClaims.length,1);
    setNow(early.expires_at); d.expireBounties(); assert.equal(d.getBounty(early.id).status,'claimed');
    const offline = place('creator','kamio').bounty, offlineCash = d.getPlayer('creator').money;
    setNow(offline.expires_at+3600000); await d.initDatabase();
    assert.equal(d.getBounty(offline.id).status,'refunded');
    assert.equal(d.getPlayer('creator').money,offlineCash);
    assert.equal(d.getReserveBalance(),reserveBefore+edge.amount+offline.amount);
    await d.initDatabase(); assert.equal(d.getPlayer('creator').money,offlineCash);
    console.log('PASS concurrent claims, exact deadline, before/after expiry, claim/refund exclusion, refund rollback and offline restart');

    const countBefore = rows('SELECT count(*) n FROM bounties')[0].n;
    failSave(()=>d.createBounty('creator','target',10000,'creation-retry'),()=>[d.getPlayer('creator'),d.listBounties('creator')]);
    assert.equal(rows('SELECT count(*) n FROM bounties')[0].n,countBefore);
    const retry = d.createBounty('creator','target',10000,'creation-retry'); assert(retry.success);
    await assert.rejects(edit('UPDATE bounties SET amount = amount + 1 WHERE id = ?', [retry.bounty.id]),/Immutable/);
    await assert.rejects(edit('DELETE FROM bounty_events WHERE bounty_id = ?', [retry.bounty.id]),/append-only/);
    await assert.rejects(edit("UPDATE bounty_events SET event_type='refunded' WHERE bounty_id = ?", [retry.bounty.id]),/append-only/);
    await assert.rejects(edit("INSERT INTO bounty_events (bounty_id,event_type,amount,timestamp,source_action_key) VALUES (?,'claimed',10000,?,'duplicate')",[race.id,now()]),/UNIQUE/);
    // SQL failure after debiting escrow must roll back just like a failed save.
    await edit("CREATE TRIGGER reject_bounty_event BEFORE INSERT ON bounty_events BEGIN SELECT RAISE(ABORT,'injected event failure'); END");
    const sqlCash=d.getPlayer('creator').money, sqlCount=rows('SELECT count(*) n FROM bounties')[0].n;
    assert.throws(()=>d.createBounty('creator','target',10000,'sql-retry'),/injected event failure/);
    assert.equal(d.getPlayer('creator').money,sqlCash);
    assert.equal(rows('SELECT count(*) n FROM bounties')[0].n,sqlCount);
    await edit('DROP TRIGGER reject_bounty_event');
    assert(d.createBounty('creator','target',10000,'sql-retry').success);
    console.log('PASS safe-integer boundary, creation save failure, immutable amounts/events and unique terminal outcome');
}).catch(error=>{console.error(error);process.exitCode=1;});
