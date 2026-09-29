// Accept actual WhatsApp player JIDs only; strip a device suffix for display.
function playerMention(jid) {
    const match = typeof jid === "string" && jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/);
    return match ? `@${match[1]}` : null;
}

function sendPlayerReply(sock, chatJid, playerJid, text, extraMentions = []) {
    const mentions = [...new Set([playerJid, ...extraMentions])].filter(playerMention);
    let body = String(text);
    for (const jid of mentions) {
        const mention = playerMention(jid);
        if (!new RegExp(`${mention}(?![\\w:])`).test(body)) {
            body = `${mention}\n\n${body}`;
        }
    }
    return sock.sendMessage(chatJid, { text: body, mentions });
}

function createPlayerReply(playerJid) {
    return (sock, chatJid, text, mentions = []) =>
        sendPlayerReply(sock, chatJid, playerJid, text, mentions);
}

// Use the group's own participant IDs so phone and LID groups both work.
function groupPlayerMentions(participants) {
    return [...new Set(participants.map(member =>
        [member.id, member.lid, member.jid, member.phoneNumber]
            .find(playerMention)?.replace(/:\d+(?=@)/, "")
    ).filter(Boolean))];
}

module.exports = { playerMention, sendPlayerReply, createPlayerReply, groupPlayerMentions };
