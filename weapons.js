const WEAPON_CATALOGUE = Object.freeze({
    pocket_knife: Object.freeze({
        id: "pocket_knife",
        name: "Pocket Knife",
        category: "Weapons",
        price: 2000,
        description: "A basic close-range weapon.",
        damage: 10,
        stackable: true,
        maxQuantity: 999
    }),
    combat_knife: Object.freeze({
        id: "combat_knife",
        name: "Combat Knife",
        category: "Weapons",
        price: 5000,
        description: "A stronger close-range weapon.",
        damage: 15,
        stackable: true,
        maxQuantity: 999
    }),
    hatchet: Object.freeze({
        id: "hatchet",
        name: "Hatchet",
        category: "Weapons",
        price: 8000,
        description: "A heavy melee weapon.",
        damage: 20,
        stackable: true,
        maxQuantity: 999
    }),
    pistol: Object.freeze({
        id: "pistol",
        name: "Pistol",
        category: "Weapons",
        price: 15000,
        description: "A basic firearm.",
        damage: 25,
        stackable: true,
        maxQuantity: 999
    }),
    revolver: Object.freeze({
        id: "revolver",
        name: "Revolver",
        category: "Weapons",
        price: 25000,
        description: "A powerful handgun.",
        damage: 30,
        stackable: true,
        maxQuantity: 999
    }),
    smg: Object.freeze({
        id: "smg",
        name: "SMG",
        category: "Weapons",
        price: 45000,
        description: "A rapid-fire weapon.",
        damage: 35,
        stackable: true,
        maxQuantity: 999
    }),
    shotgun: Object.freeze({
        id: "shotgun",
        name: "Shotgun",
        category: "Weapons",
        price: 60000,
        description: "A heavy close-range firearm.",
        damage: 45,
        stackable: true,
        maxQuantity: 999
    }),
    assault_rifle: Object.freeze({
        id: "assault_rifle",
        name: "Assault Rifle",
        category: "Weapons",
        price: 100000,
        description: "An advanced automatic weapon.",
        damage: 55,
        stackable: true,
        maxQuantity: 999
    }),
    sniper: Object.freeze({
        id: "sniper",
        name: "Sniper",
        category: "Weapons",
        price: 150000,
        description: "A high-powered long-range weapon.",
        damage: 70,
        stackable: true,
        maxQuantity: 999
    }),
    reaper: Object.freeze({
        id: "reaper", name: "Reaper", category: "Weapons",
        price: 2000000, description: "Legendary weapon. Base damage: 180. Subject to the per-hit HP ceiling.",
        damage: 180, stackable: false, maxQuantity: 1
    }),
    dominator: Object.freeze({
        id: "dominator", name: "Dominator", category: "Weapons",
        price: 3500000, description: "Legendary weapon. Base damage: 220. Subject to the per-hit HP ceiling.",
        damage: 220, stackable: false, maxQuantity: 1
    }),
    warhammer: Object.freeze({
        id: "warhammer", name: "Warhammer", category: "Weapons",
        price: 6000000, description: "Legendary weapon. Base damage: 275. Subject to the per-hit HP ceiling.",
        damage: 275, stackable: false, maxQuantity: 1
    }),
    valkyrie_executioner: Object.freeze({
        id: "valkyrie_executioner",
        name: "⚔️ Valkyrie Executioner",
        category: "LEGENDARY WEAPON",
        price: 1000000,
        description: "An endgame legendary weapon.",
        damage: 150,
        stackable: false,
        maxQuantity: 1
    })
});

function getWeaponDefinition(itemId) {
    return Object.prototype.hasOwnProperty.call(WEAPON_CATALOGUE, itemId)
        ? WEAPON_CATALOGUE[itemId] : null;
}

function isWeapon(itemId) {
    return Boolean(getWeaponDefinition(itemId));
}

module.exports = {
    WEAPON_CATALOGUE,
    getWeaponDefinition,
    isWeapon
};
