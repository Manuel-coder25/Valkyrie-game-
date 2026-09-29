const { randomInt } = require('node:crypto');
const { addXP, levelUpText } = require('./progression');
const JOBS = Object.freeze([
    {id:'delivery', name:'🛵 DELIVERY RIDER', description:'Deliver packages around the city.', level:1, min:500, max:1000, cooldown:60000, xp:10},
    {id:'mechanic', name:'🔧 MECHANIC', description:'Repair vehicles in the workshop.', level:4, min:1500, max:3000, cooldown:120000, xp:20},
    {id:'security', name:'🛡️ SECURITY GUARD', description:'Keep a local business safe.', level:5, min:2000, max:4000, cooldown:150000, xp:25},
    {id:'technician', name:'💻 TECHNICIAN', description:'Service computers and equipment.', level:6, min:3000, max:6000, cooldown:180000, xp:30},
    {id:'warehouse', name:'📦 WAREHOUSE WORKER', description:'Sort and pack warehouse orders.', level:2, min:800, max:1500, cooldown:75000, xp:12},
    {id:'taxi', name:'🚕 TAXI DRIVER', description:'Drive passengers to their destinations.', level:3, min:1000, max:2000, cooldown:90000, xp:15}
].map(Object.freeze));
const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_cooldowns (
 player_id TEXT NOT NULL, job_id TEXT NOT NULL, ready_at INTEGER NOT NULL,
 PRIMARY KEY(player_id, job_id));
CREATE TABLE IF NOT EXISTS job_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, job_id TEXT NOT NULL,
 action_id TEXT NOT NULL, payout INTEGER NOT NULL CHECK(payout > 0),
 xp INTEGER NOT NULL CHECK(xp >= 0), created_at INTEGER NOT NULL,
 UNIQUE(player_id, action_id));`;
function createJobs({getDb, save, restore, missionProgress = () => [], now = Date.now, random = randomInt}) {
    const rows = (sql, params = []) => {
        const r = getDb().exec(sql, params)[0];
        return r ? r.values.map(v => Object.fromEntries(r.columns.map((c,i) => [c,v[i]]))) : [];
    };
    const run = (sql, params = []) => getDb().run(sql, params);
    function history(playerId) { return rows('SELECT * FROM job_history WHERE player_id = ? ORDER BY id DESC', [playerId]); }
    // Synchronous transaction: overlapping message callbacks cannot interleave claims.
    function claim(playerId, jobId, actionId) {
        const job = JOBS.find(j => j.id === jobId);
        if (!job) return {success:false, reason:'INVALID_JOB'};
        if (typeof actionId !== 'string' || !actionId) return {success:false, reason:'MISSING_MESSAGE_ID'};
        const snapshot = getDb().export();
        run('BEGIN TRANSACTION');
        let committed = false;
        try {
            const reject = (reason, extra = {}) => { run('ROLLBACK'); return {success:false, reason, ...extra}; };
            const player = rows('SELECT * FROM players WHERE id = ?', [playerId])[0];
            if (!player) return reject('REGISTER_FIRST');
            if (rows('SELECT id FROM job_history WHERE player_id = ? AND action_id = ?', [playerId, actionId]).length) return reject('DUPLICATE');
            if (player.level < job.level) return reject('LEVEL', {level:job.level});
            const time = now();
            const cd = rows('SELECT ready_at FROM job_cooldowns WHERE player_id = ? AND job_id = ?', [playerId, job.id])[0];
            if (cd && cd.ready_at > time) return reject('COOLDOWN', {remainingMs:cd.ready_at-time});
            const draw = random(job.max-job.min+1);
            if (!Number.isInteger(draw) || draw < 0 || draw > job.max-job.min) throw new Error('Invalid random draw');
            const payout = job.min+draw;
            if (!Number.isSafeInteger(player.money) || !Number.isSafeInteger(player.money+payout)) throw new Error('Unsafe reward');
            const progression = addXP(player.level, player.xp, job.xp);
            run('UPDATE players SET money = money + ?, level = ?, xp = ? WHERE id = ?', [payout, progression.level, progression.xp, playerId]);
            run('INSERT OR REPLACE INTO job_cooldowns VALUES (?, ?, ?)', [playerId, job.id, time+job.cooldown]);
            run('INSERT INTO job_history (player_id,job_id,action_id,payout,xp,created_at) VALUES (?,?,?,?,?,?)', [playerId,job.id,actionId,payout,job.xp,time]);
            run('INSERT OR IGNORE INTO player_missions (player_id, mission_id) SELECT ?, id FROM missions WHERE active = 1', [playerId]);
            const missionCompletions = missionProgress(playerId, 'complete_job', 1, time);
            const balance = rows('SELECT money FROM players WHERE id = ?', [playerId])[0].money;
            if (!Number.isSafeInteger(balance)) throw new Error('Unsafe balance');
            run('COMMIT'); committed = true;
            save();
            return {success:true, job, payout, xp:job.xp, progression, balance, missionCompletions, isKamio:player.rank === 'KAMIO'};
        } catch (error) {
            if (committed) restore(snapshot);
            else { try { run('ROLLBACK'); } catch (_) {} }
            throw error;
        }
    }
    return {claim, history};
}
const money = n => '$'+n.toLocaleString();
function jobCommand(jobs, playerId, command, args, actionId) {
    if (command === 'jobs' || !args.length) return '💼 *JOB TYPES*\nEvery eligible shift succeeds. Each job has its own cooldown.\n\n'+JOBS.map(j =>
        `${j.name}\n${j.description}\nLevel ${j.level} • ${money(j.min)}–${money(j.max)} • ${j.xp} XP • ${j.cooldown/1000}s\n.job ${j.id}`).join('\n\n');
    if (args.length !== 1) return 'Use .job <job_id>. See .jobs.';
    const r = jobs.claim(playerId, args[0].toLowerCase(), actionId);
    if (!r.success) {
        if (r.reason === 'COOLDOWN') return `⏳ Job cooldown: ${Math.ceil(r.remainingMs/1000)}s remaining.`;
        if (r.reason === 'LEVEL') return `🔒 This job requires level ${r.level}.`;
        return {REGISTER_FIRST:'Register first with .register.', INVALID_JOB:'Unknown job. Use .jobs.',
            DUPLICATE:'✅ This job action was already processed.', MISSING_MESSAGE_ID:'Missing message ID. Send a new command.'}[r.reason];
    }
    let text = `✅ *JOB COMPLETE*\n${r.job.name}\nEarned: ${money(r.payout)}\nXP earned: ${r.xp}\nCash: ${money(r.balance)}\nJob cooldown: ${r.job.cooldown/1000}s`;
    text += levelUpText(r.progression, r.isKamio);
    for (const m of r.missionCompletions) text += `\n🎉 Mission: ${m.title} (+${money(m.reward)})`;
    return text;
}
module.exports = {JOBS, SCHEMA, createJobs, jobCommand};
