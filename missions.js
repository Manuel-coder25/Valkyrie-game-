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

// New one-time milestones; existing IDs and progress remain untouched.
const EXPANSION_MISSIONS = [
    ['work_25', 'Honest Hustle', 'complete_work', 25, 1000, 'Complete 25 work shifts'],
    ['work_100', 'Clockwork', 'complete_work', 100, 3000, 'Complete 100 work shifts'],
    ['jobs_25', 'Reliable Worker', 'complete_job', 25, 2000, 'Complete 25 jobs'],
    ['jobs_100', 'Career Builder', 'complete_job', 100, 5000, 'Complete 100 jobs'],
    ['combat_5', 'Proven Fighter', 'win_attack', 5, 3000, 'Defeat 5 players'],
    ['combat_20', 'Arena Regular', 'win_attack', 20, 8000, 'Defeat 20 players'],
    ['robbery_5', 'Repeat Offender', 'complete_robbery', 5, 2000, 'Complete 5 successful robberies'],
    ['robbery_20', 'Notorious', 'complete_robbery', 20, 6000, 'Complete 20 successful robberies'],
    ['purchase_10', 'Stocking Up', 'buy_item', 10, 1000, 'Purchase 10 item units'],
    ['purchase_50', 'Well Supplied', 'buy_item', 50, 3000, 'Purchase 50 item units'],
    ['medkits_10', 'Field Recovery', 'use_item', 10, 1000, 'Consume 10 item units'],
    ['medic_5', 'Regular Patient', 'use_medic', 5, 1500, 'Complete 5 medic visits'],
    ['casino_25', 'Table Regular', 'play_casino', 25, 500, 'Complete 25 casino rounds']
].map(([id,title,type,targetAmount,reward,requirement]) => ({
    id,title,type,targetAmount,reward,requirement,description: requirement + '.',active: 1
}));

module.exports = { MISSION_DEFINITIONS, EXPANSION_MISSIONS };
