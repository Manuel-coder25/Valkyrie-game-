const { randomInt } = require('node:crypto');

const COOLDOWNS = Object.freeze({ coinflip: 5000, dice: 5000, blackjack: 10000, roulette: 10000, jackpot: 30000 });
// Fair die; integer arithmetic floors total dollar payouts, never adding value.
const DICE_TENTHS = Object.freeze([0, 0, 10, 10, 15, 22]);
function dicePayout(wager, face) {
    if (!Number.isSafeInteger(wager) || wager < 100 || wager > 100000 || !Number.isInteger(face) || face < 1 || face > 6) throw new Error('Invalid dice wager or face');
    return Math.floor(wager * DICE_TENTHS[face - 1] / 10);
}
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS casino_actions (
 player_id TEXT NOT NULL, action_id TEXT NOT NULL, response TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(player_id, action_id));
CREATE TABLE IF NOT EXISTS casino_cooldowns (
 player_id TEXT NOT NULL, game TEXT NOT NULL, ready_at INTEGER NOT NULL,
 PRIMARY KEY(player_id, game));
CREATE TABLE IF NOT EXISTS casino_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, game TEXT NOT NULL,
 wager INTEGER NOT NULL CHECK(wager BETWEEN 100 AND 100000), outcome TEXT NOT NULL,
 payout INTEGER NOT NULL CHECK(payout >= 0), net INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS casino_stats (
 player_id TEXT PRIMARY KEY, total_games INTEGER NOT NULL DEFAULT 0,
 total_wagered INTEGER NOT NULL DEFAULT 0, total_won INTEGER NOT NULL DEFAULT 0,
 total_lost INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0,
 biggest_win INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS casino_blackjack (
 player_id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS casino_jackpot (
 id INTEGER PRIMARY KEY CHECK(id = 1), pool INTEGER NOT NULL CHECK(pool >= 0));
INSERT OR IGNORE INTO casino_jackpot (id, pool) VALUES (1, 0);`;

function rouletteSelection(value) {
    const s = String(value ?? '').toLowerCase();
    return ['red', 'black', 'odd', 'even'].includes(s) || /^(?:[0-9]|[12][0-9]|3[0-6])$/.test(s) ? s : null;
}
function rouletteMultiplier(selection, number) {
    if (/^\d+$/.test(selection)) return Number(selection) === number ? 36 : 0;
    if (number === 0) return 0;
    return ({red: RED.has(number), black: !RED.has(number), odd: number % 2 === 1, even: number % 2 === 0})[selection] ? 2 : 0;
}
function handValue(cards) {
    let total = 0, aces = 0;
    for (const card of cards) { const rank = card % 13; total += rank === 0 ? 11 : Math.min(rank + 1, 10); if (rank === 0) aces++; }
    while (total > 21 && aces-- > 0) total -= 10;
    return total;
}
function cardText(cards) {
    return cards.map(c => ['A','2','3','4','5','6','7','8','9','10','J','Q','K'][c % 13] + ['♠','♥','♦','♣'][Math.floor(c / 13)]).join(' ');
}
function newDeck(draw) {
    const deck = Array.from({length: 52}, (_, i) => i);
    for (let i = 51; i > 0; i--) { const j = draw(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck;
}
function finishBlackjack(state, initial = false) {
    const p = handValue(state.player), d = handValue(state.dealer);
    if (initial && (p === 21 || d === 21)) {
        return { result: p === d ? 'push' : p === 21 ? 'blackjack' : 'dealer blackjack',
            payout: p === d ? state.wager : p === 21 ? Math.floor(state.wager * 2.5) : 0 };
    }
    if (p > 21) return { result: 'bust', payout: 0 };
    if (initial) return null;
    // Single deck, dealer stands on all 17s, including soft 17.
    while (handValue(state.dealer) < 17) state.dealer.push(state.deck.pop());
    const dealer = handValue(state.dealer);
    return dealer > 21 || p > dealer ? { result: dealer > 21 ? 'dealer bust' : 'win', payout: state.wager * 2 }
        : p === dealer ? { result: 'push', payout: state.wager } : { result: 'loss', payout: 0 };
}

// All writes run synchronously on the bot's existing sql.js connection. No await inside a transaction.
function createCasino({ getDb, save, restore, missionProgress = () => [], now = Date.now, random = randomInt }) {
    const rows = (sql, params = []) => {
        const r = getDb().exec(sql, params)[0];
        return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
    };
    const run = (sql, params = []) => getDb().run(sql, params);
    function draw(n) { const value = random(n); if (!Number.isInteger(value) || value < 0 || value >= n) throw new Error('Invalid random draw'); return value; }
    function history(playerId) { return rows('SELECT * FROM casino_history WHERE player_id = ? ORDER BY id DESC', [playerId]); }
    function stats(playerId) { return rows('SELECT * FROM casino_stats WHERE player_id = ?', [playerId])[0] || null; }
    function leaderboard() { return rows(`SELECT s.*, p.name FROM casino_stats s JOIN players p ON p.id = s.player_id
        ORDER BY s.net DESC, s.biggest_win DESC, s.player_id LIMIT 10`); }
    function pool() { return rows('SELECT pool FROM casino_jackpot WHERE id = 1')[0].pool; }
    function active(playerId) { const row = rows('SELECT state FROM casino_blackjack WHERE player_id = ?', [playerId])[0]; return row ? JSON.parse(row.state) : null; }
    function settle(playerId, game, wager, payout, outcome, time) {
        const net = payout - wager;
        const money = rows('SELECT money FROM players WHERE id = ?', [playerId])[0].money;
        if (!Number.isSafeInteger(payout) || payout < 0 || !Number.isSafeInteger(money + payout)) throw new Error('Unsafe payout');
        run('UPDATE players SET money = money + ? WHERE id = ?', [payout, playerId]);
        run(`INSERT INTO casino_history (player_id, game, wager, outcome, payout, net, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [playerId, game, wager, JSON.stringify(outcome), payout, net, time]);
        // Won/lost are positive/negative NET amounts. Pushes affect neither; biggest win is net profit.
        run('INSERT OR IGNORE INTO casino_stats (player_id) VALUES (?)', [playerId]);
        run(`UPDATE casino_stats SET total_games = total_games + 1, total_wagered = total_wagered + ?,
            total_won = total_won + ?, total_lost = total_lost + ?, net = net + ?, biggest_win = MAX(biggest_win, ?)
            WHERE player_id = ?`, [wager, Math.max(net, 0), Math.max(-net, 0), net, Math.max(net, 0), playerId]);
        run(`INSERT OR IGNORE INTO player_missions (player_id, mission_id) SELECT ?, id FROM missions WHERE active = 1`, [playerId]);
        const missionCompletions = missionProgress(playerId, 'play_casino', 1, time);
        return { success: true, game, wager, payout, net, ...outcome, missionCompletions };
    }
    function play(playerId, game, wagerInput, selectionInput, actionId) {
        if (!Object.hasOwn(COOLDOWNS, game)) return {success: false, reason: 'INVALID_GAME'};
        if (typeof actionId !== 'string' || !actionId) return {success: false, reason: 'MISSING_MESSAGE_ID'};
        const snapshot = getDb().export();
        run('BEGIN TRANSACTION');
        let committed = false;
        try {
            const reject = reason => { run('ROLLBACK'); return {success: false, reason}; };
            const player = rows('SELECT money FROM players WHERE id = ?', [playerId])[0];
            if (!player) return reject('REGISTER_FIRST');
            const previous = rows('SELECT response FROM casino_actions WHERE player_id = ? AND action_id = ?', [playerId, actionId])[0];
            if (previous) { run('ROLLBACK'); return {...JSON.parse(previous.response), duplicate: true}; }
            const time = now();
            const selection = String(selectionInput ?? '').toLowerCase();
            const continuation = game === 'blackjack' && ['hit', 'stand'].includes(selection);
            let state = game === 'blackjack' ? active(playerId) : null;
            let wager, result;
            if (continuation) {
                if (!state) return reject('NO_BLACKJACK');
                wager = state.wager;
            } else {
                if (state) return reject('BLACKJACK_ACTIVE');
                if (!/^[0-9]+$/.test(String(wagerInput))) return reject('INVALID_BET');
                wager = Number(wagerInput);
                if (!Number.isSafeInteger(wager) || wager < 100 || wager > 100000) return reject('INVALID_BET');
                if (game === 'coinflip' && !['heads', 'tails'].includes(selection)) return reject('INVALID_SELECTION');
                if (game === 'roulette' && !rouletteSelection(selection)) return reject('INVALID_SELECTION');
                if (['dice','jackpot','blackjack'].includes(game) && selection) return reject('INVALID_SELECTION');
                const cooldown = rows('SELECT ready_at FROM casino_cooldowns WHERE player_id = ? AND game = ?', [playerId, game])[0];
                if (cooldown && cooldown.ready_at > time) { run('ROLLBACK'); return {success: false, reason: 'COOLDOWN', remainingMs: cooldown.ready_at - time}; }
                if (!Number.isSafeInteger(player.money) || player.money < wager) return reject('INSUFFICIENT_CASH');
                run('UPDATE players SET money = money - ? WHERE id = ? AND money >= ?', [wager, playerId, wager]);
                if (getDb().getRowsModified() !== 1) throw new Error('Wager failed');
                run('INSERT OR REPLACE INTO casino_cooldowns (player_id, game, ready_at) VALUES (?, ?, ?)', [playerId, game, time + COOLDOWNS[game]]);
            }
            if (game === 'blackjack') {
                let ending;
                if (!continuation) {
                    const deck = newDeck(draw);
                    state = {wager, deck, player: [deck.pop()], dealer: [deck.pop()], startedAt: time};
                    state.player.push(deck.pop()); state.dealer.push(deck.pop());
                    ending = finishBlackjack(state, true);
                } else {
                    if (selection === 'hit') state.player.push(state.deck.pop());
                    if (selection === 'stand' || handValue(state.player) >= 21) ending = finishBlackjack(state);
                }
                if (ending) {
                    run('DELETE FROM casino_blackjack WHERE player_id = ?', [playerId]);
                    run('INSERT OR REPLACE INTO casino_cooldowns VALUES (?, ?, ?)', [playerId, game, time + COOLDOWNS.blackjack]);
                    result = settle(playerId, game, wager, ending.payout, {result: ending.result, player: state.player, dealer: state.dealer}, time);
                } else {
                    run('INSERT OR REPLACE INTO casino_blackjack VALUES (?, ?)', [playerId, JSON.stringify(state)]);
                    result = {success: true, game, wager, pending: true, player: state.player, dealer: [state.dealer[0]]};
                }
            } else {
                let payout = 0, outcome;
                if (game === 'coinflip') {
                    const face = draw(2) === 0 ? 'heads' : 'tails';
                    payout = face === selection ? wager * 2 : 0;
                    outcome = {result: face, selection};
                } else if (game === 'dice') {
                    const face = draw(6) + 1;
                    payout = dicePayout(wager, face);
                    outcome = {result: `Dice Duel: rolled ${face}`, face, multiplier: DICE_TENTHS[face - 1] / 10};
                } else if (game === 'roulette') {
                    const number = draw(37); payout = wager * rouletteMultiplier(selection, number);
                    outcome = {result: `${number} (${number === 0 ? 'green' : RED.has(number) ? 'red' : 'black'})`, selection};
                } else {
                    // Every bet contributes 90% (rounded down). 10% is the house share.
                    // Independent 1/100 win probability, regardless of wager or history; winner takes entire pool including contribution.
                    const contribution = Math.floor(wager * 0.9), nextPool = pool() + contribution;
                    if (!Number.isSafeInteger(nextPool)) throw new Error('Unsafe jackpot pool');
                    const win = draw(100) === 0;
                    payout = win ? nextPool : 0;
                    run('UPDATE casino_jackpot SET pool = ? WHERE id = 1', [win ? 0 : nextPool]);
                    outcome = {result: win ? 'JACKPOT!' : 'No jackpot', contribution, pool: win ? 0 : nextPool};
                }
                result = settle(playerId, game, wager, payout, outcome, time);
            }
            result.balance = rows('SELECT money FROM players WHERE id = ?', [playerId])[0].money;
            run('INSERT INTO casino_actions VALUES (?, ?, ?, ?)', [playerId, actionId, JSON.stringify(result), time]);
            run('COMMIT'); committed = true;
            save();
            return result;
        } catch (error) {
            if (committed) restore(snapshot);
            else { try { run('ROLLBACK'); } catch (_) {} }
            throw error;
        }
    }
    return {play, history, stats, leaderboard, pool, active};
}
module.exports = { SCHEMA, COOLDOWNS, DICE_TENTHS, dicePayout, rouletteSelection, rouletteMultiplier,
    handValue, cardText, finishBlackjack, createCasino };
