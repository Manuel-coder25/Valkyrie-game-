// Gameplay routing tests deliberately bypass network/auth/process ownership.
// The real lifecycle is covered separately with injected auth, sockets and clocks.
exports.createWhatsAppLifecycle = ({ initialize, makeWASocket, attachMessages }) => ({
    installSignalHandlers() {},
    async start() {
        await initialize();
        attachMessages(makeWASocket(), () => true);
    }
});
