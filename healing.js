const {getMaxHP, validLevel} = require('./progression');
const MEDKIT = Object.freeze({id: 'medkit', name: '🩹 Medkit', category: 'MEDICAL', price: 2500,
    description: 'Heals 10% of maximum HP, rounded down. Cannot be used during combat or defeat recovery.',
    stackable: true, maxQuantity: 999});
const AEGIS = Object.freeze({id: 'aegis_shield', name: '🛡️ Aegis Shield', category: 'SUPER RARE ROBBERY', price: 250000,
    description: 'Automatically blocks one robbery, including Blackout Device. Consumed on block. Maximum 2. No combat or hacking protection.',
    stackable: true, maxQuantity: 2});
function medkitHealing(level) { return Math.floor(getMaxHP(level) / 10); }
function medicPrice(level, health) {
    validLevel(level);
    const maxHP = getMaxHP(level), missing = Math.max(0, maxHP - Math.max(0, health));
    return Math.ceil(missing * (15000 + 700 * level) / maxHP);
}
module.exports = {MEDKIT, AEGIS, medkitHealing, medicPrice};
