const SHIELD_CATALOGUE = Object.freeze({
    light_shield: Object.freeze({
        id: "light_shield",
        name: "Light Shield",
        category: "Shields",
        price: 10000,
        description: "Basic combat protection.",
        absorption: 25,
        stackable: false,
        maxQuantity: 1
    }),
    reinforced_shield: Object.freeze({
        id: "reinforced_shield",
        name: "Reinforced Shield",
        category: "Shields",
        price: 20000,
        description: "Improved combat protection.",
        absorption: 50,
        stackable: false,
        maxQuantity: 1
    }),
    tactical_shield: Object.freeze({
        id: "tactical_shield",
        name: "Tactical Shield",
        category: "Shields",
        price: 35000,
        description: "Advanced tactical protection.",
        absorption: 75,
        stackable: false,
        maxQuantity: 1
    }),
    heavy_shield: Object.freeze({
        id: "heavy_shield",
        name: "Heavy Shield",
        category: "Shields",
        price: 50000,
        description: "Strong combat protection.",
        absorption: 100,
        stackable: false,
        maxQuantity: 1
    }),
    advanced_shield: Object.freeze({
        id: "advanced_shield",
        name: "Advanced Shield",
        category: "Shields",
        price: 75000,
        description: "High-grade combat protection.",
        absorption: 150,
        stackable: false,
        maxQuantity: 1
    })
});

function getShieldDefinition(itemId) {
    return Object.prototype.hasOwnProperty.call(SHIELD_CATALOGUE, itemId)
        ? SHIELD_CATALOGUE[itemId] : null;
}

function isShield(itemId) {
    return Boolean(getShieldDefinition(itemId));
}

module.exports = {
    SHIELD_CATALOGUE,
    getShieldDefinition,
    isShield
};
