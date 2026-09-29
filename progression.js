// Explicit source of truth. XP is the remainder required to advance FROM a level.
// Level 50 has no next level; XP remains trackable there. No XP-based migration.
const MAX_LEVEL = 50;
const LEVELS = Object.freeze([
    Object.freeze({level: 1, maxHP: 100, xp: 500, rank: "ROOKIE"}),
    Object.freeze({level: 2, maxHP: 108, xp: 825, rank: "HUSTLER"}),
    Object.freeze({level: 3, maxHP: 116, xp: 1300, rank: "RUNNER"}),
    Object.freeze({level: 4, maxHP: 124, xp: 1925, rank: "STREET THUG"}),
    Object.freeze({level: 5, maxHP: 133, xp: 2700, rank: "GANG MEMBER"}),
    Object.freeze({level: 6, maxHP: 141, xp: 3625, rank: "ENFORCER"}),
    Object.freeze({level: 7, maxHP: 149, xp: 4700, rank: "DEALER"}),
    Object.freeze({level: 8, maxHP: 157, xp: 5925, rank: "FIGHTER"}),
    Object.freeze({level: 9, maxHP: 165, xp: 7300, rank: "VETERAN"}),
    Object.freeze({level: 10, maxHP: 173, xp: 8825, rank: "ELITE"}),
    Object.freeze({level: 11, maxHP: 182, xp: 10500, rank: "ASSASSIN"}),
    Object.freeze({level: 12, maxHP: 190, xp: 12325, rank: "BRAWLER"}),
    Object.freeze({level: 13, maxHP: 198, xp: 14300, rank: "UNDERBOSS"}),
    Object.freeze({level: 14, maxHP: 206, xp: 16425, rank: "CAPTAIN"}),
    Object.freeze({level: 15, maxHP: 214, xp: 18700, rank: "LIEUTENANT"}),
    Object.freeze({level: 16, maxHP: 222, xp: 21125, rank: "HITMAN"}),
    Object.freeze({level: 17, maxHP: 231, xp: 23700, rank: "SPECIALIST"}),
    Object.freeze({level: 18, maxHP: 239, xp: 26425, rank: "EXECUTIONER"}),
    Object.freeze({level: 19, maxHP: 247, xp: 29300, rank: "WARLORD"}),
    Object.freeze({level: 20, maxHP: 255, xp: 32325, rank: "BOSS"}),
    Object.freeze({level: 21, maxHP: 263, xp: 35500, rank: "CRIME BOSS"}),
    Object.freeze({level: 22, maxHP: 271, xp: 38825, rank: "GANG LORD"}),
    Object.freeze({level: 23, maxHP: 280, xp: 42300, rank: "KINGPIN"}),
    Object.freeze({level: 24, maxHP: 288, xp: 45925, rank: "MAFIA BOSS"}),
    Object.freeze({level: 25, maxHP: 296, xp: 49700, rank: "DON"}),
    Object.freeze({level: 26, maxHP: 304, xp: 53625, rank: "HIGH DON"}),
    Object.freeze({level: 27, maxHP: 312, xp: 57700, rank: "UNDERWORLD LORD"}),
    Object.freeze({level: 28, maxHP: 320, xp: 61925, rank: "SHADOW BOSS"}),
    Object.freeze({level: 29, maxHP: 329, xp: 66300, rank: "DARK LORD"}),
    Object.freeze({level: 30, maxHP: 337, xp: 70825, rank: "CRIME LORD"}),
    Object.freeze({level: 31, maxHP: 345, xp: 75500, rank: "OVERLORD"}),
    Object.freeze({level: 32, maxHP: 353, xp: 80325, rank: "TYCOON"}),
    Object.freeze({level: 33, maxHP: 361, xp: 85300, rank: "MOGUL"}),
    Object.freeze({level: 34, maxHP: 369, xp: 90425, rank: "MASTERMIND"}),
    Object.freeze({level: 35, maxHP: 378, xp: 95700, rank: "UNDERWORLD KING"}),
    Object.freeze({level: 36, maxHP: 386, xp: 101125, rank: "SUPREME BOSS"}),
    Object.freeze({level: 37, maxHP: 394, xp: 106700, rank: "WAR KING"}),
    Object.freeze({level: 38, maxHP: 402, xp: 112425, rank: "SHADOW KING"}),
    Object.freeze({level: 39, maxHP: 410, xp: 118300, rank: "EMPEROR"}),
    Object.freeze({level: 40, maxHP: 418, xp: 124325, rank: "CRIME EMPEROR"}),
    Object.freeze({level: 41, maxHP: 427, xp: 130500, rank: "UNDERWORLD EMPEROR"}),
    Object.freeze({level: 42, maxHP: 435, xp: 136825, rank: "SUPREME KING"}),
    Object.freeze({level: 43, maxHP: 443, xp: 143300, rank: "DARK EMPEROR"}),
    Object.freeze({level: 44, maxHP: 451, xp: 149925, rank: "GRAND KINGPIN"}),
    Object.freeze({level: 45, maxHP: 459, xp: 156700, rank: "OVERLORD PRIME"}),
    Object.freeze({level: 46, maxHP: 467, xp: 163625, rank: "SHADOW EMPEROR"}),
    Object.freeze({level: 47, maxHP: 476, xp: 170700, rank: "UNDERWORLD LEGEND"}),
    Object.freeze({level: 48, maxHP: 484, xp: 177925, rank: "CRIME LEGEND"}),
    Object.freeze({level: 49, maxHP: 492, xp: 185300, rank: "SUPREME LEGEND"}),
    Object.freeze({level: 50, maxHP: 500, xp: null, rank: "VALKYRIE LEGEND"}),
 ]);
