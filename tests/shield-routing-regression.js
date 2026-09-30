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
(async()=>{
    vm.runInContext(fs.readFileSync(path.join(root,'index.js'),'utf8'),context);
    for(let i=0;!handlers['messages.upsert']&&i<100;i++)await new Promise(r=>setTimeout(r,20));
    assert(handlers['messages.upsert']);
    d.createPlayer(lid,'Healer');d.createPlayer(target,'Target');
    d.updatePlayer(lid,{money:100000000,bank:300000,level:25,health:148});
    assert.match(await command('.health'), /None equipped/);
    assert.match(await command('.buy light_shield'), /PURCHASE SUCCESSFUL/);
    assert.match(await command('.equip light_shield'), /25 absorption remaining/);
    assert.match(await command('.health'), /Light Shield — 25\/25/);
    d.createPlayer('shield-tester','Shield tester');
    d.addItem('shield-tester','warhammer');d.equipItem('shield-tester','warhammer');
    const shieldHit=d.executeAttack('shield-tester',lid,'routing-shield-hit');
    assert.equal(shieldHit.shieldAbsorbed,25);assert.equal(shieldHit.healthDamage,123);
    assert.match(await command('.health'), /0\/25 absorption \(depleted\)/);
    assert.match(await command('.equip light_shield'), /is depleted/);
    await d.initDatabase();
    assert.equal(d.getEquippedShield(lid).remaining,0);
    const shieldCash=d.getPlayer(lid).money;
    d.updatePlayer(lid,{money:9999});
    assert.match(await command('.buy light_shield'), /INSUFFICIENT FUNDS/);
    assert.equal(d.getEquippedShield(lid).remaining,0);
    assert.equal(d.getPlayer(lid).money,9999);
    d.updatePlayer(lid,{money:shieldCash});
    assert.match(await command('.buy light_shield 2'), /Purchase failed/);
    assert.equal(d.getPlayer(lid).money,shieldCash);
    const replacement=message('.buy light_shield');
    assert.match((await dispatch([replacement]))[0].text,/PURCHASE SUCCESSFUL/);
    assert.equal(d.getPlayer(lid).money,shieldCash-10000);
    assert.match((await dispatch([replacement]))[0].text,/already processed/);
    assert.equal(d.getPlayer(lid).money,shieldCash-10000);
    assert.equal(d.getEquippedShield(lid).remaining,25);
    assert.match(await command('.unequip light_shield'), /unequipped/);
    assert.match(await command('.health'), /None equipped/);
    assert.match(await command('.equip light_shield'), /25 absorption remaining/);
    await d.initDatabase();assert.equal(d.getEquippedShield(lid).remaining,25);
    d.createPlayer('shield-unarmed','Unarmed');
    assert.equal(d.executeAttack('shield-unarmed',lid,'partial-shield-hit').shieldAbsorbed,5);
    assert.match(await command('.unequip light_shield'), /unequipped/);
    assert.match(await command('.equip light_shield'), /20 absorption remaining/);
    assert.match(await command('.health'), /20\/25/);
    assert.match(await command('.buy light_shield'), /Purchase failed/);
    assert.equal(d.getEquippedShield(lid).remaining,20);
    console.log('PASS shield routing: identity, absorption, depletion, paid replacement, duplicate purchase, restart and health');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
    Date.now=realNow;process.chdir(cwd);assert(fs.readFileSync(path.join(root,'game.db')).equals(original));fs.rmSync(temp,{recursive:true,force:true});
    console.log('PASS production game.db unchanged; no real socket/auth used');
});
