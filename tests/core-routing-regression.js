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
    let text=await command('.profile');
    for(const expected of ['Name: @222222','Rank: DON','Level: 25','HP: 148/296','XP: 0','Bank: $300,000']) assert(text.includes(expected),expected);
    d.updatePlayer(lid,{rank:'STAFF'});assert.match(await command('.profile'),/Rank: DON/);assert.equal(d.getPlayer(lid).rank,'STAFF');
    text=await command('.market');assert(text.includes('Medic')||text.includes('MEDIC'));assert(text.includes('medkit'));assert(text.includes('reaper'));assert(text.includes('$1,000,000'));assert(text.includes('$250,000'));
    assert.match(await command('.buy medkit 30'),/PURCHASE SUCCESSFUL/);
    const heal=message('.medkit');let output=await dispatch([heal]);assert.match(output[0].text,/Healed 29 HP/);assert.equal(d.getPlayer(lid).health,177);
    assert.match((await dispatch([heal]))[0].text,/already processed/);
    await d.initDatabase();assert.match((await dispatch([heal]))[0].text,/already processed/);assert.equal(d.getPlayer(lid).health,177);
    assert.match(await command('.medkit 30'),/Medkits used: 5/);assert.equal(d.getInventoryItem(lid,'medkit').quantity,24);
    const before=d.getInventoryItem(lid,'medkit').quantity;
    assert.match(await command('.medkit'),/already at full HP/);assert.equal(d.getInventoryItem(lid,'medkit').quantity,before);
    assert.match(await command('.medic'),/already at full HP/);
    d.updatePlayer(lid,{health:148});const balance=d.getPlayer(lid).money;
    assert.match(await command('.medic'),/Medic fee: \$16,250/);assert.equal(d.getPlayer(lid).money,balance-16250);assert.equal(d.getPlayer(lid).health,296);
    d.updatePlayer(lid,{health:100});assert.match(await command('.medkit bad'),/positive whole amount/);
    assert.match(await command('.medkit 1 2'),/Use .medkit/);assert.match(await command('.medic 2'),/Use .medkit/);
    assert.match(await command('.medic','888888@lid',undefined),/Register first/);
    const buy=message('.buy medkit 2');await dispatch([buy]);const owned=d.getInventoryItem(lid,'medkit').quantity;
    assert.match((await dispatch([buy]))[0].text,/already processed/);assert.equal(d.getInventoryItem(lid,'medkit').quantity,owned);
    for(const weapon of ['reaper','dominator','warhammer','valkyrie_executioner']) {
        assert.match(await command('.buy '+weapon),/PURCHASE SUCCESSFUL/);
        const equip=message('.equip '+weapon);assert.match((await dispatch([equip]))[0].text,/equipped/);
        assert.match((await dispatch([equip]))[0].text,/already processed/);
        now+=d.RECOVERY_DURATION+1;d.recoverPlayers();d.updatePlayer(target,{health:100});
        assert.match(await command('.attack @333333'),/Damage: 50\n/);
        assert.equal(d.getPlayer(target).health,50);
        d.addItem(target,'medkit');
        for(const sender of [pn,target]) for(const healing of ['.medkit','.medkit 30','.medic']) {
            assert.match(await command(healing,sender,sender===pn?lid:undefined),/blocked during combat/);
        }
        // The incoming-target lock must survive a database restart.
        await d.initDatabase();assert.match(await command('.medic',target,undefined),/blocked during combat/);
        now+=30000;
        assert.match(await command('.medic',pn,lid),/blocked during combat/);
        assert.match(await command('.medkit',target,undefined),/blocked during combat/);
        now+=30000;
        assert.match(await command('.medic',pn,lid),/Healed/);d.updatePlayer(lid,{health:100});
    }
    now+=30000;assert.match(await command('.attack @333333'),/Target defeated/);
    for(const healing of ['.medkit','.medkit 30','.medic']) assert.match(await command(healing,target,undefined),/Defeated/);
    const cash=d.getPlayer(target).money;
    now+=d.RECOVERY_DURATION+1;assert.match(await command('.health',target,undefined),/100\/100/);assert.equal(d.getPlayer(target).money,cash);
    d.updatePlayer(lid,{level:1,xp:499,health:60});now+=30000;
    text=await command('.job delivery');assert.match(text,/Level 2/);assert.match(text,/Rank: HUSTLER/);assert.match(text,/Maximum HP: 108/);assert.equal(d.getPlayer(lid).health,60);
    d.updatePlayer(lid,{level:49,xp:185299});
    text=await command('.work');assert.match(text,/Level 50/);assert.match(text,/VALKYRIE LEGEND/);assert.match(text,/Maximum HP: 500/);assert.equal(d.getPlayer(lid).health,60);
    now+=10000;assert.match(await command('.work'),/WORK COMPLETE/);assert.equal(d.getPlayer(lid).level,50);
    assert.match(await command('.profile'),/Rank: VALKYRIE LEGEND/);
    assert.match(await command('.casino'),/Dice Duel/);assert.match(await command('.games'),/Dice Duel/);
    assert(!/slots/i.test(await command('.casino')));
    for(const c of ['.dice 100','.casino dice 100','.games dice 100']){now+=5000;assert.match(await command(c),/DICE/);}
    assert.match(await command('.casino slots 100'),/Unknown casino game/);
    const kamio='2349169761233@s.whatsapp.net';
    assert.match(await command('.setlevel @333333 51',kamio,undefined),/1–50/);assert.equal(d.getPlayer(target).level,1);
    now+=60001;d.updatePlayer(target,{health:100});
    const wrappedAttack=message('.attack @333333');wrappedAttack.message={ephemeralMessage:{message:wrappedAttack.message}};
    assert.match((await dispatch([wrappedAttack]))[0].text,/Damage: 50/);
    const wrappedHeal=message('.medkit');wrappedHeal.message={ephemeralMessage:{message:wrappedHeal.message}};
    assert.match((await dispatch([wrappedHeal]))[0].text,/blocked during combat/);
    now+=60000;const wrappedMedic=message('.medic');wrappedMedic.message={ephemeralMessage:{message:wrappedMedic.message}};
    assert.match((await dispatch([wrappedMedic]))[0].text,/Healed/);
    d.updatePlayer(kamio,{level:1,xp:499,health:50});
    text=await command('.work',kamio,undefined);assert.match(text,/Rank: KAMIO/);assert(!text.includes('Rank: HUSTLER'));
    d.updatePlayer(kamio,{level:1,xp:499});
    text=await command('.job delivery',kamio,undefined);assert.match(text,/Rank: KAMIO/);
    assert.equal(d.getPlayer(kamio).health,50);
    // Each route uses the real messages.upsert callback with a fake socket;
    // command() verifies an actual mentions entry for the sender on every reply.
    console.log('PASS real message path: profile/ranks/tagging, market/services, Medkit/Medic, duplicates/restart, all legendary purchases/equips/attacks, both combat locks, defeat/recovery, level-up HP/rank, level cap and Dice aliases');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
    Date.now=realNow;process.chdir(cwd);assert(fs.readFileSync(path.join(root,'game.db')).equals(original));fs.rmSync(temp,{recursive:true,force:true});
    console.log('PASS production game.db unchanged; no real socket/auth used');
});
