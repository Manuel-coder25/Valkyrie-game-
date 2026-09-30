const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname,'..');
function protectedHashes() {
    const values = {};
    function walk(p) {
        const file = path.join(root,p);
        if (!fs.existsSync(file)) return;
        if (fs.statSync(file).isDirectory()) for (const child of fs.readdirSync(file).sort()) walk(p+'/'+child);
        else values[p] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
    for (const p of ['game.db','auth','progression.js','core-migration.js']) walk(p);
    return values;
}
async function fixture(test) {
    const before = protectedHashes(), cwd = process.cwd();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(),'valkyrie-expansion-'));
    const realNow = Date.now;
    let now = 1800000000000;
    Date.now = () => now;
    process.chdir(temp);
    try {
        const SQL = await require('sql.js')();
        const d = require(path.join(root,'database'));
        await d.initDatabase();
        const rows = (sql,params=[]) => {
            const db = new SQL.Database(fs.readFileSync('game.db'));
            try {
                const r = db.exec(sql,params)[0];
                return r ? r.values.map(v => Object.fromEntries(r.columns.map((c,i) => [c,v[i]]))) : [];
            } finally { db.close(); }
        };
        const edit = async (sql,params=[]) => {
            const db = new SQL.Database(fs.readFileSync('game.db'));
            try { db.run(sql,params); fs.writeFileSync('game.db',db.export()); } finally { db.close(); }
            await d.initDatabase();
        };
        const player = (id,fields={}) => {
            d.createPlayer(id,id);
            d.updatePlayer(id,{money:10000000,...fields});
            return d.getPlayer(id);
        };
        const failSave = (operation, watch) => {
            const bytes = fs.readFileSync('game.db'), state = watch(), rename = fs.renameSync;
            fs.renameSync = () => { throw new Error('injected save failure'); };
            try { assert.throws(operation,/injected save failure/); } finally { fs.renameSync = rename; }
            assert.deepEqual(watch(),state,'in-memory state must roll back');
            assert(fs.readFileSync('game.db').equals(bytes),'durable state must remain unchanged');
        };
        await test({d,SQL,rows,edit,player,failSave,root,now:()=>now,setNow:value=>{now=value;},advance:ms=>{now+=ms;}});
    } finally {
        Date.now = realNow;
        process.chdir(cwd);
        fs.rmSync(temp,{recursive:true,force:true});
        assert.deepEqual(protectedHashes(),before,'production DB/auth/progression/core migration changed');
        console.log('PASS production DB/auth and approved progression/core migration unchanged');
    }
}
module.exports = {fixture};