const RANKS = Object.freeze(Object.fromEntries(LEVELS.map(l => [l.level, l.rank])));
const XP_REQUIREMENTS = Object.freeze(Object.fromEntries(LEVELS.map(l => [l.level, l.xp])));
function validLevel(level) {
    const n = Number(level);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LEVEL) throw new Error('Level must be between 1 and 50.');
    return n;
}
function getRank(level) { return RANKS[validLevel(level)]; }
function getMaxHP(level) { return LEVELS[validLevel(level) - 1].maxHP; }
function getNextLevelXP(level) { return XP_REQUIREMENTS[validLevel(level)]; }
function addXP(currentLevel, currentXP, amount) {
    let level = validLevel(currentLevel), xp = Number(currentXP), gained = Number(amount);
    if (!Number.isSafeInteger(xp) || xp < 0 || !Number.isSafeInteger(gained) || gained < 0 || !Number.isSafeInteger(xp + gained)) {
        throw new Error('XP must be a non-negative safe integer.');
    }
    const oldLevel = level;
    xp += gained;
    while (level < MAX_LEVEL && xp >= getNextLevelXP(level)) {
        xp -= getNextLevelXP(level);
        level++;
    }
    return {level, xp, gained, levelUp: level > oldLevel, oldLevel, newLevel: level,
        oldRank: getRank(oldLevel), newRank: getRank(level), maxHP: getMaxHP(level)};
}
function levelUpText(progression, isKamio = false) {
    return progression.levelUp ? `\n⭐ Level up! Level ${progression.level}\nRank: ${isKamio ? 'KAMIO' : progression.newRank}\nMaximum HP: ${progression.maxHP}` : '';
}
function getDepositLimit(
    level,
    isKamio = false
) {
    if (isKamio) {
        return Infinity;
    }

    const limits = {
        1: 3,
        2: 5,
        3: 7,
        4: 10,
        5: 12,
        6: 15,
        7: 18,
        8: 20,
        9: 25,
        10: 30
    };

    return limits[level] || 30;
}

module.exports = {MAX_LEVEL, LEVELS, RANKS, XP_REQUIREMENTS, validLevel, getRank, getMaxHP, getNextLevelXP, addXP, levelUpText, getDepositLimit};
