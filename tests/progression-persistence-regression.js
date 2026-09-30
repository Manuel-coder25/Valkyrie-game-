const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..'), cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'valkyrie-xp-'));
process.chdir(temp);
const d = require(path.join(root, 'database'));
(async () => {
    await d.initDatabase();
    // Include XP above the new threshold: loading must not advance these players.
    const fixtures = [[1,499],[10,8824],[25,49699],[40,124324],[49,185299],[50,999999]];
    const saved = fixtures.map(([level,xp]) => {
        const id = 'saved-' + level;
        d.createPlayer(id,id);
        d.updatePlayer(id,{level,xp,health:60});
        return d.getPlayer(id);
    });
    await d.initDatabase();
    for (const player of saved) assert.deepEqual(d.getPlayer(player.id), player);
    const resumed = d.jobs.claim('saved-1','delivery','resume-xp');
    assert.equal(resumed.xp,10);
    assert.equal(resumed.progression.level,2);
    assert.equal(resumed.progression.xp,184);
    assert.equal(d.getPlayer('saved-1').health,60);
    const capped = d.jobs.claim('saved-50','delivery','cap-xp');
    assert.equal(capped.progression.level,50);
    assert.equal(capped.progression.xp,1000009);
    console.log('PASS restart preserves saved levels/XP; next award uses new curve; cap retains XP; HP unchanged');
})().catch(error => { console.error(error); process.exitCode=1; }).finally(() => {
    process.chdir(cwd);
    fs.rmSync(temp,{recursive:true,force:true});
});
