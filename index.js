
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");

const {
    createPlayer,
    getPlayer,
    updatePlayer
} = require("./database");

const PREFIX = ".";

function formatMoney(amount) {
    return "$" + Number(amount).toLocaleString();
}

function random(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function startBot() {
    const { state, saveCreds } =
        await useMultiFileAuthState("./auth");

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" })
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {

        if (connection === "open") {
            console.log("✅ WhatsApp bot connected!");
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log("🔄 Reconnecting...");
                startBot();
            } else {
                console.log("❌ Logged out.");
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {

        const msg = messages[0];

        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

        if (!text.startsWith(PREFIX)) return;

        const args = text
            .slice(PREFIX.length)
            .trim()
            .split(/\s+/);

        const command = args.shift()?.toLowerCase();

        const userId = msg.key.participant || jid;

        const pushName =
            msg.pushName || "Player";

        createPlayer(userId, pushName);

        const player = getPlayer(userId);

        // =========================
        // BALANCE
        // =========================

        if (command === "balance" || command === "bal") {

            return sock.sendMessage(jid, {
                text:
`💰 *BALANCE*

👤 ${player.name}

💵 Cash: ${formatMoney(player.money)}
🏦 Bank: ${formatMoney(player.bank)}

💎 Total: ${formatMoney(
    player.money + player.bank
)}`
            });
        }

        // =========================
        // PROFILE
        // =========================

        if (command === "profile" || command === "p") {

            return sock.sendMessage(jid, {
                text:
`👤 *PLAYER PROFILE*

━━━━━━━━━━━━━━

🏷️ Name: ${player.name}
⭐ Level: ${player.level}
✨ XP: ${player.xp}

❤️ Health: ${player.health}/100

💵 Cash: ${formatMoney(player.money)}
🏦 Bank: ${formatMoney(player.bank)}

━━━━━━━━━━━━━━`
            });
        }

        // =========================
        // WORK
        // =========================

        if (command === "work") {

            const now = Date.now();
            const cooldown = 60 * 1000;

            if (now - player.last_work < cooldown) {

                const remaining =
                    Math.ceil(
                        (cooldown - (now - player.last_work)) / 1000
                    );

                return sock.sendMessage(jid, {
                    text:
`⏳ *WORK COOLDOWN*

You're tired.

Come back in *${remaining}s*.`
                });
            }

            const jobs = [
                "You delivered a package 📦",
                "You worked at a nightclub 🎵",
                "You completed a delivery 🚗",
                "You hacked a vending machine 💻",
                "You worked a street hustle 🏙️"
            ];

            const job =
                jobs[random(0, jobs.length - 1)];

            const reward = random(500, 2500);

            const xpGain = random(10, 25);

            let newXP = player.xp + xpGain;
            let newLevel = player.level;

            if (newXP >= player.level * 100) {

                newXP -= player.level * 100;
                newLevel++;

                await sock.sendMessage(jid, {
                    text:
`🎉 *LEVEL UP!*

You reached *Level ${newLevel}*!`
                });
            }

            updatePlayer(userId, {
                money: player.money + reward,
                xp: newXP,
                level: newLevel,
                last_work: now
            });

            return sock.sendMessage(jid, {
                text:
`💼 *WORK COMPLETE*

${job}

💵 Earned: ${formatMoney(reward)}
✨ XP: +${xpGain}

💰 New balance:
${formatMoney(player.money + reward)}`
            });
        }

        // =========================
        // ROB
        // =========================

        if (command === "rob") {

            const mentioned =
                msg.message.extendedTextMessage
                    ?.contextInfo
                    ?.mentionedJid;

            if (!mentioned || !mentioned.length) {

                return sock.sendMessage(jid, {
                    text:
`🔫 *ROBBERY*

Tag someone to rob.

Example:
.rob @player`
                });
            }

            const targetId = mentioned[0];

            if (targetId === userId) {

                return sock.sendMessage(jid, {
                    text: "💀 You can't rob yourself."
                });
            }

            createPlayer(targetId, "Player");

            const target = getPlayer(targetId);

            if (!target) return;

            if (target.money < 100) {

                return sock.sendMessage(jid, {
                    text:
`🚫 *ROBBERY FAILED*

Your target doesn't have enough cash.`
                });
            }

            const success = Math.random() < 0.55;

            if (!success) {

                const fine = Math.min(
                    player.money,
                    random(100, 500)
                );

                updatePlayer(userId, {
                    money: player.money - fine
                });

                return sock.sendMessage(jid, {
                    text:
`🚨 *ROBBERY FAILED*

The police caught you!

💸 Fine: ${formatMoney(fine)}`
                });
            }

            const stolen = Math.min(
                target.money,
                random(
                    100,
                    Math.max(100, Math.floor(target.money * 0.25))
                )
            );

            updatePlayer(targetId, {
                money: target.money - stolen
            });

            updatePlayer(userId, {
                money: player.money + stolen
            });

            return sock.sendMessage(jid, {
                text:
`🔫 *ROBBERY SUCCESSFUL*

🎯 Target: ${target.name}

💰 Stolen: ${formatMoney(stolen)}

💵 Your cash:
${formatMoney(player.money + stolen)}`
            });
        }
    });
}

startBot();
