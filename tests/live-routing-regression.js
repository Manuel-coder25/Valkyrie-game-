const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const original = fs.readFileSync(path.join(root, 'game.db'));
const cwd = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-routing-'));
process.chdir(temp);
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const d = require(path.join(root, 'database'));
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
setInterval: () => ({unref() {}}), setTimeout});
let sequence = 0;
const group = '999@g.us', lid = '111111@lid', pn = '222222@s.whatsapp.net', target = '333333@lid';
function message(text, sender = pn, alternate = lid, id = `routing-${++sequence}`) {
    return {key: {remoteJid: group, participant: sender, participantAlt: alternate, id},
        message: {extendedTextMessage: {text, contextInfo: {mentionedJid: [target]}}}};
}
async function dispatch(messages) {
    const start = sent.length;
    await handlers['messages.upsert']({type: 'notify', messages});
    assert.deepEqual(errors, []);
    return sent.slice(start);
}
async function command(text, sender = pn, alternate = lid) {
    const output = await dispatch([message(text, sender, alternate)]);
    assert.equal(output.length, 1, text);
    assert(output[0].mentions.includes(sender), text);
    return output[0].text;
}
(async () => {
    vm.runInContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), context);
    for (let i = 0; !handlers['messages.upsert'] && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert(handlers['messages.upsert']);
    d.createPlayer(lid, 'LID inventory'); d.createPlayer(target, 'Target');
    assert.equal((await dispatch([message('ordinary chat'), message('.casino', lid, lid)])).length, 1, 'process commands after the first message');
    const expected = {pocket_knife:10, combat_knife:15, hatchet:20, pistol:25, revolver:30,
        smg:35, shotgun:45, assault_rifle:55, sniper:70, valkyrie_executioner:150};
    for (const [weapon, damage] of Object.entries(expected)) {
        d.addItem(lid, weapon, weapon === 'valkyrie_executioner' ? 1 : 7);
        assert.match(await command(`.equip ${weapon}`), /equipped/);
        now += d.RECOVERY_DURATION + 1; d.recoverPlayers();
        d.updatePlayer(target, {health:100});
        assert.match(await command('.attack @333333'), new RegExp(`Damage: ${Math.min(damage,50)}\\n`));
        assert.equal(d.getPlayer(target).health, 100-Math.min(damage,50));
        assert.match(await command(`.unequip ${weapon}`), /unequipped/);
    }
    now += d.RECOVERY_DURATION + 1; d.recoverPlayers();
    d.updatePlayer(target, {health:100});
    assert.match(await command('.attack @333333'), /Damage: 5\n/);
    console.log('PASS actual equip/attack/unequip routing: all exact damage values, quantity independence, PN → LID, unarmed');
    d.updatePlayer(lid, {money:10000});
    for (const bet of ['99','100001','-100','100.5','100x','1e3']) {
        assert.match(await command(`.dice ${bet}`), /whole-dollar/);
    }
    assert.equal(d.getPlayer(lid).money,10000); assert.equal(d.casino.history(lid).length,0);
    d.updatePlayer(lid, {money:99});
    assert.match(await command('.dice 100'), /enough cash/);
    d.updatePlayer(lid, {money:10000});
    const spin = message('.dice 100');
    const output = await dispatch([message('ordinary chat'), spin]);
    assert.equal(output.length,1); assert.match(output[0].text,/DICE/); assert(output[0].mentions.includes(pn));
    const history = d.casino.history(lid);
    assert.equal(history.length,1); assert.equal(history[0].wager,100);
    const outcome = JSON.parse(history[0].outcome);
    const rules = require(path.join(root,'casino'));
    assert.equal(history[0].payout,rules.dicePayout(100,outcome.face));
    const balance = 9900 + history[0].payout;
    assert.equal(d.getPlayer(lid).money,balance);
    const stats = d.casino.stats(lid);
    assert.equal(stats.total_games,1); assert.equal(stats.total_wagered,100);
    assert.equal(stats.net,history[0].payout-100);
    assert.match((await dispatch([spin]))[0].text,/already processed/);
    assert.equal(d.getPlayer(lid).money,balance); assert.deepEqual(d.casino.stats(lid),stats);
    assert.match(await command('.casino dice 100'), /Wait 5s/);
    now += 4999;
    assert.match(await command('.games dice 100'), /Wait 1s/);
    assert.equal(d.casino.history(lid).length,1);
    now += 1;
    assert.match(await command('.casino dice 100'), /DICE/);
    now += 10000;
    assert.match(await command('.games dice 100'), /DICE/);
    assert.equal(d.casino.history(lid).length,3);
    console.log('PASS batched Dice routing, aliases, tagged reply, valid/invalid bets, insufficient cash, exact 5s cooldown, payout, once-only settlement/history/statistics');
    const phonePlayer = '444444@s.whatsapp.net', alias = '555555@lid';
    d.createPlayer(phonePlayer,'Phone inventory'); d.addItem(phonePlayer,'pistol',3);
    assert.match(await command('.equip pistol',alias,phonePlayer),/equipped/);
    assert.equal(d.getEquippedWeapon(phonePlayer).damage,25);
    d.updatePlayer(target,{health:100,defeated_until:0});
    assert.match(await command('.attack @333333',alias,phonePlayer),/Damage: 25\n/);
    assert.match(await command('.dice 100',alias,phonePlayer),/DICE/);
    d.createPlayer(alias,'Separate exact account');
    assert.match(await command('.dice 100',alias,phonePlayer),/DICE/);
    assert.equal(d.casino.history(alias).length,1);
    assert.equal(d.casino.history(phonePlayer).length,1);
    console.log('PASS LID → PN fallback and exact registered-account priority');
    now += d.ATTACK_COOLDOWN + 1;
    const immune = '666666@s.whatsapp.net'; d.createPlayer(immune,'Immune','KAMIO');
    const hit = d.executeAttack(phonePlayer,immune,'immune-check');
    assert(hit.success && hit.immune); assert.equal(hit.damage,25);
    assert.equal(hit.healthDamage,0); assert.equal(d.getPlayer(immune).health,100);
    assert.equal(d.executeAttack(phonePlayer,immune,'immune-check').reason,'DUPLICATE');
    assert.equal(d.executeAttack(phonePlayer,immune,'immune-cooldown').reason,'COOLDOWN');
    console.log('PASS KAMIO immunity, attack deduplication and cooldown');
    now += 10000;
    const wrapped = message('.dice 100');
    wrapped.message = {ephemeralMessage: {message: wrapped.message}};
    const wrappedOutput = await dispatch([wrapped]);
    assert.equal(wrappedOutput.length, 1, 'disappearing-message Dice must reach Casino');
    assert.match(wrappedOutput[0].text, /DICE/);
    assert(wrappedOutput[0].mentions.includes(pn));
    assert.match((await dispatch([wrapped]))[0].text, /already processed/);
    for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']) {
        now += 10000;
        const nested = message('.games dice 100');
        nested.message = {ephemeralMessage: {message: {[wrapper]: {message: nested.message}}}};
        assert.match((await dispatch([nested]))[0].text, /DICE/);
    }
    assert.match(await command('.dice 100', '777777@lid', undefined), /Register first/);
    console.log('PASS wrapped/nested Dice messages, original identity, duplicate protection and registration');

})().catch(error => {console.error(error); process.exitCode=1;}).finally(() => {
    Date.now = realNow; process.chdir(cwd);
    assert(fs.readFileSync(path.join(root,'game.db')).equals(original));
    fs.rmSync(temp,{recursive:true,force:true});
    console.log('PASS production game.db unchanged; no real socket/auth used');
});
