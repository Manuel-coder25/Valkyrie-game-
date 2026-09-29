const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function protectedFiles(){
    const result={};
    function walk(relative){const absolute=path.join(root,relative);if(!fs.existsSync(absolute))return;
        if(fs.statSync(absolute).isDirectory())for(const entry of fs.readdirSync(absolute).sort())walk(path.join(relative,entry));
        else result[relative]=crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');}
    walk('game.db');walk('auth');return result;
}
const before=protectedFiles();let failed=false;
try {
    const sources=['index.js','database.js','progression.js','missions.js','weapons.js','shields.js','jobs.js',
        'casino.js','casino-commands.js','player-replies.js','healing.js','core-migration.js',
        ...fs.readdirSync(__dirname).filter(n=>n.endsWith('.js')).map(n=>'tests/'+n)];
    for(const file of sources){const r=spawnSync(process.execPath,['--check',file],{cwd:root,encoding:'utf8'});
        if(r.status!==0)throw new Error(`${file}: ${r.stderr || r.error}`);}
    console.log(`PASS syntax: ${sources.length} JavaScript files`);
    const suites=fs.readdirSync(__dirname).filter(n=>n.endsWith('-regression.js')).sort();
    for(const suite of suites){console.log(`\nRUN ${suite}`);const r=spawnSync(process.execPath,[path.join(__dirname,suite)],{cwd:root,stdio:'inherit'});
        if(r.status!==0){failed=true;console.error(`FAIL ${suite}: ${r.status ?? r.error}`);}}
    console.log(`\n${failed?'FAIL':'PASS'} ${suites.length} regression suites`);
} catch(error){failed=true;console.error(error);}
finally {
    const after=protectedFiles();
    if(JSON.stringify(before)!==JSON.stringify(after)){failed=true;console.error('FAIL production game.db/auth integrity changed');}
    else console.log('PASS production game.db and complete auth tree unchanged');
    process.exitCode=failed?1:0;
}
