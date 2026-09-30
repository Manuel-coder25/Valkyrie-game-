const assert = require('node:assert/strict');
const p = require('../progression');
const expectedXP = [325,540,860,1285,1815,2455,3210,4080,5070,6180,7455,8795,10255,11840,13545,15375,17335,19420,21640,23990,26475,29090,31845,34740,37770,41290,44800,48480,52330,56355,60560,64950,69520,74280,79225,84365,89705,95240,100980,106920,113535,120235,127180,134370,141815,149510,157470,165695,174180,null];
const expectedIdentity = [
    {
        "level": 1,
        "maxHP": 100,
        "rank": "ROOKIE"
    },
    {
        "level": 2,
        "maxHP": 108,
        "rank": "HUSTLER"
    },
    {
        "level": 3,
        "maxHP": 116,
        "rank": "RUNNER"
    },
    {
        "level": 4,
        "maxHP": 124,
        "rank": "STREET THUG"
    },
    {
        "level": 5,
        "maxHP": 133,
        "rank": "GANG MEMBER"
    },
    {
        "level": 6,
        "maxHP": 141,
        "rank": "ENFORCER"
    },
    {
        "level": 7,
        "maxHP": 149,
        "rank": "DEALER"
    },
    {
        "level": 8,
        "maxHP": 157,
        "rank": "FIGHTER"
    },
    {
        "level": 9,
        "maxHP": 165,
        "rank": "VETERAN"
    },
    {
        "level": 10,
        "maxHP": 173,
        "rank": "ELITE"
    },
    {
        "level": 11,
        "maxHP": 182,
        "rank": "ASSASSIN"
    },
    {
        "level": 12,
        "maxHP": 190,
        "rank": "BRAWLER"
    },
    {
        "level": 13,
        "maxHP": 198,
        "rank": "UNDERBOSS"
    },
    {
        "level": 14,
        "maxHP": 206,
        "rank": "CAPTAIN"
    },
    {
        "level": 15,
        "maxHP": 214,
        "rank": "LIEUTENANT"
    },
    {
        "level": 16,
        "maxHP": 222,
        "rank": "HITMAN"
    },
    {
        "level": 17,
        "maxHP": 231,
        "rank": "SPECIALIST"
    },
    {
        "level": 18,
        "maxHP": 239,
        "rank": "EXECUTIONER"
    },
    {
        "level": 19,
        "maxHP": 247,
        "rank": "WARLORD"
    },
    {
        "level": 20,
        "maxHP": 255,
        "rank": "BOSS"
    },
    {
        "level": 21,
        "maxHP": 263,
        "rank": "CRIME BOSS"
    },
    {
        "level": 22,
        "maxHP": 271,
        "rank": "GANG LORD"
    },
    {
        "level": 23,
        "maxHP": 280,
        "rank": "KINGPIN"
    },
    {
        "level": 24,
        "maxHP": 288,
        "rank": "MAFIA BOSS"
    },
    {
        "level": 25,
        "maxHP": 296,
        "rank": "DON"
    },
    {
        "level": 26,
        "maxHP": 304,
        "rank": "HIGH DON"
    },
    {
        "level": 27,
        "maxHP": 312,
        "rank": "UNDERWORLD LORD"
    },
    {
        "level": 28,
        "maxHP": 320,
        "rank": "SHADOW BOSS"
    },
    {
        "level": 29,
        "maxHP": 329,
        "rank": "DARK LORD"
    },
    {
        "level": 30,
        "maxHP": 337,
        "rank": "CRIME LORD"
    },
    {
        "level": 31,
        "maxHP": 345,
        "rank": "OVERLORD"
    },
    {
        "level": 32,
        "maxHP": 353,
        "rank": "TYCOON"
    },
    {
        "level": 33,
        "maxHP": 361,
        "rank": "MOGUL"
    },
    {
        "level": 34,
        "maxHP": 369,
        "rank": "MASTERMIND"
    },
    {
        "level": 35,
        "maxHP": 378,
        "rank": "UNDERWORLD KING"
    },
    {
        "level": 36,
        "maxHP": 386,
        "rank": "SUPREME BOSS"
    },
    {
        "level": 37,
        "maxHP": 394,
        "rank": "WAR KING"
    },
    {
        "level": 38,
        "maxHP": 402,
        "rank": "SHADOW KING"
    },
    {
        "level": 39,
        "maxHP": 410,
        "rank": "EMPEROR"
    },
    {
        "level": 40,
        "maxHP": 418,
        "rank": "CRIME EMPEROR"
    },
    {
        "level": 41,
        "maxHP": 427,
        "rank": "UNDERWORLD EMPEROR"
    },
    {
        "level": 42,
        "maxHP": 435,
        "rank": "SUPREME KING"
    },
    {
        "level": 43,
        "maxHP": 443,
        "rank": "DARK EMPEROR"
    },
    {
        "level": 44,
        "maxHP": 451,
        "rank": "GRAND KINGPIN"
    },
    {
        "level": 45,
        "maxHP": 459,
        "rank": "OVERLORD PRIME"
    },
    {
        "level": 46,
        "maxHP": 467,
        "rank": "SHADOW EMPEROR"
    },
    {
        "level": 47,
        "maxHP": 476,
        "rank": "UNDERWORLD LEGEND"
    },
    {
        "level": 48,
        "maxHP": 484,
        "rank": "CRIME LEGEND"
    },
    {
        "level": 49,
        "maxHP": 492,
        "rank": "SUPREME LEGEND"
    },
    {
        "level": 50,
        "maxHP": 500,
        "rank": "VALKYRIE LEGEND"
    }
];
assert.equal(p.MAX_LEVEL, 50);
assert.deepEqual(p.LEVELS.map(({level,maxHP,rank}) => ({level,maxHP,rank})), expectedIdentity);
assert.deepEqual(p.LEVELS.map(l => l.xp), expectedXP);
assert.equal(expectedXP.reduce((sum, xp) => sum + (xp || 0), 0), 2688380);
let cumulative = 0;
for (let level = 1; level < 50; level++) {
    const threshold = expectedXP[level - 1];
    assert.equal(p.getNextLevelXP(level), threshold);
    for (const [gain, expectedLevel, remainder] of [[0,level,threshold-1],[1,level+1,0],[2,level+1,1]]) {
        const result = p.addXP(level, threshold - 1, gain);
        assert.equal(result.level, expectedLevel);
        assert.equal(result.xp, remainder);
        assert.equal(result.levelUp, gain > 0);
        assert.equal(result.maxHP, expectedIdentity[expectedLevel - 1].maxHP);
        assert.equal(result.newRank, expectedIdentity[expectedLevel - 1].rank);
    }
    cumulative += threshold;
    const below = p.addXP(1, 0, cumulative - 1);
    assert.equal(below.level, level);
    assert.equal(below.xp, threshold - 1);
    const exact = p.addXP(1, 0, cumulative);
    assert.equal(exact.level, level + 1);
    assert.equal(exact.xp, 0);
}
assert.equal(p.getNextLevelXP(50), null);
const overflow = p.addXP(1, 0, 2688380 + 123);
assert.equal(overflow.level, 50);
assert.equal(overflow.xp, 123);
const capped = p.addXP(50, 123, 30);
assert.equal(capped.level, 50);
assert.equal(capped.xp, 153);
assert.equal(capped.levelUp, false);
for (const level of [0, 51, 1.5]) assert.throws(() => p.addXP(level, 0, 1), /Level/);
assert.throws(() => p.addXP(1, -1, 1), /XP/);
assert.throws(() => p.addXP(1, 0, -1), /XP/);
assert.throws(() => p.addXP(50, Number.MAX_SAFE_INTEGER, 1), /XP/);
console.log('PASS exact approved XP table, unchanged HP/ranks, every threshold and cumulative boundary, overflow and level-50 cap');
