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
(async () => {
    vm.runInContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), context);
    for (let i = 0; !handlers['messages.upsert'] && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert(handlers['messages.upsert']);
    d.createPlayer(lid, 'Job tester');
    assert.match(await command('.jobs'), /DELIVERY RIDER/);
    const {JOBS} = require(path.join(root, 'jobs'));
    const menu = await command('.jobs');
    for (const job of JOBS) assert(menu.includes('.job '+job.id));
    assert.match(await command('.job missing'), /Unknown job/);
    assert.match(await command('.job mechanic'), /level 4/);
    assert.match(await command('.job delivery', '777777@lid', undefined), /Register first/);
    const before = d.getPlayer(lid);
    const first = message('.job delivery');
    assert.match((await dispatch([first]))[0].text, /JOB COMPLETE/);
    const entry = d.jobs.history(lid)[0];
    assert(entry.payout >= 500 && entry.payout <= 1000);
    assert.equal(entry.xp, 10);
    assert.equal(d.getPlayer(lid).money, before.money+entry.payout);
    assert.equal(d.getPlayer(lid).xp, before.xp+10);
    assert.match((await dispatch([first]))[0].text, /already processed/);
    assert.match(await command('.job delivery'), /60s remaining/);
    await d.initDatabase();
    assert.match(await command('.job delivery'), /60s remaining/);
    assert.match((await dispatch([first]))[0].text, /already processed/);
    now += 60000;
    const concurrent = await Promise.all([dispatch([message('.job delivery')]), dispatch([message('.job delivery')])]);
    assert.equal(d.jobs.history(lid).length, 2);
    assert(concurrent.flat().some(x => /cooldown/.test(x.text)));
    now += 60000;
    const same = message('.job delivery');
    await Promise.all([dispatch([same]), dispatch([same])]);
    assert.equal(d.jobs.history(lid).length, 3);
    d.updatePlayer(lid, {level:6, xp:3624});
    for (const job of JOBS.filter(j => j.id !== 'delivery')) {
        assert.match(await command('.job '+job.id), /JOB COMPLETE/);
        const h = d.jobs.history(lid)[0];
        assert(h.payout >= job.min && h.payout <= job.max);
        assert.equal(h.xp, job.xp);
        assert.match(await command('.job '+job.id), /remaining/);
    }
    assert.equal(d.getPlayer(lid).level, 7);
    assert.equal(d.getPlayer(lid).xp, 101);
    const phone = '444444@s.whatsapp.net', alias = '555555@lid';
    d.createPlayer(phone,'Phone');
    assert.match(await command('.job delivery',alias,phone), /JOB COMPLETE/);
    assert.equal(d.jobs.history(phone).length,1);
    const workPlayer = '666666@s.whatsapp.net'; d.createPlayer(workPlayer, 'Worker');
    const workBefore = d.getPlayer(workPlayer);
    assert.match(await command('.work',workPlayer,workPlayer), /WORK COMPLETE/);
    const workAfter = d.getPlayer(workPlayer);
    assert(workAfter.money-workBefore.money >= 100 && workAfter.money-workBefore.money <= 500);
    assert(workAfter.xp-workBefore.xp >= 5 && workAfter.xp-workBefore.xp <= 15);
    assert.match(await command('.work',workPlayer,workPlayer), /WORK COOLDOWN/);
    assert.equal(d.jobs.history(workPlayer).length,0);
    console.log('PASS Jobs real routing: menu, registration, level, all payouts, XP/level-up, per-job cooldown, restart, duplicate/concurrent, PN/LID tagging, history, unchanged work');
})().catch(error => {console.error(error); process.exitCode=1;}).finally(() => {
    Date.now = realNow; process.chdir(cwd);
    assert(fs.readFileSync(path.join(root,'game.db')).equals(original));
    fs.rmSync(temp,{recursive:true,force:true});
    console.log('PASS production game.db unchanged; no real socket/auth used');
});
