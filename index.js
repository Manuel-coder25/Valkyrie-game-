const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState
} = require("@whiskeysockets/baileys");

const {
    initDatabase,
    createBounty, expireBounties, getBounty, listBounties, runGameplayAction,
    healPlayer,
    claimWork,
    casino,
    jobs,
    executeAttack,
    recoverPlayers,
    isDefeated,
    getEquippedShield,
    createPlayer,
    getPlayer,
    updatePlayer,
    deletePlayer,
    getRobberyProtection,
    updateRobberyProtection,
    completeRobbery,
    getPlayerMissions,
    recordMissionProgress,
    getInventory,
    getInventoryItem,
    removeItem,
    equipItem,
    unequipItem,
    getMarketItems,
    buyItem
} = require("./database");

const {
    getRank,
    getMaxHP,
    levelUpText,
    getDepositLimit
} = require("./progression");

const { COMMANDS: CASINO_COMMANDS, casinoCommand } = require("./casino-commands");

const { jobCommand } = require("./jobs");

const P = require("pino");
const { createWhatsAppLifecycle } = require("./whatsapp-lifecycle");

const PREFIX = ".";

// WhatsApp number used to register the bot.
// No +, spaces, or dashes.
const PHONE_NUMBER = "2349169761233";

const KAMIO_JID =
    `${PHONE_NUMBER}@s.whatsapp.net`;

const KAMIO_STARTING_MONEY = 999999999;

const DAILY_REWARD = 1000;
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const ROB_COOLDOWN = 60 * 1000;
let recoveryTimer;
let bountyTimer;

function recoveryText(player) {
    const seconds = Math.max(0, Math.ceil((Number(player.defeated_until) - Date.now()) / 1000));
    return `💀 Defeated. Recovery in ${Math.floor(seconds / 60)}m ${seconds % 60}s. Use .health to check.`;
}

function formatMoney(amount) {
    return "$" + Number(amount).toLocaleString();
}

function random(min, max) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}

function isKamio(player) {
    return player?.rank === "KAMIO";
}

function hasKamioPermission(player) {
    return isKamio(player);
}

function formatMissionCompletions(completions) {
    if (!completions || !completions.length) {
        return "";
    }

    return "\n\n🎉 *MISSION COMPLETED*\n" +
        completions.map(completion =>
            `✅ ${completion.title}\n💰 Reward: ${formatMoney(completion.reward)}`
        ).join("\n\n");
}

const { playerMention, createPlayerReply, sendPlayerReply, groupPlayerMentions } = require("./player-replies");

// Resolve combat identities using WhatsApp's own PN/LID associations only.
async function resolveAttackIdentity(sock, id, chatId, alternateId) {
    id = id?.replace(/:\d+(?=@)/, "");
    alternateId = alternateId?.replace(/:\d+(?=@)/, "");
    let phoneId = id?.endsWith("@s.whatsapp.net") ? id : null;
    if (id?.endsWith("@lid")) {
        if (alternateId?.endsWith("@s.whatsapp.net")) phoneId = alternateId;
        if (!phoneId) {
            try {
                phoneId = await sock.signalRepository?.lidMapping?.getPNForLID?.(id);
            } catch (_) {
                // A missing mapping must not prevent an exact registered-ID lookup.
            }
        }
        if (!phoneId && chatId?.endsWith("@g.us")) {
            try {
                const metadata = await sock.groupMetadata(chatId);
                const member = metadata.participants.find(member =>
                    member.id === id || member.lid === id);
                phoneId = member?.jid || member?.phoneNumber;
            } catch (_) {
                // Unavailable metadata leaves the original JID unresolved.
            }
        }
    }
    // Equipment may belong to a registered LID even when WhatsApp sends a PN.
    if (phoneId && !getPlayer(id)) {
        let lid = alternateId?.endsWith("@lid") ? alternateId : null;
        if (!lid && chatId?.endsWith("@g.us")) {
            try {
                const metadata = await sock.groupMetadata(chatId);
                const member = metadata.participants.find(member =>
                    member.id === id || member.jid === id || member.phoneNumber === id);
                lid = member?.lid || (member?.id?.endsWith("@lid") ? member.id : null);
            } catch (_) {}
        }
        if (lid && getPlayer(lid)) return { id: lid, canonicalId: phoneId };
    }
    if (!phoneId?.endsWith("@s.whatsapp.net")) phoneId = null;
    return {
        id: phoneId && getPlayer(phoneId) ? phoneId : id,
        canonicalId: phoneId || id
    };
}

// Collect reply data during the existing action transaction; send after durable save.
async function persistMissionCommand(sock, chatId, senderJid, playerId, actionId, kind, operation) {
    let result;
    try {
        result = runGameplayAction(playerId,kind,actionId,() => {
            const replies = [];
            const queueReply = (_sock,jid,text,mentions=[]) => replies.push({jid,playerJid:senderJid,text,mentions});
            const queuePlayerReply = (_sock,jid,playerJid,text,mentions=[]) => replies.push({jid,playerJid,text,mentions});
            operation(queueReply,queuePlayerReply);
            return {success:true,replies};
        });
    } catch (error) {
        console.error('Action could not be saved:',error);
        return sendPlayerReply(sock,chatId,senderJid,'Action could not be saved. No changes were made. Try again.');
    }
    if (result.duplicate) return sendPlayerReply(sock,chatId,senderJid,'This action was already processed.');
    if (!result.success) return sendPlayerReply(sock,chatId,senderJid,'Missing message ID. Send a new command.');
    return Promise.allSettled(result.replies.map(reply =>
        sendPlayerReply(sock,reply.jid,reply.playerJid,reply.text,reply.mentions)));
}

async function startBot() {

    await initDatabase();
    recoverPlayers();
    if (!bountyTimer) {
        bountyTimer = setInterval(() => {
            try { expireBounties(); }
            catch (error) { console.error('Bounty expiration failed:',error); }
        }, 60000);
        bountyTimer.unref();
    }
    if (!recoveryTimer) {
        recoveryTimer = setInterval(() => {
            try { recoverPlayers(); }
            catch (error) { console.error("❌ Recovery failed:", error); }
        }, 1000);
        recoveryTimer.unref();
    }

    /*
    ==========================================
    KAMIO ACCOUNT
    ==========================================
    */

    const existingKamio =
        getPlayer(KAMIO_JID);

    if (!existingKamio) {

        createPlayer(
            KAMIO_JID,
            "Kamio",
            "KAMIO"
        );

        updatePlayer(
            KAMIO_JID,
            {
                rank: "KAMIO",
                money: KAMIO_STARTING_MONEY
            }
        );

        console.log(
            "👑 KAMIO account created."
        );

    } else if (
        existingKamio.rank !== "KAMIO"
    ) {

        updatePlayer(
            KAMIO_JID,
            {
                rank: "KAMIO"
            }
        );
    }

}

