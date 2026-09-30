const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const original = fs.readFileSync(path.join(root, 'game.db'));
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-regression-'));
process.chdir(temp);
fs.writeFileSync('game.db', original);
const d = require(path.join(root, 'database'));
const replies = require(path.join(root, 'player-replies'));
const handlers = {}, sent = [], errors = [];
const sock = {ev: {on: (event, callback) => { handlers[event] = callback; }},
    sendMessage: async (jid, payload) => { sent.push({jid, ...payload}); }};
const context = vm.createContext({require: name => {
    if (name === '@whiskeysockets/baileys') return {default: () => sock,
        useMultiFileAuthState: async () => ({state: {}, saveCreds() {}})};
    if (name === './whatsapp-lifecycle') return require('./lifecycle-routing-stub');
    if (name === 'pino') return () => ({});
    return require(path.join(root, name));
}, console: {log() {}, error: (...args) => errors.push(args)},
setInterval: () => ({unref() {}}), setTimeout, Math: Object.assign(Object.create(Math), {random: () => 0})});
const attacker = '111111@s.whatsapp.net', target = '222222@lid', group = '999@g.us';
let sequence = 0;
async function command(text, sender = attacker, mentioned = target) {
    const start = sent.length;
    await handlers['messages.upsert']({type: 'notify', messages: [{key: {
        remoteJid: group, participant: sender, id: `test-${++sequence}`},
        message: {extendedTextMessage: {text, contextInfo: {mentionedJid: [mentioned]}}}}]});
    assert.deepEqual(errors, []);
    const output = sent.slice(start);
    assert(output.length, text);
    const reply = output.find(m => m.jid === group);
    assert(reply.mentions.includes(sender), text);
    assert(reply.text.includes(`@${sender.split('@')[0]}`), text);
    return output;
}
function reset() { d.updatePlayer(attacker, {money: 5000000, bank: 0, last_rob: 0});
    d.updatePlayer(target, {money: 5000000, bank: 10000}); }
