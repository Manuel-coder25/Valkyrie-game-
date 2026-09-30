const assert = require('node:assert/strict');
const {fixture} = require('./expansion-fixture');
fixture(async ({d,player,setNow}) => {
    player('max',{rank:'KAMIO',money:Number.MAX_SAFE_INTEGER});
    player('target');
    const result = d.createBounty('max','target',Number.MAX_SAFE_INTEGER,'max-expiry');
    assert(result.success);
    assert.equal(d.getPlayer('max').money,0);
    setNow(result.bounty.expires_at);
    assert.deepEqual(d.expireBounties(),[result.bounty.id]);
    assert.equal(d.getPlayer('max').money,0);
    assert.equal(d.getReserveBalance(),Number.MAX_SAFE_INTEGER);
    assert.equal(d.expireBounties().length,0);
    assert.equal(d.getReserveBalance(),Number.MAX_SAFE_INTEGER);
    assert.equal(d.bountyHistory(result.bounty.id).filter(event=>event.event_type==='expired').length,1);
    console.log('PASS maximum legal KAMIO bounty settles exactly once into the safe-integer Reserve');
}).catch(error=>{console.error(error);process.exitCode=1;});
