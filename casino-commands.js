const { cardText, handValue } = require('./casino');
const COMMANDS = new Set(['casino', 'games', 'coinflip', 'dice', 'blackjack', 'roulette', 'jackpot']);
const money = amount => '$' + Number(amount).toLocaleString();
const HELP = `🎲 *VALKYRIE CASINO*
Cash only • whole dollars • $100–$100,000
Payouts below include your original wager.

1. 🎲 Coin Flip: .coinflip <heads|tails> <bet>
50/50; correct guess pays 2×. Cooldown: 5s.
2. 🎲 Dice Duel: .dice <bet>
One fair six-sided die. 1–2 lose; 3–4 push; 5 pays 1.5×; 6 pays 2.2×.
Total payouts rounded down to whole dollars. Theoretical return: 95% before rounding.
Cooldown: 5s.
3. 🃏 Blackjack: .blackjack <bet>
Then .blackjack hit / .blackjack stand; .blackjack status to resume.
Single deck; dealer stands on soft 17. Win 2×, natural 2.5× (rounded down), push 1×.
No split, double or insurance. Wager is reserved until finished, even across restarts.
Cooldown: 10s after settlement.
4. 🎯 Roulette: .roulette <red|black|odd|even|0–36> <bet>
European single-zero (37 pockets). Outside bets pay 2×; number pays 36×.
Zero loses all outside bets. Cooldown: 10s.
5. 💎 Jackpot: .jackpot <bet>
90% of each bet (rounded down) enters the pool; remainder goes to house.
Independent 1-in-100 chance to win the whole pool, including your contribution.
Pool starts/resets at $0; a win can return less than your wager. Cooldown: 30s.
6. 🏆 .casino leaderboard

Also: .casino <game> … • .casino stats
Example: .coinflip heads 100`;
const ERRORS = {
    REGISTER_FIRST: 'Register first with .register.', INVALID_BET: 'Bet a whole-dollar amount from $100 to $100,000.',
    INSUFFICIENT_CASH: 'You do not have enough cash.', INVALID_SELECTION: 'Invalid selection. Use .casino for game rules and syntax.',
    INVALID_GAME: 'Unknown casino game. Use .casino.', MISSING_MESSAGE_ID: 'Missing message ID. Send a new command.',
    BLACKJACK_ACTIVE: 'You already have a blackjack round. Use .blackjack status, hit or stand.',
    NO_BLACKJACK: 'No active blackjack round. Start with .blackjack <bet>.'
};
function blackjackText(result) {
    return `🃏 You: ${cardText(result.player)} (${handValue(result.player)})\nDealer: ${cardText(result.dealer)}` +
        (result.pending ? ' [hidden]\n.blackjack hit / .blackjack stand' : ` (${handValue(result.dealer)})`);
}
function statText(s) {
    return s ? `Games: ${s.total_games} • Wagered: ${money(s.total_wagered)}\nProfit won: ${money(s.total_won)} • Losses: ${money(s.total_lost)}\nNet: ${money(s.net)} • Biggest profit: ${money(s.biggest_win)}` : 'No completed casino games yet.';
}
function casinoCommand(casino, playerId, command, args, actionId) {
    args = args.map(String);
    if (command === 'casino' || command === 'games') {
        if (!args.length || args[0].toLowerCase() === 'help') return HELP + `\n\n💎 Current pool: ${money(casino.pool())}`;
        command = args.shift().toLowerCase();
    }
    if (command === 'leaderboard') {
        if (args.length) return 'Use .casino leaderboard';
        const top = casino.leaderboard();
        return '🏆 *CASINO LEADERBOARD*\nRanked by net profit from completed games.\n\n' +
            (top.length ? top.map((s, i) => `${i + 1}. ${s.name}\n${statText(s)}`).join('\n\n') : 'No completed games yet.');
    }
    if (command === 'stats') return statText(casino.stats(playerId));
    if (!COMMANDS.has(command) || ['casino','games'].includes(command)) return ERRORS.INVALID_GAME;
    if (!args.length || args[0].toLowerCase() === 'help') return HELP;
    if (command === 'blackjack' && args[0].toLowerCase() === 'status' && args.length === 1) {
        const state = casino.active(playerId);
        return state ? blackjackText({player: state.player, dealer: [state.dealer[0]], pending: true}) + `\nReserved wager: ${money(state.wager)}` : ERRORS.NO_BLACKJACK;
    }
    let wager, selection = '';
    if (['coinflip','roulette'].includes(command)) {
        if (args.length !== 2) return ERRORS.INVALID_SELECTION;
        [selection, wager] = args;
    } else {
        if (args.length !== 1) return ERRORS.INVALID_SELECTION;
        if (command === 'blackjack' && ['hit','stand'].includes(args[0].toLowerCase())) selection = args[0].toLowerCase();
        else wager = args[0];
    }
    const result = casino.play(playerId, command, wager, selection, actionId);
    if (!result.success) return result.reason === 'COOLDOWN' ? `⏳ Wait ${Math.ceil(result.remainingMs / 1000)}s before playing ${command} again.` : ERRORS[result.reason];
    // Re-delivered actions do not replay stale hit/stand instructions or repeat reward notifications.
    if (result.duplicate) return '✅ This casino action was already processed. Use .casino stats or .blackjack status.';
    let text = result.game === 'blackjack' ? blackjackText(result) : `🎲 *${result.game.toUpperCase()}*\n${result.result}`;
    if (result.pending) return text + `\nReserved wager: ${money(result.wager)}\nCash: ${money(result.balance)}`;
    if (result.game === 'blackjack') text += `\n${result.result}`;
    text += `\nWager: ${money(result.wager)} • Payout: ${money(result.payout)}\nNet: ${money(result.net)} • Cash: ${money(result.balance)}`;
    if (result.game === 'jackpot') text += `\nPool: ${money(result.pool)}`;
    for (const m of result.missionCompletions) text += `\n🎉 Mission: ${m.title} (+${money(m.reward)})`;
    return text;
}
module.exports = { COMMANDS, HELP, casinoCommand };
