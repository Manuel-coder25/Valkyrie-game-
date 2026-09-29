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
    const kamio='2349169761233@s.whatsapp.net';
    d.createPlayer(pn,'Ordinary player');
    let lookups=0;
    sock.groupMetadata=async chat=>{
        assert.equal(chat,group);lookups++;
        return {participants:[{id:kamio},{id:pn},{id:target},
            {id:'555555:2@s.whatsapp.net'},{id:target},
            {id:'invalid',lid:'666666@lid'},{id:'status@broadcast'}]};
    };
    const before=fs.readFileSync('game.db');
    assert.equal((await dispatch([message('.broadcast No permission',pn,pn)])).length,0);
    assert.equal(lookups,0,'permission check precedes member lookup');
    assert.match(await command('.broadcast',kamio,kamio),/Usage/);
    assert.equal(lookups,0,'empty announcements never fetch members');
    const output=await dispatch([message('.broadcast Welcome to Valkyrie!',kamio,kamio)]);
    assert.equal(output.length,1);assert.equal(output[0].jid,group);
    assert.match(output[0].text,/VALKYRIE ANNOUNCEMENT/);
    assert.match(output[0].text,/Welcome to Valkyrie!/);
    assert.deepEqual(output[0].mentions,[kamio,pn,target,'555555@s.whatsapp.net','666666@lid']);
    for(const id of output[0].mentions)assert(output[0].text.includes('@'+id.split('@')[0]));
    assert.equal(d.getPlayer(target),null,'unregistered group members are also tagged');
    assert.equal(new Set(output[0].mentions).size,output[0].mentions.length);
    assert(fs.readFileSync('game.db').equals(before),'announcement must not change player data');
    const wrapped=message('.broadcast Wrapped announcement',kamio,kamio);
    wrapped.message={ephemeralMessage:{message:wrapped.message}};
    assert.match((await dispatch([wrapped]))[0].text,/Wrapped announcement/);
    // Large groups are still one group message with a complete mentions array.
    const members=Array.from({length:1024},(_,i)=>({id:`${700000+i}@lid`}));
    sock.groupMetadata=async()=>({participants:members});
    const large=(await dispatch([message('.broadcast Group event',kamio,kamio)]))[0];
    assert.equal(large.mentions.length,1025); // global reply includes the sender too
    assert(large.mentions.includes('701023@lid'));
    // Metadata failure must produce a tagged error, never a partial announcement.
    for(const metadata of [null,{participants:[]},{participants:[{id:'invalid'}]}]) {
        sock.groupMetadata=async()=>metadata;
        const start=sent.length;
        await handlers['messages.upsert']({type:'notify',messages:[message('.broadcast Not sent',kamio,kamio)]});
        assert.equal(sent.length,start+1);assert.match(sent[start].text,/announcement was not sent/);
        assert(!sent[start].text.includes('VALKYRIE ANNOUNCEMENT'));
        assert(sent[start].mentions.includes(kamio));assert.equal(errors.length,1);errors.length=0;
    }
    sock.groupMetadata=async()=>{throw new Error('offline');};
    let start=sent.length;
    await handlers['messages.upsert']({type:'notify',messages:[message('.broadcast Network failure',kamio,kamio)]});
    assert.equal(sent.length,start+1);assert.match(sent[start].text,/announcement was not sent/);
    assert.equal(errors.length,1);errors.length=0;
    // Existing direct-chat behavior remains a single reply, without group lookup.
    const direct=message('.broadcast Private announcement',kamio,kamio);
    direct.key={remoteJid:kamio,id:'direct-announcement'};
    const dm=await dispatch([direct]);assert.equal(dm.length,1);assert.equal(dm[0].jid,kamio);
    assert.match(dm[0].text,/Private announcement/);assert.deepEqual(dm[0].mentions,[kamio]);
    console.log('PASS KAMIO-only group announcements, all members including unregistered, phone/LID IDs, deduplication, 1024 members, wrapped messages, metadata failures, direct chats and no player-data writes');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
    Date.now=realNow;process.chdir(cwd);assert(fs.readFileSync(path.join(root,'game.db')).equals(original));fs.rmSync(temp,{recursive:true,force:true});
    console.log('PASS production game.db unchanged; no real socket/auth used');
});