function attachMessages(sock, isCurrent) {
    /*
    ==========================================
    MESSAGES
    ==========================================
    */

    const handleMessages = async ({ messages, type }) => {
    try {
        console.log(
        "📩 UPSERT:",
        type,
        messages.map(m => ({
            fromMe: m.key.fromMe,
            remoteJid: m.key.remoteJid,
            remoteJidAlt: m.key.remoteJidAlt,
            participant: m.key.participant,
            participantAlt: m.key.participantAlt,
            text:
                m.message?.conversation ||
                m.message?.extendedTextMessage?.text ||
                null
        }))
    );

    const msg = messages[0];

    if (!msg) return;
    if (!msg.message) return;

                /*
                IMPORTANT:
                We DO NOT use:
                    if (msg.key.fromMe) return;

                Your WhatsApp account is also KAMIO.
                So your own messages must be processed.
                */

                const jid =
                    msg.key.remoteJid;

                if (!jid) return;

                if (
                    jid === "status@broadcast"
                ) {
                    return;
                }

                // WhatsApp can wrap ordinary text in disappearing/view-once envelopes.
                // Read the content without replacing the key used for identity/deduplication.
                let content = msg.message;
                for (let depth = 0; depth < 10; depth++) {
                    const nested = content.ephemeralMessage?.message ||
                        content.viewOnceMessage?.message || content.viewOnceMessageV2?.message ||
                        content.viewOnceMessageV2Extension?.message || content.documentWithCaptionMessage?.message;
                    if (!nested) break;
                    content = nested;
                }
                const text = content.conversation || content.extendedTextMessage?.text || "";

                if (!text) return;

                if (
                    !text.startsWith(PREFIX)
                ) {
                    return;
                }

                const args =
                    text
                        .slice(PREFIX.length)
                        .trim()
                        .split(/\s+/);

                const command =
                    args
                        .shift()
                        ?.toLowerCase();

                if (!command) return;

                // Each invocation captures its own WhatsApp identity, including LIDs.
                // Never store the current sender on the shared socket.
                const replyPlayerJid = msg.key.participant ||
                    (msg.key.fromMe ? KAMIO_JID : jid);
                const sendText = createPlayerReply(replyPlayerJid);


                /*
                ==================================
                IDENTIFY PLAYER
                ==================================
                */

                let userId =
    msg.key.fromMe
        ? KAMIO_JID
        : (msg.key.participant || jid);
                userId = userId.replace(/:\d+(?=@)/, "");

                let attackSender;
                // Every command uses the same registered account as equipment.
                if (command) {
                    attackSender = await resolveAttackIdentity(sock, userId, jid,
                        msg.key.fromMe ? undefined :
                            (msg.key.participant
                                ? (msg.key.participantAlt || msg.key.participantPn)
                                : (msg.key.remoteJidAlt || msg.key.senderPn)));
                    // Keep the registered account used by .equip and its inventory.
                    if (!getPlayer(userId)) userId = attackSender.id;
                }

                const pushName =
                    msg.pushName ||
                    "Player";

                /*
                ==================================
                REGISTRATION
                ==================================
                */

                if (
                    command === "register"
                ) {

                    const existing =
                        getPlayer(userId);

                    if (existing) {

                        return sendText(
                            sock,
                            jid,

`⚔️ *ALREADY REGISTERED*

👤 ${existing.name}

⭐ Level: ${existing.level}

🏷️ Rank: ${isKamio(existing) ? "KAMIO" : getRank(existing.level)}

Use *.menu* to view your commands.`
                        );
                    }

                    createPlayer(
                        userId,
                        pushName,
                        "PLAYER"
                    );

                    const newPlayer =
                        getPlayer(userId);

                    if (!newPlayer) return;

                    return sendText(
                        sock,
                        jid,

`⚔️ *WELCOME TO VALKYRIE, ${newPlayer.name.toUpperCase()}!*

Your player account has been created.

💰 Starting Cash:
${formatMoney(newPlayer.money)}

⭐ Level: ${newPlayer.level}

❤️ Health:
${newPlayer.health}/${getMaxHP(newPlayer.level)}

✨ XP:
${newPlayer.xp}

Use *.menu* to view your commands.

*Your journey begins now.* ⚔️`
                    );
                }

                /*
                ==================================
                PLAYER CHECK
                ==================================
                */

                recoverPlayers();
                const player =
                    getPlayer(userId);

                /*
                Only registered players
                can use commands.
                */

                if (!player) {
                    if (CASINO_COMMANDS.has(command) || ["bounty", "bounties", "bountyinfo", "mybounties", "job", "jobs", "work", "medkit", "medic", "profile", "p", "health", "hp", "buy", "inventory", "inv"].includes(command)) return sendText(sock, jid, "Register first with .register.");
                    return;
                }

                const actionId = msg.key.id ? JSON.stringify([jid, userId, msg.key.id]) : null;
                if (['bounty','bounties','bountyinfo','mybounties'].includes(command)) {
                    try {
                        expireBounties();
                        if (command === 'bounty') {
                            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                            if (!mentioned || args.length !== 2) return sendText(sock,jid,'Use .bounty @player <whole dollar amount>.');
                            const target = await resolveAttackIdentity(sock,mentioned,jid);
                            // Retain the exact registered account, as the sender/equipment path does.
                            const targetId = getPlayer(mentioned)?.id || target.id;
                            const result = createBounty(userId,targetId,args[1],actionId,
                                {creator:attackSender.canonicalId,target:target.canonicalId});
                            if (!result.success) {
                                const errors = {
                                    INVALID_AMOUNT:'Use a whole-dollar amount of at least $10,000 within the supported safe integer range.',
                                    MAXIMUM:'The maximum bounty is $1,000,000 for normal players.',
                                    SELF_TARGET:'You cannot place a bounty on yourself.',
                                    PLAYER_NOT_FOUND:'That player is not registered in Valkyrie.',
                                    INSUFFICIENT_FUNDS:'Not enough cash to fund this bounty.',
                                    DUPLICATE:'This bounty creation was already processed.',
                                    MISSING_MESSAGE_ID:'Missing message ID. Send a new command.'
                                };
                                return sendText(sock,jid,errors[result.reason] || 'Bounty unavailable.');
                            }
                            const b = result.bounty;
                            return sendText(sock,jid,`🎯 *BOUNTY #${b.id}*\nTarget: ${playerMention(mentioned)}\nReward: ${formatMoney(b.amount)}\nExpires in 24 hours. Cash escrowed.`,[mentioned]);
                        }
                        if (command === 'bountyinfo') {
                            const id = Number(args[0]);
                            if (args.length !== 1 || !/^[1-9][0-9]*$/.test(args[0]) || !Number.isSafeInteger(id)) return sendText(sock,jid,'Use .bountyinfo <id>.');
                            const b = getBounty(id);
                            if (!b) return sendText(sock,jid,'Bounty not found.');
                            const claimant = b.claimant_id ? `\nClaimed by: ${playerMention(b.claimant_id)}` : '';
                            return sendText(sock,jid,`🎯 *BOUNTY #${b.id}*\nTarget: ${playerMention(b.target_id)}\nCreator: ${playerMention(b.creator_id)}\nReward: ${formatMoney(b.amount)}\nStatus: ${b.status.toUpperCase()}\nExpires: ${new Date(b.expires_at).toISOString()}${claimant}`,
                                [b.target_id,b.creator_id,b.claimant_id].filter(Boolean));
                        }
                        const page = args.length ? Number(args[0]) : 1;
                        if (args.length > 1 || !Number.isSafeInteger(page) || page < 1 || page > 1000000) return sendText(sock,jid,`Use .${command} [page].`);
                        const rows = listBounties(command === 'mybounties' ? userId : null,(page-1)*20);
                        if (!rows.length) return sendText(sock,jid,'No bounties on this page.');
                        return sendText(sock,jid,`🎯 *${command === 'mybounties' ? 'MY BOUNTIES' : 'ACTIVE BOUNTIES'}* — Page ${page}\n\n` +
                            rows.map(b => `#${b.id} • ${playerMention(b.target_id)} • ${formatMoney(b.amount)} • ${b.status}`).join('\n') +
                            (rows.length === 20 ? `\nNext: .${command} ${page+1}` : ''),rows.map(b => b.target_id));
                    } catch (error) {
                        console.error('Bounty action failed:',error);
                        return sendText(sock,jid,'Bounty processing could not complete safely. Please try again.');
                    }
                }
                if (command === 'medkit' || command === 'medic') {
                    if ((command === 'medkit' && args.length > 1) || (command === 'medic' && args.length)) {
                        return sendText(sock,jid,'Use .medkit [amount] or .medic.');
                    }
                    let result;
                    try { result = healPlayer(userId,command,args[0] ?? 1,actionId); }
                    catch (error) {
                        console.error('Healing failed:',error);
                        return sendText(sock,jid,'Healing could not be saved. No cash or Medkits were spent. Try again.');
                    }
                    if (result.duplicate) return sendText(sock,jid,'✅ This healing action was already processed.');
                    if (!result.success) {
                        const errors = {FULL_HP:'❤️ You are already at full HP.', NO_MEDKITS:'You have no Medkits. Use .buy medkit.',
                            INVALID_AMOUNT:'Use .medkit <positive whole amount>.', MISSING_MESSAGE_ID:'Missing message ID. Send a new command.',
                            INSUFFICIENT_FUNDS:`Not enough cash. Medic costs ${formatMoney(result.cost)}.`,
                            COMBAT:`⏳ Healing is blocked during combat. Wait ${Math.ceil(result.remainingMs/1000)}s.`,
                            DEFEATED:recoveryText({defeated_until:result.recoveryAt})};
                        return sendText(sock,jid,errors[result.reason] || 'Healing unavailable.');
                    }
                    return sendText(sock,jid,`❤️ Healed ${result.healed} HP. HP: ${result.health}/${result.maxHP}\n` +
                        (command === 'medkit' ? `Medkits used: ${result.used}` : `Medic fee: ${formatMoney(result.cost)}`) +
                        formatMissionCompletions(result.missionCompletions));
                }

                if (CASINO_COMMANDS.has(command)) {
                    const actionId = msg.key.id ? JSON.stringify([jid, userId, msg.key.id]) : null;
                    try {
                        return sendText(sock, jid, casinoCommand(casino, player.id, command, args, actionId));
                    } catch (error) {
                        console.error("Casino action failed:", error);
                        return sendText(sock, jid, "Casino action could not be saved. No wager was taken for this action. Try again.");
                    }
                }

                if (command === "jobs" || command === "job") {
                    const actionId = msg.key.id ? JSON.stringify([jid, userId, msg.key.id]) : null;
                    let response;
                    try {
                        response = jobCommand(jobs, player.id, command, args, actionId);
                    } catch (error) {
                        console.error("Job action failed:", error);
                        response = "Job could not be saved. No reward was claimed. Try again.";
                    }
                    return sendText(sock, jid, response);
                }

                // Recovery is checked before any command; defeat only restricts these actions.
                if (["rob", "hack"].includes(command) && isDefeated(player)) {
                    return sendText(sock, jid, recoveryText(player));
                }

                if (command === "health" || command === "hp") {
                    const shield = getEquippedShield(userId);
                    const status = isKamio(player)
                        ? "👑 HP: ∞ | Shield: ∞ (KAMIO immunity)"
                        : `❤️ HP: ${player.health}/${getMaxHP(player.level)}\n🛡️ Shield: ${shield ? `${shield.name} — ${shield.remaining}/${shield.absorption} absorption${shield.remaining === 0 ? ` (depleted). Replace with .buy ${shield.item_id}` : " (automatic against attacks)"}` : "None equipped. Use .equip <shield_id>"}`;
                    return sendText(sock, jid,
                        status + (isDefeated(player) ? "\n" + recoveryText(player) : "\nReady."));
                }

                if (command === "attack") {
                    const mentionedId = content.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!mentionedId) {
                        return sendText(sock, jid, "⚔️ Usage: .attack @player");
                    }
                    const target = await resolveAttackIdentity(sock, mentionedId, jid);
                    const targetId = target.id;
                    if (targetId === userId || target.canonicalId === attackSender.canonicalId) {
                        return sendText(sock, jid, "❌ You cannot attack yourself.");
                    }
                    // Durable deduplication covers repeats across reconnects and restarts,
                    // including KAMIO attacks, which have no cooldown.
                    const messageKey = msg.key.id
                        ? JSON.stringify([jid, userId, msg.key.id]) : null;
                    let result;
                    try { result = executeAttack(userId, targetId, messageKey, {attacker:attackSender.canonicalId,target:target.canonicalId}); }
                    catch (error) {
                        console.error('Attack failed:',error);
                        return sendText(sock,jid,'Attack could not be saved. No hit was applied. Try again.');
                    }
                    if (!result.success) {
                        if (result.reason === "DUPLICATE") return;
                        if (result.reason === "COOLDOWN") {
                            return sendText(sock, jid,
                                `⏳ Attack cooldown: ${Math.ceil(result.remainingMs / 1000)}s remaining.`);
                        }
                        if (["ATTACKER_DEFEATED", "TARGET_DEFEATED"].includes(result.reason)) {
                            const who = result.reason === "TARGET_DEFEATED" ? "Target: " : "";
                            return sendText(sock, jid, who + recoveryText({ defeated_until: result.recoveryAt }));
                        }
                        const errors = {
                            PLAYER_NOT_FOUND: "❌ That player is not registered in Valkyrie.",
                            INVALID_TARGET: "❌ Invalid attack target.",
                            MISSING_MESSAGE_ID: "❌ Message ID unavailable. Send a new .attack command."
                        };
                        return sendText(sock, jid, errors[result.reason] || "❌ Attack failed.");
                    }
                    let response = `⚔️ ${result.weapon} | Damage: ${result.damage}\n` +
                        `🛡️ Absorbed: ${result.shieldAbsorbed} | HP damage: ${result.healthDamage}\n` +
                        (result.immune
                            ? "👑 Target: KAMIO — HP ∞ | Shield ∞. Immune."
                            : `❤️ Target HP: ${result.health}/${result.maxHP} | Shield: ${result.shieldRemaining}`);
                    if (result.shieldDepleted) response += "\n🛡️ Shield depleted.";
                    if (result.defeated) response += "\n💀 Target defeated. Recovery in 10 minutes.";
                    if (result.bountyClaims?.length) {
                        const total = result.bountyClaims.reduce((sum,bounty) => sum + bounty.amount,0);
                        response += `\n🎯 Bounties claimed: ${result.bountyClaims.length} | Reward: ${formatMoney(total)}`;
                    }
                    return sendText(sock, jid, response + formatMissionCompletions(result.missionCompletions));
                }

                /*
==================================
EQUIPMENT
==================================
*/

if (
    command === "equip" ||
    command === "unequip"
) {
    const itemId = args[0]?.toLowerCase();

    if (!itemId) {
        return sendText(
            sock,
            jid,
            `⚠️ Usage: .${command} <item_id>`
        );
    }

    let result;
    try { result = command === "equip"
        ? equipItem(player.id, itemId, actionId)
        : unequipItem(player.id, itemId, actionId); }
    catch (error) {
        console.error('Equipment action failed:',error);
        return sendText(sock,jid,'Equipment could not be saved. Nothing was changed. Try again.');
    }
    if (result.duplicate) return sendText(sock,jid,'✅ This equipment action was already processed.');

    if (!result.success) {
        if (result.reason === "SHIELD_DEPLETED") {
            return sendText(sock,jid,`🛡️ *${result.item.name}* is depleted and cannot protect you. Replace it with .buy ${itemId} at the normal shop price, then .equip ${itemId}.`);
        }
        if (result.reason === "ITEM_NOT_OWNED") {
            return sendText(
                sock,
                jid,
                `❌ You do not own *${itemId}*.`
            );
        }

        if (result.reason === "ITEM_NOT_EQUIPPABLE") {
            return sendText(
                sock,
                jid,
                `❌ *${itemId}* cannot be equipped.`
            );
        }

        return sendText(
            sock,
            jid,
            `❌ Could not ${command} *${itemId}*.`
        );
    }

    return sendText(
        sock,
        jid,
        command === "equip"
            ? `✅ *${result.item.name}* equipped.${result.item.shield_remaining != null ? `\n🛡️ ${result.item.shield_remaining} absorption remaining. Protects automatically against attacks; does not refill when re-equipped.` : ""}`
            : `✅ *${result.item.name}* unequipped.`
    );
}

/*
==================================
MISSIONS
==================================
*/

if (
    command === "missions" ||
    command === "mission"
) {
    let missions = getPlayerMissions(player.id);

    if (args[0]) {
        const missionId = args[0].toLowerCase();
        missions = missions.filter(
            mission => mission.id === missionId
        );

        if (!missions.length) {
            return sendText(
                sock,
                jid,
                `❌ Mission *${missionId}* was not found.`
            );
        }
    }

    if (!missions.length) {
        return sendText(
            sock,
            jid,
            "📜 *MISSIONS*\n\nNo active missions are available."
        );
    }

    const lines = missions.map(mission => {
        const status = Number(mission.rewarded) === 1
            ? "✅ REWARDED"
            : Number(mission.completed) === 1
                ? "🎉 COMPLETED"
                : "🔄 ACTIVE";

        return `${status} *${mission.title}*\n` +
            `ID: ${mission.id}\n` +
            `${mission.description}\n` +
            `Progress: ${mission.progress}/${mission.target_amount}\n` +
            `Requirement: ${mission.requirement}\n` +
            `Reward: ${formatMoney(mission.reward)}`;
    }).join("\n\n");

    return sendText(
        sock,
        jid,
        `📜 *VALKYRIE MISSIONS*\n\n${lines}`
    );
}

/*
==================================
MENU
==================================
*/

if (
    command === "menu"
) {

    return sendText(
    sock,
    jid,

`⚔️ *𝕍𝔸𝕃𝕂𝕐ℝ𝕀𝔼*
━━━━━━━━━━━━━━━━━━

👤 *PLAYER*

.profile
.balance
.inventory
.equip <item_id>
.unequip <item_id>
.health
.medkit [amount]
.medic
.attack @player
.bounty @player amount
.bounties
.bountyinfo <id>
.mybounties
.missions

💰 *ECONOMY*

.work
.daily
.bank
.deposit
.withdraw
.pay

🛒 *MARKET*

.market
View items available for purchase.

.buy <item> [amount]
Buy an item from the market.

⚔️ *CRIME*

.rob @player [tool]
.hack @player

🎲 *CASINO*

.casino
.games
.coinflip <heads|tails> <amount>
.dice <amount>
.blackjack <amount>
.roulette <color|number> <amount>
.jackpot <amount>
.casino stats
.casino leaderboard

💼 *JOBS*

.jobs
.job <job_id>

📜 *.help*

━━━━━━━━━━━━━━━━━━`
);
}

                /*
                ==================================
                HELP
                ==================================
                */

                if (
                    command === "help"
                ) {

                    if (
                        args[0]?.toLowerCase() ===
                        "kamio"
                    ) {

                        if (
                            !hasKamioPermission(
                                player
                            )
                        ) {
                            return;
                        }

                        return sendText(
                            sock,
                            jid,

`⚔️ *𝕍𝔸𝕃𝕂𝕐ℝ𝕀𝔼 HELP*
━━━━━━━━━━━━━━━━━━

👤 *PLAYER*

.register
Create your Valkyrie account.

.profile
View your profile.

.health
Check HP, shield absorption, and recovery.

.attack @player
.bounty @player amount
.bounties
.bountyinfo <id>
.mybounties
Attack a registered player (30-second cooldown).

.balance
Check your cash balance.

.inventory
View your items.

.equip <item_id>
Equip a weapon or combat shield.

.unequip <item_id>
Unequip a weapon or combat shield.

💰 *ECONOMY*

.work
Earn money and XP.

.daily 🔜
Claim your daily reward.

.bank 🔜
View your bank.

.deposit 🔜
Deposit money.

.withdraw 🔜
Withdraw money.

.pay 🔜
Pay another player.

🛒 *MARKET*

.market
View items available for purchase.

.buy <item> [amount]
Buy an item from the market.

⚔️ *CRIME*

.rob @player
Attempt to rob another player.

.rob @player <tool>
Use a robbery tool during the robbery.

Available tools:
🔑 lockpick
🧤 gloves
🎭 disguise
🧰 breach
📡 scanner
🚗 getaway
🖤 blackout

.hack @player
Use a 🟪 Hacking Device to steal 60% of the target's bank balance.

💼 *JOBS*

.jobs
View available jobs and cooldowns.

.job <job_id>
Complete an eligible job.

🎲 *CASINO*

.casino
View casino games and rules.

.coinflip <heads|tails> <amount>
.dice <amount>
.blackjack <amount>
.roulette <color|number> <amount>
.jackpot <amount>
.casino stats
.casino leaderboard

📢 *KAMIO COMMUNITY*

.broadcast <message>
Send a Valkyrie announcement to this group and tag every member.

🏛️ *.menu*
Open the quick menu.

━━━━━━━━━━━━━━━━━━`
                        );
                    }

                    return sendText(
                        sock,
                        jid,

`⚔️ *𝕍𝔸𝕃𝕂𝕐ℝ𝕀𝔼 HELP*
━━━━━━━━━━━━━━━━━━

👤 *PLAYER*

.register
Create your account.

.profile
View your profile.

.health
Check health and recovery.

.medkit [amount]
Use Medkits outside combat.

.medic
Pay for a full heal outside combat.

.attack @player
.bounty @player amount
.bounties
.bountyinfo <id>
.mybounties
Attack another player.

.balance
Check your money.

.inventory
View your items.

.equip <item_id>
Equip a weapon or combat shield.

.unequip <item_id>
Unequip a weapon or combat shield.

💰 *ECONOMY*

.work
Earn money and XP.

.daily 🔜
Daily reward.

.bank 🔜
View your bank.

.deposit 🔜
Deposit money.

.withdraw 🔜
Withdraw money.

.pay 🔜
Pay another player.

🛒 *MARKET*

.market
View items available for purchase.

.buy <item> [amount]
Buy an item from the market.

⚔️ *CRIME*

.rob @player [tool]
Rob a registered player.

.hack @player
Use a Hacking Device.

💼 *JOBS*

.jobs
View available jobs and cooldowns.

.job <job_id>
Complete an eligible job.

🎲 *CASINO*

.casino
View casino games and rules.

.coinflip <heads|tails> <amount>
.dice <amount>
.blackjack <amount>
.roulette <color|number> <amount>
.jackpot <amount>
.casino stats
.casino leaderboard

🏛️ *.menu*
Open the quick menu.`
                    );
                }

                /*
                ==================================
                KAMIO MENU
                ==================================
                */

                if (
                    command === "kamio"
                ) {

                    if (
                        !hasKamioPermission(
                            player
                        )
                    ) {
                        return;
                    }

                    return sendText(
                        sock,
                        jid,

`👑 *𝕂𝔸𝕄𝕀𝕆*
━━━━━━━━━━━━━━━━━━

⚔️ *VALKYRIE COMMAND CENTER*

💰 *ECONOMY*

.addmoney @player amount
.removemoney @player amount
.addxp @player amount
.setlevel @player level

👤 *PLAYERS*

.setrank @player rank
.reset @player

📢 *COMMUNITY*

.broadcast message
Announce to this group and tag every member.

━━━━━━━━━━━━━━━━━━
📜 *.help kamio*`
                    );
                }

                /*
                ==================================
                KAMIO COMMANDS
                ==================================
                */

                if (
                    [
                        "addmoney",
                        "removemoney",
                        "addxp",
                        "setlevel",
                        "setrank",
                        "reset",
                        "broadcast"
                    ].includes(command)
                ) {

                    if (
                        !hasKamioPermission(
                            player
                        )
                    ) {
                        return;
                    }

                    /*
                    BROADCAST
                    */

                    if (
                        command === "broadcast"
                    ) {

                        const announcement =
                            args.join(" ").trim();

                        if (!announcement) {

                            return sendText(
                                sock,
                                jid,
                                "📢 Usage: .broadcast <message>"
                            );
                        }

                        let mentions = [];
                        if (jid.endsWith("@g.us")) {
                            try {
                                const metadata = await sock.groupMetadata(jid);
                                if (!Array.isArray(metadata?.participants) || !metadata.participants.length) {
                                    throw new Error("Group participants unavailable");
                                }
                                mentions = groupPlayerMentions(metadata.participants);
                                if (!mentions.length) throw new Error("No valid group participants");
                            } catch (error) {
                                console.error("Announcement members unavailable:", error);
                                return sendText(sock, jid,
                                    "📢 Could not load this group's members. The announcement was not sent. Try again.");
                            }
                        }

                        return sendText(
                            sock,
                            jid,

`📢 *VALKYRIE ANNOUNCEMENT*

${announcement}${mentions.length ? "\n\n" + mentions.map(playerMention).join(" ") : ""}`,
                            mentions
                        );
                    }

                    const mentioned =
                        msg.message
                            .extendedTextMessage
                            ?.contextInfo
                            ?.mentionedJid ||
                        [];

                    if (!mentioned.length) {

                        return sendText(
                            sock,
                            jid,

`⚠️ Tag a registered player.

Example:

.${command} @player`
                        );
                    }

                    const targetId =
                        mentioned[0];

                    const target =
                        getPlayer(targetId);

                    if (!target) {

                        return sendText(
                            sock,
                            jid,

"🚫 That player is not registered with Valkyrie."
                        );
                    }

                    /*
                    ADD / REMOVE MONEY
                    */

                    if (
                        command === "addmoney" ||
                        command === "removemoney"
                    ) {

                        const amount =
                            Number(
                                args.find(
                                    (arg) =>
                                        /^\d+$/.test(
                                            arg
                                        )
                                )
                            );

                        if (
                            !Number.isFinite(amount) ||
                            amount <= 0
                        ) {

                            return sendText(
                                sock,
                                jid,

`⚠️ Usage:

.${command} @player amount`
                            );
                        }

                        const current =
                            Number(
                                target.money
                            );

                        const next =
                            command === "addmoney"
                                ? current + amount
                                : Math.max(
                                    0,
                                    current - amount
                                );

                        updatePlayer(
                            targetId,
                            {
                                money:
                                    Math.floor(next)
                            }
                        );

                        return sendText(
                            sock,
                            jid,

`👑 *KAMIO ACTION*

👤 ${target.name}

💰 New Cash:
${formatMoney(next)}`
                        );
                    }

                    /*
                    ADD XP
                    */

                    if (
                        command === "addxp"
                    ) {

                        const amount =
                            Number(
                                args.find(
                                    (arg) =>
                                        /^\d+$/.test(
                                            arg
                                        )
                                )
                            );

                        if (
                            !Number.isInteger(amount) ||
                            amount <= 0
                        ) {

                            return sendText(
                                sock,
                                jid,

"⚠️ Usage: .addxp @player amount"
                            );
                        }

                        updatePlayer(
                            targetId,
                            {
                                xp:
                                    Number(
                                        target.xp
                                    ) + amount
                            }
                        );
                        return sendText(
                            sock,
                            jid,

`👑 *KAMIO ACTION*

👤 ${target.name}

✨ XP: +${amount}

⭐ New XP:
${Number(target.xp) + amount}`
                        );
                    }

                    /*
                    SET LEVEL
                    */

                    if (
                        command === "setlevel"
                    ) {

                        const level =
                            Number(
                                args.find(
                                    (arg) =>
                                        /^\d+$/.test(
                                            arg
                                        )
                                )
                            );

                        if (
                            !Number.isInteger(level) ||
                            level < 1 || level > 50
                        ) {

                            return sendText(
                                sock,
                                jid,

"⚠️ Usage: .setlevel @player <1–50>"
                            );
                        }

                        updatePlayer(
                            targetId,
                            {
                                level
                            }
                        );

                        return sendText(
                            sock,
                            jid,

`👑 *KAMIO ACTION*

👤 ${target.name}

⭐ New Level:
${level}
Rank: ${isKamio(target) ? 'KAMIO' : getRank(level)}
Maximum HP: ${getMaxHP(level)}`
                        );
                    }

                    /*
                    SET RANK
                    */

                    if (
                        command === "setrank"
                    ) {

                        const allowedRanks = [
                            "PLAYER",
                            "STAFF",
                            "KAMIO"
                        ];

                        const rank =
                            String(
                                args.find(
                                    (arg) =>
                                        allowedRanks.includes(
                                            arg.toUpperCase()
                                        )
                                ) || ""
                            ).toUpperCase();

                        if (!rank) {

                            return sendText(
                                sock,
                                jid,

"⚠️ Usage: .setrank @player PLAYER|STAFF|KAMIO"
                            );
                        }

                        updatePlayer(
                            targetId,
                            {
                                rank
                            }
                        );

                        return sendText(
                            sock,
                            jid,

`👑 *KAMIO ACTION*

👤 ${target.name}

🏷️ Administrative role:
${rank}
Progression rank: ${getRank(target.level)}`
                        );
                    }

                    /*
                    RESET PLAYER
                    */

                    if (
                        command === "reset"
                    ) {

                        if (
                            targetId ===
                            KAMIO_JID
                        ) {

                            return sendText(
                                sock,
                                jid,

"🚫 The KAMIO account cannot be reset."
                            );
                        }

                        const deleted = deletePlayer(targetId);
                        if (!deleted.success) return sendText(sock,jid,'This account has active bounties and cannot be reset yet.');

                        return sendText(
                            sock,
                            jid,

`♻️ ${target.name}'s Valkyrie account has been reset.

They can use *.register* to create a new account.`
                        );
                    }
                }

                /*
                ==================================
                BALANCE
                ==================================
                */

                if (
                    command === "balance" ||
                    command === "bal"
                ) {

                    return sendText(
                        sock,
                        jid,

`💰 *BALANCE*

👤 ${player.name}

💵 Cash:
${formatMoney(player.money)}

🏦 Bank:
${formatMoney(player.bank)}

💎 Total:
${formatMoney(
    Number(player.money) +
    Number(player.bank)
)}`
                    );
                }
/*
==========================================
DEPOSIT
==========================================
*/

if (
    command === "deposit"
) {

    const amount =
        Number(args[0]);

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        return sendText(
            sock,
            jid,
            "⚠️ Usage: .deposit <amount>"
        );
    }

    if (
        amount > Number(player.money)
    ) {
        return sendText(
            sock,
            jid,
            "🚫 You don't have enough cash."
        );
    }

    const kamio =
        isKamio(player);

    const limit =
        getDepositLimit(
            Number(player.level),
            kamio
        );

    let depositCount =
        Number(
            player.deposit_count || 0
        );

    let depositReset =
        Number(
            player.deposit_reset || 0
        );

    const now =
        Date.now();

    if (
        !depositReset ||
        now - depositReset >=
        24 * 60 * 60 * 1000
    ) {
        depositCount = 0;
        depositReset = now;
    }

    if (
        !kamio &&
        depositCount >= limit
    ) {
        return sendText(
            sock,
            jid,

`🚫 *DEPOSIT LIMIT REACHED*

🏷️ Rank:
${getRank(player.level)}

🏦 Daily Limit:
${limit} deposits

📊 Used:
${depositCount}/${limit}

⏰ Your deposit limit resets in 24 hours.

Level up to increase your deposit limit.`
        );
    }

    const newCash =
        Number(player.money) -
        amount;

    const newBank =
        Number(player.bank) +
        amount;

    const newDepositCount =
        kamio
            ? depositCount
            : depositCount + 1;

    updatePlayer(
        userId,
        {
            money: newCash,
            bank: newBank,
            deposit_count:
                newDepositCount,
            deposit_reset:
                depositReset
        }
    );

    const remaining =
        kamio
            ? "∞"
            : `${Math.max(
                0,
                limit -
                newDepositCount
            )}/${limit}`;

    return sendText(
        sock,
        jid,

`🏦 *DEPOSIT SUCCESSFUL*

💵 Deposited:
${formatMoney(amount)}

💰 Cash:
${formatMoney(newCash)}

🏦 Bank:
${formatMoney(newBank)}

📊 Deposits remaining:
${remaining}`
    );
}
/*
==========================================
WITHDRAW
==========================================
*/

if (
    command === "withdraw"
) {

    const amount = Number(args[0]);

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        return sendText(
            sock,
            jid,
            "⚠️ Usage: .withdraw <amount>"
        );
    }

    if (
        amount > Number(player.bank)
    ) {
        return sendText(
            sock,
            jid,
            "🚫 You don't have enough money in the bank."
        );
    }

    updatePlayer(
        userId,
        {
            bank:
                Number(player.bank) -
                amount,

            money:
                Number(player.money) +
                amount
        }
    );

    return sendText(
        sock,
        jid,

`🏦 *WITHDRAWAL SUCCESSFUL*

💵 Withdrawn:
${formatMoney(amount)}

💰 Cash:
${formatMoney(
    Number(player.money) +
    amount
)}

🏦 Bank:
${formatMoney(
    Number(player.bank) -
    amount
)}`
    );
}

