const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const production = path.join(root, 'game.db');
const hash = () => fs.existsSync(production) ? crypto.createHash('sha256').update(fs.readFileSync(production)).digest('hex') : null;
const before = hash(), cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-regression-'));
process.chdir(temp);
const d = require(path.join(root, 'database'));
const rules = require(path.join(root, 'casino'));
const { casinoCommand } = require(path.join(root, 'casino-commands'));
let db, casino, SQL, time = 100000, seq = 0, picks = [], failSave = false;
const player = '10101@s.whatsapp.net';
const row = (sql, params = []) => db.exec(sql, params)[0]?.values[0];
const cash = () => row('SELECT money FROM players WHERE id = ?', [player])[0];
function create() {
    casino = rules.createCasino({getDb: () => db, now: () => time,
        random: n => picks.length ? picks.shift() : n - 1,
        save: () => { if (failSave) throw new Error('disk failure'); fs.writeFileSync('casino-test.db', db.export()); },
        restore: bytes => { db.close(); db = new SQL.Database(bytes); }});
}
function play(game, wager = 100, selection = '', id = `action-${++seq}`) { return casino.play(player, game, wager, selection, id); }
function advance() { time += 31000; }
function fixture(p, dealer, deck = [9]) {
    advance();
    db.run('DELETE FROM casino_blackjack');
    db.run('UPDATE players SET money = 10000 WHERE id = ?', [player]);
    db.run('INSERT INTO casino_blackjack VALUES (?, ?)', [player, JSON.stringify({wager: 100, player: p, dealer, deck})]);
}
(async () => {
    await d.initDatabase();
    d.createPlayer(player, 'Casino Tester'); d.updatePlayer(player, {money: 10000000});
    SQL = await require('sql.js')();
    db = new SQL.Database(fs.readFileSync('game.db')); create();
    assert.equal(casino.play('missing', 'coinflip', 100, 'heads', 'x').reason, 'REGISTER_FIRST');
    assert.equal(play('coinflip', 100, 'heads', '').reason, 'MISSING_MESSAGE_ID');
    const untouched = cash();
    for (const bet of [0, -100, 99, 100001, 100.5, '100x', '1e3', '', NaN, Infinity, null]) {
        assert.equal(play('coinflip', bet, 'heads').reason, 'INVALID_BET');
    }
    assert.equal(play('coinflip', 100, 'side').reason, 'INVALID_SELECTION');
    assert.equal(play('roulette', 100, '37').reason, 'INVALID_SELECTION');
    assert.equal(cash(), untouched); assert.equal(casino.history(player).length, 0);
    picks = [0]; let r = play('coinflip', 100, 'heads', 'win');
    assert.equal(r.payout, 200); assert.equal(cash(), untouched + 100);
    assert.equal(play('coinflip', 100, 'heads').reason, 'COOLDOWN');
    const duplicate = play('coinflip', 100, 'heads', 'win');
    assert(duplicate.duplicate); assert.equal(casino.history(player).length, 1);
    // New connection simulates restart, retaining cooldown, history, action IDs and stats.
    db.close(); db = new SQL.Database(fs.readFileSync('casino-test.db')); create();
    assert.equal(play('coinflip', 100, 'tails').reason, 'COOLDOWN');
    assert(play('coinflip', 100, 'heads', 'win').duplicate);
    assert.equal(casino.history(player)[0].payout, 200);
    advance(); picks = [1]; r = play('coinflip', 100000, 'heads');
    assert.equal(r.payout, 0); assert.equal(r.net, -100000);
    assert.deepEqual(casino.stats(player), {player_id: player, total_games: 2, total_wagered: 100100,
        total_won: 100, total_lost: 100000, net: -99900, biggest_win: 100});
    assert.equal(casino.leaderboard()[0].name, 'Casino Tester');
    advance(); db.run('UPDATE players SET money = 99 WHERE id = ?', [player]);
    assert.equal(play('dice').reason, 'INSUFFICIENT_CASH'); assert.equal(cash(), 99);
    db.run('UPDATE players SET money = 10000000 WHERE id = ?', [player]);
    // Invalid RNG after debit must roll back cash, cooldown, history and dedup entry.
    const count = casino.history(player).length;
    picks = [100]; assert.throws(() => play('dice', 100, '', 'retry'), /Invalid random/);
    assert.equal(cash(), 10000000); assert.equal(casino.history(player).length, count);
    picks = [5]; r = play('dice', 100, '', 'retry'); assert.equal(r.payout, 220);
    advance(); failSave = true; picks = [0]; const cashBefore = cash(), gamesBefore = casino.history(player).length;
    assert.throws(() => play('coinflip', 100, 'heads', 'disk-retry'), /disk failure/);
    assert.equal(cash(), cashBefore); assert.equal(casino.history(player).length, gamesBefore);
    failSave = false; picks = [0]; assert(play('coinflip', 100, 'heads', 'disk-retry').success);
    // Enumerate all six fair-die outcomes and verify the published exact RTP.
    const totals = [0,0,100,100,150,220];
    assert.equal(totals.reduce((a,b) => a+b,0)/600,0.95);
    for (let face = 1; face <= 6; face++) {
        advance(); picks = [face-1]; r = play('dice');
        assert.equal(r.payout,totals[face-1]);
    }
    for (const invalid of ['-1','37','1.5','00','REDx','']) assert.equal(rules.rouletteSelection(invalid), null);
    for (let n = 0; n <= 36; n++) {
        assert.equal(rules.rouletteMultiplier(String(n), n), 36);
        for (const outside of ['red','black','odd','even']) assert.equal(rules.rouletteMultiplier(outside, 0), 0);
    }
    for (const [selection, n, payout] of [['red',1,200],['black',2,200],['odd',3,200],['even',4,200],['0',0,3600],['36',36,3600],['red',0,0],['1',2,0]]) {
        advance(); picks = [n]; assert.equal(play('roulette',100,selection).payout, payout);
    }
    advance(); picks = [1]; r = play('jackpot', 101); assert.equal(r.contribution, 90); assert.equal(casino.pool(),90);
    db.close(); db = new SQL.Database(fs.readFileSync('casino-test.db')); create();
    assert.equal(casino.pool(), 90); assert.equal(play('jackpot').reason, 'COOLDOWN');
    advance(); picks = [0]; r = play('jackpot'); assert.equal(r.payout,180); assert.equal(casino.pool(),0);
    assert(play('jackpot', 100, '', `action-${seq}`).duplicate); assert.equal(casino.pool(), 0);
    // Concurrent callbacks in one sql.js process serialize; only one debit for a shared action ID.
    advance(); picks = [0]; const beforeConcurrent = cash();
    const results = await Promise.all(Array.from({length: 12}, () => Promise.resolve().then(() => play('coinflip',100,'heads','concurrent'))));
    assert.equal(results.filter(x => x.duplicate).length,11); assert.equal(cash(),beforeConcurrent+100);
    advance(); const concurrent = await Promise.all([Promise.resolve().then(() => play('dice')), Promise.resolve().then(() => play('dice'))]);
    assert.equal(concurrent.filter(x => x.success).length,1); assert.equal(concurrent[1].reason,'COOLDOWN');
    // Different players can contribute concurrently without losing pool updates.
    advance();
    db.run("INSERT INTO players (id,name,money) VALUES ('second','Second',1000)");
    const poolBefore = casino.pool(); picks = [1,1];
    const pooled = await Promise.all([
        Promise.resolve().then(() => play('jackpot',100,'','pool-a')),
        Promise.resolve().then(() => casino.play('second','jackpot',200,'','pool-b'))
    ]);
    assert(pooled.every(x => x.success)); assert.equal(casino.pool(),poolBefore+270);
    assert.equal(casino.play('second','jackpot',100,'','pool-c').reason,'COOLDOWN');
    time += 30000; picks = [0];
    assert.equal(casino.play('second','jackpot',100,'','pool-c').payout,poolBefore+360);
    assert.equal(casino.pool(),0);
    console.log('PASS validation, bounds, cash, rollback, disk failure, restart, history, stats, dice odds, roulette, jackpot, concurrent actions');

    // Build Fisher-Yates draws that produce a chosen opening deal (still a full legal deck).
    function dealDraws(opening) {
        const desired = Array.from({length:52},(_,i)=>i).filter(c => !opening.includes(c)).concat([...opening].reverse());
        const working = Array.from({length:52},(_,i)=>i), draws = [];
        for (let i=51;i>0;i--) { const j = working.indexOf(desired[i]); draws.push(j); [working[i],working[j]]=[working[j],working[i]]; }
        return draws;
    }
    for (const [opening, expected, payout] of [
        [[0,8,9,7],'blackjack',250], [[8,0,7,9],'dealer blackjack',0], [[0,13,9,22],'push',100]
    ]) {
        advance(); picks = dealDraws(opening); const startingCash = cash();
        const natural = play('blackjack'); assert.equal(natural.result,expected); assert.equal(natural.payout,payout);
        assert.equal(cash(),startingCash-100+payout); assert.equal(casino.active(player),null);
    }
    assert.equal(rules.handValue([0,13,9]),12); assert.equal(rules.handValue([0,5]),17);
    assert.deepEqual(rules.finishBlackjack({wager:101,player:[0,9],dealer:[8,9],deck:[]},true),{result:'blackjack',payout:252});
    assert.equal(rules.finishBlackjack({wager:100,player:[0,9],dealer:[13,22],deck:[]},true).result,'push');
    assert.equal(rules.finishBlackjack({wager:100,player:[8,9],dealer:[0,9],deck:[]},true).payout,0);
    for (const [p, dealer, deck, expected, payout] of [
        [[9,8],[9,7],[],'win',200], [[9,6],[9,7],[],'loss',0],
        [[9,7],[9,7],[],'push',100], [[9,8,2],[9,7],[],'bust',0],
        [[9,7],[9,5],[9],'dealer bust',200], [[9,7],[0,5],[9],'win',200]
    ]) {
        fixture(p,dealer,deck); r = play('blackjack',undefined,'stand');
        assert.equal(r.result,expected); assert.equal(r.payout,payout);
        assert.equal(casino.active(player),null); assert.equal(play('blackjack').reason,'COOLDOWN');
        if (dealer[0] === 0) assert.equal(r.dealer.length,2); // soft 17 stands
    }
    fixture([9,5],[9,6],[9]); r = play('blackjack',undefined,'hit'); assert.equal(r.result,'bust');
    fixture([1,2],[9,6],[3]); r = play('blackjack',undefined,'hit'); assert(r.pending); assert.equal(r.player.length,3);
    assert.equal(cash(),10000); assert(play('blackjack',undefined,'hit',`action-${seq}`).duplicate);
    // Start a real shuffled round, persist it and settle after restart.
    db.run('DELETE FROM casino_blackjack'); advance(); picks = [];
    r = play('blackjack'); assert(r.pending); assert.equal(r.dealer.length,1); assert.equal(cash(),9900);
    const actualState = casino.active(player); assert.equal(new Set([...actualState.deck,...actualState.player,...actualState.dealer]).size,52);
    assert.equal(play('blackjack').reason,'BLACKJACK_ACTIVE');
    db.close(); db = new SQL.Database(fs.readFileSync('casino-test.db')); create();
    assert.deepEqual(casino.active(player),actualState);
    assert(!casinoCommand(casino,player,'blackjack',['status']).includes(cardTextHidden(actualState.dealer[1])));
    r = play('blackjack',undefined,'stand','finish'); assert(!r.pending); assert.equal(casino.active(player),null);
    assert(play('blackjack',undefined,'stand','finish').duplicate);
    assert.equal(play('blackjack',undefined,'hit').reason,'NO_BLACKJACK');
    for (const game of ['coinflip','dice','blackjack','roulette','jackpot']) {
        const help = casinoCommand(casino,player,game,[]); assert(help.includes('.casino leaderboard'));
    }
    assert(casinoCommand(casino,player,'games',[]).includes('95%'));
    assert(casinoCommand(casino,player,'casino',['leaderboard']).includes('Casino Tester'));
    const amount = cash(); casinoCommand(casino,player,'dice',['100','extra'],'extra'); assert.equal(cash(),amount);
    console.log('PASS blackjack natural/dealer natural/push/bust/win/loss, soft-17, persistent deck, reservation, duplicate hit/stand, help');
    // Actual database adapter and existing mission transaction helper.
    db.close(); db = null;
    const missionDb = new SQL.Database(fs.readFileSync('game.db'));
    missionDb.run(`INSERT INTO missions (id,type,title,description,requirement,target_amount,reward,active)
        VALUES ('casino_test','play_casino','Casino test','test','test',1,50,1)`);
    fs.writeFileSync('game.db',missionDb.export()); missionDb.close();
    await d.initDatabase();
    const settled = d.casino.play(player,'coinflip',100,'heads','actual');
    assert.equal(settled.missionCompletions[0].reward,50);
    assert.equal(d.getPlayer(player).money,10000000 + settled.net + 50);
    const bank = d.getPlayer(player).bank;
    await d.initDatabase(); assert(d.casino.play(player,'coinflip',100,'heads','actual').duplicate);
    assert.equal(d.getPlayer(player).bank, bank);
    assert.equal(d.getPlayerMissions(player).find(m => m.id === 'casino_test').rewarded,1);
    console.log('PASS actual database adapter, persistent deduplication, cash-only and atomic mission progress');
    // Existing weapon catalogue/equip/combat/mission and shield durability behavior on a fresh DB.
    const { WEAPON_CATALOGUE } = require(path.join(root,'weapons'));
    const victim = '20202@s.whatsapp.net'; d.createPlayer(victim,'Victim');
    let weaponIndex = 0;
    for (const weapon of Object.values(WEAPON_CATALOGUE)) {
        const fighter = `fighter-${weaponIndex++}`; d.createPlayer(fighter,'Fighter');
        d.updatePlayer(fighter,{money:20000000});
        assert(d.buyItem(fighter,weapon.id).success); assert(d.equipItem(fighter,weapon.id).success);
        d.updatePlayer(victim,{health:100});
        const attack = d.executeAttack(fighter,victim,`weapon-${weapon.id}`);
        assert.equal(attack.damage,Math.min(50,weapon.damage)); assert.equal(attack.health,100-Math.min(50,weapon.damage));
        assert.equal(d.executeAttack(fighter,victim,`weapon-${weapon.id}`).reason,'DUPLICATE');
        if (weapon.damage >= 50) {
            const finisher = fighter+'-finisher'; d.createPlayer(finisher,'Finisher');
            d.addItem(finisher,weapon.id); d.equipItem(finisher,weapon.id);
            assert(d.executeAttack(finisher,victim,'finish-'+weapon.id).defeated);
            assert.equal(d.getPlayerMissions(finisher).find(m=>m.id==='win_first_attack').rewarded,1);
            d.recoverPlayers(Date.now()+d.RECOVERY_DURATION+1000);
        }
    }
    d.recoverPlayers(Date.now() + d.RECOVERY_DURATION + 1000);
    d.addItem(victim,'light_shield'); assert(d.equipItem(victim,'light_shield').success);
    const gunner = 'gunner'; d.createPlayer(gunner,'Gunner'); d.addItem(gunner,'smg'); d.equipItem(gunner,'smg');
    const shot = d.executeAttack(gunner,victim,'shield-shot');
    assert.equal(shot.shieldAbsorbed,25); assert.equal(shot.healthDamage,10); assert(shot.shieldDepleted);
    assert.equal(d.executeAttack(gunner,victim,'shield-too-soon').reason,'COOLDOWN');
    await d.initDatabase(); assert.equal(d.getEquippedShield(victim).remaining,0);
    console.log('PASS every weapon damage/equip, combat deduplication/cooldown, defeat mission, shield depletion/persistence');

})().catch(e => {console.error(e);process.exitCode=1;}).finally(() => {
    if (db) db.close(); process.chdir(cwd); assert.equal(hash(),before);
    fs.rmSync(temp,{recursive:true,force:true}); console.log('PASS production game.db unchanged');
});
function cardTextHidden(card) { return rules.cardText([card]); }
