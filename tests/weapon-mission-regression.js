const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const original = fs.readFileSync(path.join(root, 'game.db'));
const cwd = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weapon-mission-regression-'));
// All database writes go to a disposable fixture, never the production database.
process.chdir(temporary);
const d = require(path.join(root, 'database.js'));
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const resolver = between('async function resolveAttackIdentity(', 'async function startBot()');
const identity = between('                let userId =', '                const pushName =');
const equipment = between('if (\n    command === "equip"', '/*\n==================================\nMISSIONS');
const missions = between('if (\n    command === "missions"', '/*\n==================================\nMENU');
const context = vm.createContext({...d, KAMIO_JID: 'owner@s.whatsapp.net', sendText: (_sock, _jid, text) => text,
    actionId: undefined, formatMoney: value => `$${value}`, sock: {}, jid: 'test@g.us'});
vm.runInContext(resolver, context);
async function sender(id, alternate) {
    context.msg = {key: {participant: id, participantAlt: alternate}};
    return vm.runInContext(`(async () => {const command = 'attack'; ${identity} return userId;})()`, context);
}
async function command(block, name, player, args = []) {
    Object.assign(context, {command: name, player, args});
    return vm.runInContext(`(async () => {${block}})()`, context);
}
(async () => {
    await d.initDatabase();
    const expected = {pocket_knife: 10, combat_knife: 15, hatchet: 20, pistol: 25,
        revolver: 30, smg: 35, shotgun: 45, assault_rifle: 55, sniper: 70, valkyrie_executioner: 150, unarmed: 5};
    for (const [weapon, damage] of Object.entries(expected)) {
        const lid = `${weapon}@lid`, pn = `${weapon}@s.whatsapp.net`, target = `${weapon}-target@lid`;
        d.createPlayer(lid, 'Equipped account');
        d.createPlayer(pn, 'Separate unarmed account');
        d.createPlayer(target, 'Target');
        if (weapon !== 'unarmed') {
            d.addItem(lid, weapon, weapon === 'valkyrie_executioner' ? 1 : 7);
            assert.match(await command(equipment, 'equip', d.getPlayer(lid), [weapon]), /equipped/);
            assert.equal(d.getInventoryItem(lid, weapon).equipped, 1);
            assert.equal(d.getEquippedWeapon(lid).damage, damage);
        }
        const attacker = await sender(lid, pn);
        assert.equal(attacker, lid, 'attack must use the account used by .equip');
        const result = d.executeAttack(attacker, target, weapon);
        assert.equal(result.success, true);
        assert.equal(result.damage, Math.min(damage,50));
        assert.equal(result.health, 100 - Math.min(damage,50));
        assert.equal(d.getPlayer(pn).last_attack, 0);
        console.log(`PASS equipped command → inventory → attack: ${weapon} = ${damage}`);
    }
    d.createPlayer('fallback@s.whatsapp.net', 'Fallback');
    assert.equal(await sender('unregistered@lid', 'fallback@s.whatsapp.net'), 'fallback@s.whatsapp.net');
    console.log('PASS phone fallback for unregistered sender');
    const rows = [0, 1, 2].map(i => ({id: `mission_${i}`, title: `Title ${i}`, description: `Description ${i}`,
        progress: i, target_amount: 3, requirement: `Requirement ${i}`, reward: 100 + i,
        completed: i > 0 ? 1 : 0, rewarded: i === 2 ? 1 : 0}));
    context.getPlayerMissions = () => rows;
    const player = {id: 'missions@lid'};
    const rendered = rows.map((m, i) => `${['🔄 ACTIVE', '🎉 COMPLETED', '✅ REWARDED'][i]} *${m.title}*\nID: ${m.id}\n${m.description}\nProgress: ${m.progress}/${m.target_amount}\nRequirement: ${m.requirement}\nReward: $${m.reward}`);
    assert.equal(await command(missions, 'missions', player), `📜 *VALKYRIE MISSIONS*\n\n${rendered.join('\n\n')}`);
    for (let i = 0; i < rows.length; i++) {
        assert.equal(await command(missions, 'mission', player, [rows[i].id]), `📜 *VALKYRIE MISSIONS*\n\n${rendered[i]}`);
    }
    assert.equal(await command(missions, 'mission', player, ['missing']), '❌ Mission *missing* was not found.');
    context.getPlayerMissions = () => [];
    assert.equal(await command(missions, 'missions', player), '📜 *MISSIONS*\n\nNo active missions are available.');
    console.log('PASS mission list/detail/empty/not-found formatting and all displayed fields/statuses');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => {
    process.chdir(cwd);
    assert(fs.readFileSync(path.join(root, 'game.db')).equals(original), 'production game.db changed');
    fs.rmSync(temporary, {recursive: true, force: true});
    console.log('PASS production game.db unchanged');
});