/*
==========================================
PAY
==========================================
*/

if (
    command === "pay"
) {

    const mentioned =
        msg.message
            .extendedTextMessage
            ?.contextInfo
            ?.mentionedJid;

    if (
        !mentioned ||
        !mentioned.length
    ) {
        return sendText(
            sock,
            jid,
            "⚠️ Usage: .pay @player <amount>"
        );
    }

    const targetId =
        mentioned[0];

    if (
        targetId === userId
    ) {
        return sendText(
            sock,
            jid,
            "🚫 You can't pay yourself."
        );
    }

    const target =
        getPlayer(targetId);

    if (!target) {
        return sendText(
            sock,
            jid,
            "🚫 That player is not registered with Valkyrie."
        );
    }

    const amount =
        Number(
            args.find(
                arg =>
                    /^\d+$/.test(arg)
            )
        );

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        return sendText(
            sock,
            jid,
            "⚠️ Usage: .pay @player <amount>"
        );
    }

    if (
        amount > Number(player.money)
    ) {
        return sendText(
            sock,
            jid,
            "🚫 You don't have enough cash."
        );
    }

    updatePlayer(
        userId,
        {
            money:
                Number(player.money) -
                amount
        }
    );

    updatePlayer(
        targetId,
        {
            money:
                Number(target.money) +
                amount
        }
    );

    return sendText(
        sock,
        jid,

`💸 *PAYMENT SUCCESSFUL*

👤 Sent to:
${target.name}

💵 Amount:
${formatMoney(amount)}

💰 Your cash:
${formatMoney(
    Number(player.money) -
    amount
)}`
    );
}
                /*
                ==================================
                PROFILE
                ==================================
                */

                  /*
                  ==================================
                  MARKET
                  ==================================
                  */

                  if (
                      command === "markethelp"
                  ) {
                      return sendText(
                          sock,
                          jid,

`🛒 *VALKYRIE MARKET HELP*
━━━━━━━━━━━━━━━━━━

Use *.market* to view items for sale.

🩹 medkit — $2,500 each. Use .medkit [amount].
🩺 .medic — paid full healing outside combat; price shown in .market.
⚔️ valkyrie_executioner — $1,000,000, damage 150.
⚔️ reaper — $2,000,000, damage 180.
⚔️ dominator — $3,500,000, damage 220.
⚔️ warhammer — $6,000,000, damage 275.
🛡️ aegis_shield — $250,000, maximum 2. Robbery protection only.
Weapon hits are capped at half the target's maximum HP.

━━━━━━━━━━━━━━━━━━
🔪 *WEAPONS*
━━━━━━━━━━━━━━━━━━

pocket_knife
💵 $2,000
Basic close-range weapon.

combat_knife
💵 $5,000
Stronger close-range weapon.

hatchet
💵 $8,000
Heavy melee weapon.

pistol
💵 $15,000
Basic firearm.

revolver
💵 $25,000
Powerful handgun.

smg
💵 $45,000
Rapid-fire weapon.

shotgun
💵 $60,000
Heavy close-range firearm.

assault_rifle
💵 $100,000
Advanced automatic weapon.

sniper
💵 $150,000
High-powered long-range weapon.

━━━━━━━━━━━━━━━━━━
🛡️ *SHIELDS*
━━━━━━━━━━━━━━━━━━

light_shield
💵 $10,000
🛡️ Protection: 25

reinforced_shield
💵 $20,000
🛡️ Protection: 50

tactical_shield
💵 $35,000
🛡️ Protection: 75

heavy_shield
💵 $50,000
🛡️ Protection: 100

advanced_shield
💵 $75,000
🛡️ Protection: 150

━━━━━━━━━━━━━━━━━━
⚔️ *ROBBERY TOOLS*
━━━━━━━━━━━━━━━━━━

lockpick
💵 $10,000
🔑 +10% robbery success chance.
🗑️ Consumed after use.

gloves
💵 $8,000
🧤 Reduces failure fine by 40%.
🗑️ Consumed after use.

disguise
💵 $15,000
🎭 25% chance to avoid the failure fine.
🗑️ Consumed after use.

breach_kit
💵 $25,000
🧰 Raises maximum cash stolen from 30% to 40%.
🗑️ Consumed after use.

scanner
💵 $18,000
📡 +5% robbery success chance.
👁️ Reveals target cash.
🗑️ Consumed after use.

getaway_kit
💵 $30,000
🚗 35% chance to avoid the failure fine.
🗑️ Consumed after use.

blackout_device
💵 $250,000
🖤 +25% robbery success chance.
💰 Raises maximum cash stolen to 50%.
🛡️ Bypasses robbery protection.
⭐ Legendary.
🗑️ Consumed after use.
📦 Maximum quantity: 1.

━━━━━━━━━━━━━━━━━━
🟪 *HACKING DEVICE*
━━━━━━━━━━━━━━━━━━

hacking_device
💵 $600,000
🟪 Guarantees a successful hack.
🏦 Steals 60% of target bank balance.
💰 Transfers stolen money to your bank.
🗑️ Consumed after use.
📦 Maximum quantity: 2.

Usage:
.hack @player

━━━━━━━━━━━━━━━━━━
🛠️ *USAGE*
━━━━━━━━━━━━━━━━━━

.market
View items for sale.

.buy <item>
Buy one item.

.buy <item> <amount>
Buy multiple items.

.inventory
View your inventory.

.rob @player
Attempt a normal robbery.

.rob @player <tool>
Use one robbery tool.

.hack @player
Use a Hacking Device.

Only one robbery tool can be used per robbery attempt.

━━━━━━━━━━━━━━━━━━
💡 *ROBBERY TOOLS*
━━━━━━━━━━━━━━━━━━

🔑 lockpick
🧤 gloves
🎭 disguise
🧰 breach
📡 scanner
🚗 getaway
🖤 blackout

Tool aliases are accepted where supported by the command.
`
                      );
                  }

                  if (
                      command === "markethelp"
                  ) {
                      return sendText(
                          sock,
                          jid,

`🛒 *VALKYRIE MARKET HELP*
━━━━━━━━━━━━━━━━━━

Use *.market* to view items for sale.

🩹 medkit — $2,500 each. Use .medkit [amount].
🩺 .medic — paid full healing outside combat; price shown in .market.
⚔️ valkyrie_executioner — $1,000,000, damage 150.
⚔️ reaper — $2,000,000, damage 180.
⚔️ dominator — $3,500,000, damage 220.
⚔️ warhammer — $6,000,000, damage 275.
🛡️ aegis_shield — $250,000, maximum 2. Robbery protection only.
Weapon hits are capped at half the target's maximum HP.

━━━━━━━━━━━━━━━━━━
🔪 *WEAPONS*
━━━━━━━━━━━━━━━━━━

pocket_knife
💵 $2,000
Basic close-range weapon.

combat_knife
💵 $5,000
Stronger close-range weapon.

hatchet
💵 $8,000
Heavy melee weapon.

pistol
💵 $15,000
Basic firearm.

revolver
💵 $25,000
Powerful handgun.

smg
💵 $45,000
Rapid-fire weapon.

shotgun
💵 $60,000
Heavy close-range firearm.

assault_rifle
💵 $100,000
Advanced automatic weapon.

sniper
💵 $150,000
High-powered long-range weapon.

━━━━━━━━━━━━━━━━━━
🛡️ *SHIELDS*
━━━━━━━━━━━━━━━━━━

light_shield
💵 $10,000
🛡️ Protection: 25

reinforced_shield
💵 $20,000
🛡️ Protection: 50

tactical_shield
💵 $35,000
🛡️ Protection: 75

heavy_shield
💵 $50,000
🛡️ Protection: 100

advanced_shield
💵 $75,000
🛡️ Protection: 150

━━━━━━━━━━━━━━━━━━
⚔️ *ROBBERY TOOLS*
━━━━━━━━━━━━━━━━━━

lockpick
💵 $10,000
🔑 +10% robbery success chance.
🗑️ Consumed after use.

gloves
💵 $8,000
🧤 Reduces failure fine by 40%.
🗑️ Consumed after use.

disguise
💵 $15,000
🎭 25% chance to avoid the failure fine.
🗑️ Consumed after use.

breach_kit
💵 $25,000
🧰 Raises maximum cash stolen from 30% to 40%.
🗑️ Consumed after use.

scanner
💵 $18,000
📡 +5% robbery success chance.
👁️ Reveals target cash.
🗑️ Consumed after use.

getaway_kit
💵 $30,000
🚗 35% chance to avoid the failure fine.
🗑️ Consumed after use.

blackout_device
💵 $250,000
🖤 +25% robbery success chance.
💰 Raises maximum cash stolen to 50%.
🛡️ Bypasses robbery protection.
⭐ Legendary.
🗑️ Consumed after use.
📦 Maximum quantity: 1.

━━━━━━━━━━━━━━━━━━
🟪 *HACKING DEVICE*
━━━━━━━━━━━━━━━━━━

hacking_device
💵 $600,000
🟪 Guarantees a successful hack.
🏦 Steals 60% of target bank balance.
💰 Transfers stolen money to your bank.
🗑️ Consumed after use.
📦 Maximum quantity: 2.

Usage:
.hack @player

━━━━━━━━━━━━━━━━━━
🛠️ *USAGE*
━━━━━━━━━━━━━━━━━━

.market
View items for sale.

.buy <item>
Buy one item.

.buy <item> <amount>
Buy multiple items.

.inventory
View your inventory.

.rob @player
Attempt a normal robbery.

.rob @player <tool>
Use one robbery tool.

.hack @player
Use a Hacking Device.

Only one robbery tool can be used per robbery attempt.

━━━━━━━━━━━━━━━━━━
💡 *ROBBERY TOOLS*
━━━━━━━━━━━━━━━━━━

🔑 lockpick
🧤 gloves
🎭 disguise
🧰 breach
📡 scanner
🚗 getaway
🖤 blackout

Tool aliases are accepted where supported by the command.
`
                      );
                  }

                  if (
                      command === "market" ||
                      command === "shop"
                  ) {

                      const items =
                          getMarketItems();

                      if (!items.length) {
                          return sendText(
                              sock,
                              jid,
                              `🛒 *MARKET*

━━━━━━━━━━━━━━━━

The market is currently empty.`
                          );
                      }

                      let currentCategory = "";

                      const lines = items.map(
                          (item, index) => {

                          let output = "";

                          if (
                              item.category !==
                              currentCategory
                          ) {
                              currentCategory =
                                  item.category;

                              output +=
                                  `\n📂 *${item.category}*\n`;
                          }

                          output +=
                              `${index + 1}. ${item.name}
   🆔 ${item.id}
   💵 ${formatMoney(item.price)}
   📝 ${item.description}`;

                          return output;
                      }).join("\n\n");

                      return sendText(
                          sock,
                          jid,

`🛒 *VALKYRIE MARKET*

━━━━━━━━━━━━━━━━

${lines}

━━━━━━━━━━━━━━━━

🩺 *MEDIC SERVICE*
.medic — full healing, no inventory item.
Fee: missing HP / maximum HP × ($15,000 + $700 × level), rounded up.
Unavailable at full HP, during combat, or while defeated.

🩹 .medkit [amount] — use owned Medkits outside combat.

💡 Buy with:
.buy <item>

Example:
.buy pistol`
                      );
                  }

                  /*
                  ==================================
                  BUY
                  ==================================
                  */

                  if (command === "buy") {

                      const itemId =
                          args[0]?.toLowerCase();

                      const quantity =
                          args[1] === undefined
                              ? 1
                              : Number(args[1]);

                      if (!itemId) {
                          return sendText(
                              sock,
                              jid,
                              `🛒 *BUY ITEM*

Usage:
.buy <item> [quantity]

Example:
.buy pistol
.buy medkit 2`
                          );
                      }

                      if (
                          !Number.isInteger(quantity) ||
                          quantity <= 0
                      ) {
                          return sendText(
                              sock,
                              jid,
                              "❌ Quantity must be a positive whole number."
                          );
                      }

                      let result;
                      try { result = buyItem(player.id,itemId,quantity,actionId); }
                      catch (error) {
                          console.error('Purchase failed:',error);
                          return sendText(sock,jid,'Purchase could not be saved. No cash was spent. Try again.');
                      }

                      if (
                          !result.success
                      ) {

                          if (
                              result.reason ===
                              "ITEM_NOT_FOUND"
                          ) {
                              return sendText(
                                  sock,
                                  jid,
                                  `❌ Item *${itemId}* was not found in the market.

Use .market to view available items.`
                              );
                          }

                          if (
                              result.reason ===
                              "INSUFFICIENT_FUNDS"
                          ) {
                              return sendText(
                                  sock,
                                  jid,
`❌ *INSUFFICIENT FUNDS*

💵 Price:
${formatMoney(result.total)}

💰 Your cash:
${formatMoney(result.balance)}`
                              );
                          }

                          return sendText(
                              sock,
                              jid,
                              "❌ Purchase failed."
                          );
                      }

                      if (result.duplicate) return sendText(sock,jid,'✅ This purchase action was already processed.');
                      const missionCompletions = result.missionCompletions;

                      return sendText(
                          sock,
                          jid,
`🛒 *PURCHASE SUCCESSFUL*

📦 Item:
${result.item.name}

🔢 Quantity:
${result.quantity}

💵 Paid:
${formatMoney(result.total)}

💰 Remaining cash:
${formatMoney(result.balance)}

🎒 Added to your inventory.${formatMissionCompletions(missionCompletions)}`
                      );
                  }

                  /*
                  ==================================
                  INVENTORY
                  ==================================
                  */

                  if (
                      command === "inventory" ||
                      command === "inv"
                  ) {

                      const inventory =
                          getInventory(player.id);

                      if (!inventory.length) {
                          return sendText(
                              sock,
                              jid,

`🎒 *INVENTORY*

━━━━━━━━━━━━━━━━

Your inventory is empty.`
                          );
                      }

                      const lines =
                          inventory.map(
                              (item, index) => {

                          const equipped =
                              Number(item.equipped) === 1
                                  ? " 🟢 Equipped"
                                  : "";

                          return `${index + 1}. ${item.name} x${item.quantity}${equipped}
   📂 ${item.category}${equipped}`;
                      }).join("\n\n");

                      return sendText(
                          sock,
                          jid,

`🎒 *INVENTORY*

━━━━━━━━━━━━━━━━

${lines}

━━━━━━━━━━━━━━━━`
                      );
                  }

                  /*
                  ==================================
                  PROFILE
                  ==================================
                  */

                  if (command === 'profile' || command === 'p') {
                    const role = ['KAMIO', 'STAFF'].includes(player.rank)
                        ? `👑 Role:\n${player.rank}\n\n`
                        : '';
                    return sendText(sock,jid,`${playerMention(replyPlayerJid) || player.name}\n\n👤 *PLAYER PROFILE*\n\n━━━━━━━━━━━━━━━━\n\n🏷️ Name:\n${player.name}\n\n🏛️ Rank:\n${getRank(player.level)}\n\n${role}⭐ Level:\n${player.level}\n\n✨ XP:\n${Number(player.xp).toLocaleString()}\n\n❤️ Health:\n${player.health}/${getMaxHP(player.level)}\n\n💵 Cash:\n${formatMoney(player.money)}\n\n🏦 Bank:\n${formatMoney(player.bank)}\n\n━━━━━━━━━━━━━━━━`);
                  }

                /*
                ==================================
                WORK
                ==================================
                */

                if (command === 'work') {
                    let result;
                    try { result = claimWork(userId,actionId); }
                    catch (error) {
                        console.error('Work failed:',error);
                        return sendText(sock,jid,'Work could not be saved. No reward was claimed. Try again.');
                    }
                    if (result.duplicate) return sendText(sock,jid,'✅ This work action was already processed.');
                    if (!result.success) return sendText(sock,jid,result.reason === 'COOLDOWN'
                        ? `⏳ *WORK COOLDOWN*\nCome back in ${Math.ceil(result.remainingMs/1000)}s.`
                        : 'Missing message ID. Send a new command.');
                    return sendText(sock,jid,`💼 *WORK COMPLETE*\nEarned: ${formatMoney(result.payout)}\nXP: +${result.xp}\nCash: ${formatMoney(result.balance)}` + levelUpText(result.progression, isKamio(player)) + formatMissionCompletions(result.missionCompletions));
                }