(async () => {
    vm.runInContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), context);
    for (let i = 0; !handlers['messages.upsert'] && i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(handlers['messages.upsert']);
    d.createPlayer(attacker, 'Attacker'); d.createPlayer(target, 'Target'); reset();
    const item = d.getItem('aegis_shield');
    assert.equal(item.price, 250000); assert.equal(item.category, 'SUPER RARE ROBBERY');
    assert.equal(item.stackable, 1); assert.equal(item.max_quantity, 2);
    assert(d.buyItem(target, item.id, 2).success);
    assert.equal(d.buyItem(target, item.id).reason, 'MAX_QUANTITY');
    assert.throws(() => d.addItem(target, item.id), /Maximum/);
    assert.equal(d.equipItem(target, item.id).reason, 'ITEM_NOT_EQUIPPABLE');
    d.removeItem(target, item.id, 2);
    for (const tool of ['', 'lockpick', 'gloves', 'disguise', 'breach_kit', 'scanner', 'getaway_kit', 'blackout_device']) {
        reset(); d.addItem(target, item.id, 2);
        if (tool && !d.getInventoryItem(attacker, tool)) d.addItem(attacker, tool);
        d.getRobberyProtection(target);
        d.updateRobberyProtection(target, {protected_until: Date.now() + 60000});
        const before = JSON.stringify(d.getPlayerMissions(attacker));
        const output = await command(`.rob @222222 ${tool}`);
        assert.equal(d.getInventoryItem(target, item.id).quantity, 1);
        assert.equal(d.getPlayer(attacker).money, 5000000);
        assert.equal(d.getPlayer(target).money, 5000000);
        assert.equal(JSON.stringify(d.getPlayerMissions(attacker)), before);
        assert(output.some(m => m.jid === target && m.mentions.includes(target) && /consumed/.test(m.text)));
        assert(output.some(m => /ROBBERY BLOCKED/.test(m.text)));
        if (tool) assert.equal(d.getInventoryItem(attacker, tool).quantity, 1);
        await command('.rob @222222'); // cooldown must not consume again
        assert.equal(d.getInventoryItem(target, item.id).quantity, 1);
        d.removeItem(target, item.id);
    }
    console.log('PASS all tools, Blackout/protection priority, consumption, balances, fines, missions, cooldown and notifications');
    reset(); d.addItem(target, item.id);
    await command('.rob @111111', attacker, attacker);
    await command('.rob @222222 invalid');
    assert.equal(d.getInventoryItem(target, item.id).quantity, 1);
    d.updateRobberyProtection(target, {protected_until: 0});
    await Promise.all([command('.rob @222222'), command('.rob @222222')]);
    assert.equal(d.getInventoryItem(target, item.id), null);
    assert.equal(d.getPlayer(target).money, 5000000);
    reset(); await command('.rob @222222');
    assert.equal(d.getPlayer(target).money, 4999900);
    assert.equal(d.getPlayerMissions(attacker).find(m => m.type === 'complete_robbery').progress, 1);
    d.addItem(target, item.id);
    if (!d.getInventoryItem(attacker, 'hacking_device')) d.addItem(attacker, 'hacking_device');
    await command('.hack @222222');
    assert.equal(d.getPlayer(target).bank, 4000);
    assert.equal(d.getInventoryItem(target, item.id).quantity, 1);
    await command('.attack @222222');
    assert.equal(d.getPlayer(target).health, 95);
    assert.equal(d.getInventoryItem(target, item.id).quantity, 1);
    for (const text of ['.daily', '.profile', '.balance', '.inventory', '.market', '.buy aegis_shield', '.missions', '.mission collect_daily_reward']) {
        await command(text);
    }
    await command('.profile', target);
    console.log('PASS invalid attempts, concurrent attempts, ordinary robbery, unchanged hack/combat, all required command mentions and LID sender');
    d.removeItem(target, item.id);
    d.addItem(target, item.id, 2);
    d.updateRobberyProtection(target, {protected_until: 0});
    for (const remaining of [1, 0]) {
        reset();
        const before = JSON.stringify(d.getPlayerMissions(attacker));
        await command('.rob @222222');
        assert.equal(d.getInventoryItem(target, item.id)?.quantity || 0, remaining);
        assert.equal(d.getPlayer(target).money, 5000000);
        assert.equal(d.getPlayer(attacker).money, 5000000);
        assert.equal(JSON.stringify(d.getPlayerMissions(attacker)), before);
    }
    reset();
    assert((await command('.rob @222222')).some(m => /ROBBERY SUCCESSFUL/.test(m.text)));
    assert.equal(d.getPlayer(target).money, 4999900);
    reset();
    context.Math.random = () => 0.99;
    assert((await command('.rob @222222')).some(m => /ROBBERY FAILED/.test(m.text)));
    assert(d.getPlayer(attacker).money < 5000000);
    assert.equal(d.getPlayer(target).money, 5000000);
    context.Math.random = () => 0;
    const fighter = '333333@s.whatsapp.net';
    d.createPlayer(fighter, 'Fighter');
    d.addItem(target, item.id);
    d.addItem(target, 'light_shield');
    assert(d.equipItem(target, 'light_shield').success);
    const health = d.getPlayer(target).health;
    const attack = d.executeAttack(fighter, target, 'aegis-combat-shield');
    assert.equal(attack.shieldAbsorbed, 5);
    assert.equal(attack.shieldRemaining, 20);
    assert.equal(d.getPlayer(target).health, health);
    assert.equal(d.getInventoryItem(target, item.id).quantity, 1);
    assert.equal(d.getInventoryItem(target, 'light_shield').equipped, 1);
    console.log('PASS two shields block twice, third robbery succeeds, normal failure fine and combat shield isolation');

    for (const text of ['.casino', '.games', '.casino leaderboard', '.casino stats',
        '.coinflip heads 100', '.dice 100', '.blackjack 100', '.blackjack status',
        '.blackjack stand', '.roulette red 100', '.jackpot 100', '.casino coinflip tails 99']) {
        await command(text);
    }
    await command('.casino', target);
    await command('.casino', '777777@lid'); // registration error also uses global tagging
    assert(d.casino.history(attacker).length >= 4);
    console.log('PASS Casino command routing, all game replies, validation, leaderboard, registration and LID tagging');

    const mock = {sendMessage: async (_, payload) => payload};
    let result = await replies.sendPlayerReply(mock, group, attacker, '@111111 hello', [attacker, target, target]);
    assert.equal(result.text.match(/@111111/g).length, 1);
    assert.deepEqual(result.mentions, [attacker, target]);
    result = await replies.sendPlayerReply(mock, group, '111111:2@s.whatsapp.net', 'hello');
    assert.equal(result.text, '@111111\n\nhello');
    result = await replies.sendPlayerReply(mock, group, group, 'hello');
    assert.deepEqual(result.mentions, []);
    const a = replies.createPlayerReply(attacker), b = replies.createPlayerReply(target);
    const concurrent = await Promise.all([a(mock, group, 'a'), b(mock, group, 'b')]);
    assert.deepEqual(concurrent.map(r => r.mentions), [[attacker], [target]]);
    console.log('PASS mention deduplication, device suffix, invalid JID and concurrent reply isolation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    process.chdir(cwd);
    assert(fs.readFileSync(path.join(root, 'game.db')).equals(original));
    fs.rmSync(temp, {recursive: true, force: true});
    console.log('PASS production game.db unchanged');
});
