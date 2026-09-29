const MISSION_DEFINITIONS = [
    {
        id: "buy_first_item",
        type: "buy_item",
        title: "First Purchase",
        description: "Buy an item from the market.",
        requirement: "Buy 1 item",
        targetAmount: 1,
        reward: 500,
        active: 1
    },
    {
        id: "collect_daily_reward",
        type: "collect_daily",
        title: "Daily Routine",
        description: "Collect a daily reward.",
        requirement: "Collect 1 daily reward",
        targetAmount: 1,
        reward: 500,
        active: 1
    },
    {
        id: "complete_first_robbery",
        type: "complete_robbery",
        title: "First Score",
        description: "Successfully complete a robbery.",
        requirement: "Complete 1 robbery",
        targetAmount: 1,
        reward: 1000,
        active: 1
    },
    {
        id: "win_first_attack",
        type: "win_attack",
        title: "Combat Trial",
        description: "Defeat another player in combat.",
        requirement: "Defeat 1 player",
        targetAmount: 1,
        reward: 1500,
        active: 1
    },
    {
        id: "use_first_item",
        type: "use_item",
        title: "Put It To Use",
        description: "Use an item.",
        requirement: "Use 1 item",
        targetAmount: 1,
        reward: 300,
        active: 1
    }
];

module.exports = {
    MISSION_DEFINITIONS
};