/*
==================================
DAILY REWARD
==================================
*/

if (
    command === "daily"
) {
                    return persistMissionCommand(sock,jid,replyPlayerJid,userId,actionId,'daily',(queueReply,queuePlayerReply) => {

    /*
    Re-fetch the player immediately before
    checking the cooldown.

    This prevents the bot from using an
    outdated player object when multiple
    .daily messages arrive quickly.
    */

    const currentPlayer =
        getPlayer(userId);

    if (!currentPlayer) {
        return queueReply(
            sock,
            jid,
            "❌ Player data not found."
        );
    }

    const now =
        Date.now();

    const lastDaily =
        Number(
            currentPlayer.last_daily || 0
        );

    const elapsed =
        now - lastDaily;

    if (
        elapsed < DAILY_COOLDOWN
    ) {

        const remaining =
            DAILY_COOLDOWN - elapsed;

        const hours =
            Math.floor(
                remaining /
                (60 * 60 * 1000)
            );

        const minutes =
            Math.floor(
                (
                    remaining %
                    (60 * 60 * 1000)
                ) /
                (60 * 1000)
            );

        return queueReply(
            sock,
            jid,

`⏳ *DAILY REWARD*

You've already claimed today's reward.

Come back in:
*${hours}h ${minutes}m*`
        );
    }

    const reward =
        DAILY_REWARD;

    const newMoney =
        Number(currentPlayer.money) +
        reward;

    updatePlayer(
        userId,
        {
            money: newMoney,
            last_daily: now
        }
    );

    const missionCompletions =
        recordMissionProgress(
            userId,
            "collect_daily",
            1
        );

    return queueReply(
        sock,
        jid,

`🎁 *DAILY REWARD*

👤 ${currentPlayer.name}

💵 Reward:
${formatMoney(reward)}

💰 New Cash:
${formatMoney(newMoney)}

⏰ Come back tomorrow for another reward!${formatMissionCompletions(missionCompletions)}`
    );

                    });
                }

                /*
                ==================================
                ROB
                ==================================
                */

                if (
                    command === "hack"
                ) {
                    return persistMissionCommand(sock,jid,replyPlayerJid,userId,actionId,'hack',(queueReply,queuePlayerReply) => {
                    const mentionedJid =
                        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

                    if (!mentionedJid) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ *HACK FAILED*\n\nMention the player you want to hack.\n\nExample:\n.hack @player`
                        );
                    }

                    const targetId = mentionedJid;

                    if (targetId === userId) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ You cannot hack yourself.`
                        );
                    }

                    const target = getPlayer(targetId);

                    if (!target) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ That player is not registered in Valkyrie.`
                        );
                    }

                    const hackerDevice =
                        getInventoryItem(
                            userId,
                            "hacking_device"
                        );

                    if (
                        !hackerDevice ||
                        Number(hackerDevice.quantity) < 1
                    ) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ *HACK FAILED*\n\nYou don't have a 🟪 *Hacking Device*.\n\nBuy one from the market first.`
                        );
                    }

                    const targetBank =
                        Number(target.bank) || 0;

                    if (targetBank <= 0) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ *HACK FAILED*\n\n@${targetId.split("@")[0]} has no money in their bank.\n\n🟪 Your Hacking Device was not consumed.`,
                            [targetId]
                        );
                    }

                    const stolen =
                        Math.max(
                            1,
                            Math.floor(
                                targetBank * 0.60
                            )
                        );

                    updatePlayer(
                        targetId,
                        {
                            bank:
                                targetBank - stolen
                        }
                    );

                    const hacker =
                        getPlayer(userId);

                    updatePlayer(
                        userId,
                        {
                            bank:
                                Number(hacker.bank) +
                                stolen
                        }
                    );

                    removeItem(
                        userId,
                        "hacking_device",
                        1
                    );

                    const missionCompletions =
                        recordMissionProgress(
                            userId,
                            "use_item",
                            1
                        );

                    return queueReply(
                        sock,
                        jid,
                        `🟪 *HACK SUCCESSFUL*\n\n` +
                        `🎯 Target: @${targetId.split("@")[0]}\n` +
                        `🏦 Target bank before hack: $${targetBank.toLocaleString()}\n` +
                        `💻 Stolen: $${stolen.toLocaleString()}\n` +
                        `📈 Percentage stolen: 60%\n\n` +
                        `🟪 Hacking Device consumed.\n` +
                        `💰 The stolen money was transferred to your bank.` +
                        formatMissionCompletions(missionCompletions),
                        [targetId]
                    );

                    });
                }

                if (
                    command === "rob"
                ) {
                    return persistMissionCommand(sock,jid,replyPlayerJid,userId,actionId,'rob',(queueReply,queuePlayerReply) => {
                    const mentionedJid =
                        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

                    if (!mentionedJid) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ *ROBBERY FAILED*\n\nMention the player you want to rob.\n\nExample:\n.rob @player`
                        );
                    }

                    const targetId = mentionedJid;

                    if (targetId === userId) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ You cannot rob yourself.`
                        );
                    }

                    const target = getPlayer(targetId);

                    if (!target) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ That player is not registered in Valkyrie.`
                        );
                    }

                    if (Number(target.money) < 100) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ *ROBBERY FAILED*\n\nThat player does not have enough cash to rob.`
                        );
                    }

                    const toolAliases = {
                        lockpick: "lockpick",

                        gloves: "gloves",

                        disguise: "disguise",

                        breach: "breach_kit",
                        breach_kit: "breach_kit",

                        scanner: "scanner",

                        getaway: "getaway_kit",
                        getaway_kit: "getaway_kit",

                        blackout: "blackout_device",
                        blackout_device: "blackout_device"
                    };

                    const requestedTool =
                        args[1]?.toLowerCase() || null;

                    const toolId =
                        requestedTool
                            ? toolAliases[requestedTool]
                            : null;

                    if (
                        requestedTool &&
                        !toolId
                    ) {
                        return queueReply(
                            sock,
                            jid,
                            `❌ *UNKNOWN ROBBERY TOOL*\n\nAvailable tools:\n🔑 lockpick\n🧤 gloves\n🎭 disguise\n🧰 breach\n📡 scanner\n🚗 getaway\n🖤 blackout`
                        );
                    }

                    let tool = null;

                    if (toolId) {
                        tool = getInventoryItem(
                            userId,
                            toolId
                        );

                        if (!tool || Number(tool.quantity) < 1) {
                            return queueReply(
                                sock,
                                jid,
                                `❌ You don't have a *${toolId}* in your inventory.`
                            );
                        }
                    }

                    const isBlackout =
                        toolId === "blackout_device";

                    const scannerActive =
                        toolId === "scanner";

                    const currentPlayer =
                        getPlayer(userId);

                    if (!currentPlayer) {
                        return queueReply(
                            sock,
                            jid,
                            "❌ Player data not found."
                        );
                    }

                    if (Number(currentPlayer.money) < 100) {
                        return queueReply(
                            sock,
                            jid,
                            "❌ You need at least $100 cash to attempt a robbery."
                        );
                    }

                    const now = Date.now();
                    const lastRob =
                        Number(currentPlayer.last_rob || 0);

                    if (now - lastRob < ROB_COOLDOWN) {
                        const remaining = Math.ceil(
                            (ROB_COOLDOWN - (now - lastRob)) / 1000
                        );

                        return queueReply(
                            sock,
                            jid,
                            `⏳ *ROBBERY COOLDOWN*\n\nTry again in *${remaining}s*.`
                        );
                    }

                    // Every valid robbery attempt consumes the cooldown,
                    // including attempts blocked by target protection.
                    updatePlayer(userId, {
                        last_rob: now
                    });

                    // The enclosing action commits cooldown and shield consumption together.
                    // Replies are queued until the durable save succeeds.
                    if (removeItem(targetId, "aegis_shield", 1)) {
                        return ([
                            queuePlayerReply(sock, targetId, targetId,
                                "🛡️ *AEGIS SHIELD ACTIVATED*\n\nYour Aegis Shield blocked a robbery and was consumed. No money was stolen."),
                            queueReply(sock, jid,
                                "🛡️ *ROBBERY BLOCKED*\n\nThe target's Aegis Shield blocked your robbery and was consumed. No money was stolen and no fine was charged.")
                        ]);
                    }

                    const protection =
                        getRobberyProtection(targetId);

                    if (
                        !isBlackout &&
                        Number(protection.protected_until) > now
                    ) {
                        const seconds = Math.ceil(
                            (
                                Number(protection.protected_until) -
                                now
                            ) / 1000
                        );

                        return queueReply(
                            sock,
                            jid,
                            `🛡️ *TARGET PROTECTED*\n\nThis player has recently survived several robbery attempts.\n\nTry again in *${seconds}s*.`
                        );
                    }

                    let successChance = 55;

                    if (toolId === "lockpick") {
                        successChance += 10;
                    }

                    if (toolId === "scanner") {
                        successChance += 5;
                    }

                    if (isBlackout) {
                        successChance += 25;
                    }

                    successChance =
                        Math.min(successChance, 100);

                    let maxStealPercent = 0.30;

                    if (toolId === "breach_kit") {
                        maxStealPercent = 0.40;
                    }

                    if (isBlackout) {
                        maxStealPercent = 0.50;
                    }

                    let fineMultiplier = 1;

                    if (toolId === "gloves") {
                        fineMultiplier = 0.60;
                    }

                    const roll =
                        Math.random() * 100;

                    const success =
                        roll < successChance;

                    let missionCompletions = [];

                    if (toolId) {
                        removeItem(
                            userId,
                            toolId,
                            1
                        );

                        missionCompletions =
                            recordMissionProgress(
                                userId,
                                "use_item",
                                1
                            );
                    }

                    if (!success) {
                        const fine =
                            Math.floor(
                                Math.random() * 401
                            ) + 100;

                        let finalFine =
                            Math.max(
                                0,
                                Math.floor(
                                    fine *
                                    fineMultiplier
                                )
                            );

                        let escapedFine = false;

                        if (
                            toolId === "disguise" &&
                            Math.random() < 0.25
                        ) {
                            escapedFine = true;
                        }

                        if (
                            toolId === "getaway_kit" &&
                            Math.random() < 0.35
                        ) {
                            escapedFine = true;
                        }

                        if (escapedFine) {
                            finalFine = 0;
                        }

                        if (!isBlackout) {
                            const attempts =
                                Number(
                                    protection.attempts
                                ) + 1;

                            let protectedUntil =
                                Number(
                                    protection.protected_until
                                );

                            if (
                                attempts >=
                                Number(
                                    protection.threshold
                                )
                            ) {
                                protectedUntil =
                                    Date.now() +
                                    15000;

                                updateRobberyProtection(
                                    targetId,
                                    {
                                        attempts: 0,
                                        protected_until:
                                            protectedUntil,
                                        threshold:
                                            Math.floor(
                                                Math.random() *
                                                6
                                            ) + 2
                                    }
                                );
                            } else {
                                updateRobberyProtection(
                                    targetId,
                                    {
                                        attempts
                                    }
                                );
                            }
                        }

                        if (finalFine > 0) {
                            const player =
                                getPlayer(userId);

                            const actualFine =
                                Math.min(
                                    Number(
                                        player.money
                                    ),
                                    finalFine
                                );

                            updatePlayer(
                                userId,
                                {
                                    money:
                                        Number(
                                            player.money
                                        ) -
                                        actualFine
                                }
                            );
                        }

                        let message =
                            `🚨 *ROBBERY FAILED*\n\n` +
                            `🎯 Target: @${targetId.split("@")[0]}\n` +
                            `🎲 Success chance: ${successChance}%\n\n`;

                        if (scannerActive) {
                            message +=
                                `📡 Target cash: $${Number(target.money).toLocaleString()}\n\n`;
                        }

                        if (escapedFine) {
                            message +=
                                `🚗 You escaped the police fine!\n\n`;
                        } else if (finalFine > 0) {
                            message +=
                                `💸 Fine: $${finalFine.toLocaleString()}\n\n`;
                        } else {
                            message +=
                                `💸 Fine: $0\n\n`;
                        }

                        message +=
                            `Your robbery tool was consumed.`;

                        message += formatMissionCompletions(
                            missionCompletions
                        );

                        return queueReply(
                            sock,
                            jid,
                            message
                        );
                    }

                    const targetCash =
                        Number(target.money);

                    let maxSteal =
                        Math.floor(
                            targetCash *
                            maxStealPercent
                        );

                    maxSteal =
                        Math.max(
                            100,
                            maxSteal
                        );

                    maxSteal =
                        Math.min(
                            maxSteal,
                            targetCash,
                            Number(currentPlayer.money)
                        );

                    if (maxSteal < 100) {
                        return queueReply(
                            sock,
                            jid,
                            "❌ You need at least $100 cash to attempt a robbery."
                        );
                    }

                    const stolen =
                        Math.floor(
                            Math.random() *
                            (
                                maxSteal - 100 + 1
                            )
                        ) + 100;

                    const robberyCompleted =
                        completeRobbery(
                            userId,
                            targetId,
                            stolen
                        );

                    if (!robberyCompleted) {
                        return queueReply(
                            sock,
                            jid,
                            "❌ *ROBBERY FAILED*\\n\\nThe target's balance changed before the robbery completed."
                        );
                    }

                    if (!isBlackout) {
                        updateRobberyProtection(
                            targetId,
                            {
                                attempts: 0
                            }
                        );
                    }

                    const robberyMissionCompletions =
                        recordMissionProgress(
                            userId,
                            "complete_robbery",
                            1
                        );

                    let message =
                        `💰 *ROBBERY SUCCESSFUL*\n\n` +
                        `🎯 Target: @${targetId.split("@")[0]}\n` +
                        `💵 Stolen: $${stolen.toLocaleString()}\n` +
                        `📊 Success chance: ${successChance}%\n`;

                    if (scannerActive) {
                        message +=
                            `📡 Target cash before robbery: $${targetCash.toLocaleString()}\n`;
                    }

                    if (isBlackout) {
                        message +=
                            `🖤 Blackout Device bypassed robbery protection.\n`;
                    }

                    message +=
                        `\n🛠️ Your robbery tool was consumed.`;

                    message += formatMissionCompletions(
                        robberyMissionCompletions
                    );

                    return queueReply(
                        sock,
                        jid,
                        message
                    );

                    });
                }

            } catch (error) {

                console.error(
                    "❌ Message handler error:"
                );

                console.error(error);
            }
        };
    const onMessages = async ({ messages, type }) => {
        for (const message of messages) {
            if (!isCurrent()) return;
            await handleMessages({ messages: [message], type });
        }
    };
    sock.ev.on("messages.upsert", onMessages);
    return () => sock.ev.off("messages.upsert", onMessages);
}

/*
==========================================
START BOT
==========================================
*/

const lifecycle = createWhatsAppLifecycle({
    useMultiFileAuthState,
    makeWASocket,
    DisconnectReason,
    initialize: startBot,
    attachMessages,
    phoneNumber: PHONE_NUMBER,
    socketOptions: {
        logger: P({ level: "info" }),
        printQRInTerminal: false,
        emitOwnEvents: true,
        fireInitQueries: true,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        syncFullHistory: false
    }
});
lifecycle.installSignalHandlers();
lifecycle.start().catch(error => console.error("Failed to start WhatsApp lifecycle:", error));
