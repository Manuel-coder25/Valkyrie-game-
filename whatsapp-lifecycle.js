'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// This is lifecycle ownership for the existing socket, not another WA client.
// PM2 must also run exactly one process for this linked device.
let processOwner;
const AUTH_PATH = path.join(__dirname, 'auth');

class AuthStartupError extends Error {}
class StaleSocketError extends Error {}

// The Baileys helper silently treats read/parse failures as fresh credentials.
// Check first so an existing session cannot silently become a new registration.
async function inspectAuth(authPath, setup, io = fs) {
    let creds;
    try {
        creds = JSON.parse(await io.readFile(path.join(authPath, 'creds.json'), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw new AuthStartupError(`Cannot read existing credentials; auth preserved: ${error.message}`);
        }
        let files;
        try { files = await io.readdir(authPath); }
        catch (directoryError) {
            if (directoryError.code !== 'ENOENT') throw directoryError;
            files = [];
        }
        if (files.length) throw new AuthStartupError('Credentials missing from nonempty auth directory; auth preserved.');
        if (!setup) throw new AuthStartupError('PAIRING_REQUIRED: initial setup must be explicitly requested with --pair.');
        return null;
    }
    if (!creds || typeof creds.registered !== 'boolean' || !creds.noiseKey ||
        !creds.signedIdentityKey || !creds.signedPreKey || !creds.advSecretKey ||
        !Number.isInteger(creds.registrationId) || (creds.registered && !creds.me?.id)) {
        throw new AuthStartupError('Existing credentials are incomplete; auth preserved for explicit diagnosis.');
    }
    if (!creds.registered && !setup) {
        throw new AuthStartupError('PAIRING_REQUIRED: credentials are unregistered; use explicit initial setup.');
    }
    return creds;
}

function createWhatsAppLifecycle({
    useMultiFileAuthState, makeWASocket, DisconnectReason, initialize, attachMessages,
    phoneNumber, socketOptions = {}, authPath = AUTH_PATH,
    setup = process.argv.includes('--pair'), io = fs, log = console,
    timers = { setTimeout, clearTimeout }, signals = process,
    exit = code => process.exit(code),
    settle = () => new Promise(resolve => setImmediate(resolve))
}) {
    let auth, initialized, starting, active, reconnectTimer, shutdownPromise;
    let initializationComplete = false;
    let stopped = false, generation = 0, attempts = 0, badSessions = 0, replacements = 0;
    let pairingAllowed = setup, persistenceError;
    const pending = new Set();
    const owner = {};
    const signalHandlers = new Map();
    const current = entry => !stopped && active === entry && entry.id === generation;

    function cancel(timer) { if (timer !== undefined) timers.clearTimeout(timer); }
    function cancelWork() {
        cancel(reconnectTimer);
        reconnectTimer = undefined;
        if (active) {
            cancel(active.pairingTimer);
            cancel(active.stableTimer);
            active.pairingTimer = active.stableTimer = undefined;
        }
    }

    function halt(label, error, code = 78) {
        log.error(label, error);
        // shutdown marks stopped synchronously, before any pending callback runs.
        void shutdown(label).then(() => exit(code), shutdownError => {
            log.error('AUTH_PERSISTENCE_FAILED: shutdown could not drain safely', shutdownError);
            exit(78);
        });
    }

    function track(operation) {
        const promise = Promise.resolve().then(operation);
        pending.add(promise);
        // Attach a rejection handler even for EventEmitter's unawaited saveCreds.
        promise.then(() => pending.delete(promise), error => {
            pending.delete(promise);
            if (error instanceof StaleSocketError) {
                log.error('WHATSAPP_STALE_AUTH_OPERATION: retired socket cannot write auth', error);
                return;
            }
            persistenceError = error;
            halt('AUTH_PERSISTENCE_FAILED: auth preserved; reconnect stopped', error);
        });
        return promise;
    }

    async function drain() {
        do {
            await Promise.allSettled([...pending]);
            await settle();
        } while (pending.size);
        if (persistenceError) throw persistenceError;
    }

    async function retire(entry) {
        if (!entry) return;
        if (entry.retiring) return entry.retiring;
        entry.retiring = (async () => {
            cancel(entry.pairingTimer);
            cancel(entry.stableTimer);
            let failure;
            try { await drain(); } catch (error) { failure = error; }
            // end closes the transport; logout would revoke the linked device.
            try { entry.sock.end(new Error('Valkyrie socket lifecycle ended')); }
            catch (error) { entry.closeFailed = true; failure ||= error; }
            try { await drain(); } catch (error) { failure ||= error; }
            entry.acceptWrites = false;
            entry.sock.ev.off('creds.update', entry.saveCreds);
            entry.sock.ev.off('connection.update', entry.onConnection);
            entry.detachMessages?.();
            if (active === entry && !entry.closeFailed) active = undefined;
            if (failure) throw failure;
        })();
        return entry.retiring;
    }

    function schedule(reason, minimum = 0) {
        if (stopped || reconnectTimer !== undefined) return;
        const id = generation;
        const delay = Math.max(minimum, Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6)));
        log.log('WHATSAPP_RECONNECTING', { reason, delayMs: delay, attempt: attempts });
        const timer = timers.setTimeout(() => {
            if (stopped || id !== generation || reconnectTimer !== timer) return;
            reconnectTimer = undefined;
            void start();
        }, delay);
        reconnectTimer = timer;
    }

    function handleConnection(entry, update) {
        if (!current(entry)) return;
        const { connection, lastDisconnect } = update;
        if (connection === 'connecting') {
            log.log('WHATSAPP_CONNECTING', { generation: entry.id });
            // Only the original, explicitly requested setup attempt may pair.
            if (pairingAllowed && !auth.state.creds.registered && !entry.pairingScheduled) {
                entry.pairingScheduled = true;
                entry.pairingTimer = timers.setTimeout(() => {
                    entry.pairingTimer = undefined;
                    if (!current(entry) || !pairingAllowed || auth.state.creds.registered) return;
                    pairingAllowed = false;
                    void entry.sock.requestPairingCode(phoneNumber).then(code => {
                        if (current(entry)) log.log('INITIAL_PAIRING_CODE', code);
                    }, error => log.error('PAIRING_FAILED: retry requires explicit initial setup', error));
                }, 3000);
            }
        } else if (connection === 'open') {
            pairingAllowed = false;
            cancel(entry.pairingTimer);
            cancel(entry.stableTimer);
            log.log('WHATSAPP_CONNECTED: transport open; command readiness is not implied');
            entry.stableTimer = timers.setTimeout(() => {
                if (current(entry)) attempts = badSessions = replacements = 0;
            }, 60000);
        } else if (connection === 'close') {
            // Invalidate immediately, before async draining or reconnect timers.
            generation++;
            const closedGeneration = generation;
            pairingAllowed = false;
            cancelWork();
            const error = lastDisconnect?.error;
            const code = error?.output?.statusCode ?? error?.statusCode;
            log.error('WHATSAPP_CLOSED', { code, error });
            if (code === DisconnectReason.loggedOut) {
                halt('WHATSAPP_LOGGED_OUT: explicit re-authentication required; auth preserved', error);
                return;
            }
            let reason = 'unknown', minimum = 0;
            if (code === DisconnectReason.connectionClosed) reason = 'connectionClosed';
            else if (code === DisconnectReason.connectionLost || code === DisconnectReason.timedOut) reason = 'connectionLost/timedOut';
            else if (code === DisconnectReason.restartRequired) reason = 'restartRequired';
            else if (code === DisconnectReason.badSession) {
                reason = 'badSession: auth preserved; repeated failures require diagnosis';
                // Bound the burst, then use a long cooldown rather than discard auth.
                if (++badSessions >= 3) minimum = 300000;
            } else if (code === DisconnectReason.connectionReplaced) {
                reason = 'connectionReplaced: check for another process/host using this session';
                // Do not fight a competing owner in a rapid replacement loop.
                minimum = ++replacements >= 3 ? 900000 : 60000;
            }
            void retire(entry).then(() => {
                if (generation === closedGeneration) schedule(reason, minimum);
            }, error => {
                halt('SOCKET_RETIRE_FAILED: reconnect stopped', error);
            });
        }
    }

    async function loadAuth() {
        const existing = await inspectAuth(authPath, setup, io);
        if (stopped) return;
        const loaded = await useMultiFileAuthState(authPath);
        // Detect helper fallback, including a read failure between the two reads.
        if (existing && (loaded.state.creds.registered !== existing.registered ||
            loaded.state.creds.registrationId !== existing.registrationId ||
            loaded.state.creds.advSecretKey !== existing.advSecretKey)) {
            throw new AuthStartupError('Auth helper did not load the inspected session; auth preserved.');
        }
        auth = loaded;
        if (auth.state.creds.registered) pairingAllowed = false;
        log.log('AUTH_LOADED', { path: authPath, registered: auth.state.creds.registered });
        if (!auth.state.creds.registered) log.log('PAIRING_REQUIRED: explicit initial setup active');
    }

    function start() {
        if (stopped) return Promise.resolve();
        if (starting) return starting;
        if (active && current(active)) return Promise.resolve();
        if (processOwner && processOwner !== owner) {
            return Promise.reject(new Error('Another Valkyrie lifecycle already owns a socket in this process.'));
        }
        processOwner = owner;
        cancel(reconnectTimer);
        reconnectTimer = undefined;
        starting = (async () => {
            // Validate auth before any ordinary socket can attempt registration.
            if (!auth) await loadAuth();
            if (stopped) return;
            if (!initialized) initialized = Promise.resolve().then(initialize);
            await initialized;
            initializationComplete = true;
            if (stopped) return;
            await retire(active);
            if (stopped) return;
            cancel(reconnectTimer);
            reconnectTimer = undefined;
            const entry = { id: ++generation, acceptWrites: true };
            const check = operation => {
                if (!entry.acceptWrites) throw new StaleSocketError('Rejected auth operation from retired socket');
                return operation();
            };
            const keys = {
                get: (...args) => track(() => check(() => auth.state.keys.get(...args))),
                set: (...args) => track(() => check(() => auth.state.keys.set(...args)))
            };
            const saveCreds = () => {
                if (auth.state.creds.registered) pairingAllowed = false;
                return track(() => check(() => auth.saveCreds()));
            };
            const sock = makeWASocket({ ...socketOptions, auth: { creds: auth.state.creds, keys } });
            entry.sock = sock;
            entry.saveCreds = saveCreds;
            entry.onConnection = update => handleConnection(entry, update);
            active = entry;
            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', entry.onConnection);
            entry.detachMessages = attachMessages(sock, () => current(entry));
        })().catch(error => {
            if (stopped) return;
            if (error instanceof AuthStartupError || !auth || !initializationComplete) {
                halt('STARTUP_BLOCKED: auth preserved', error);
                return;
            }
            log.error('WHATSAPP_START_FAILED', error);
            generation++;
            return retire(active).then(() => schedule('startup failure'), error => {
                halt('SOCKET_RETIRE_FAILED: reconnect stopped', error);
            });
        }).finally(() => { starting = undefined; });
        return starting;
    }

    function shutdown(reason = 'shutdown') {
        if (shutdownPromise) return shutdownPromise;
        stopped = true;
        generation++;
        pairingAllowed = false;
        cancelWork();
        log.log('SHUTTING_DOWN', reason);
        shutdownPromise = (async () => {
            try {
                await starting;
                await retire(active);
                await drain();
            } finally {
                for (const [signal, handler] of signalHandlers) signals.off(signal, handler);
                // Never release ownership if closing the transport itself failed.
                if (!active && processOwner === owner) processOwner = undefined;
            }
        })();
        return shutdownPromise;
    }

    function installSignalHandlers() {
        for (const signal of ['SIGINT', 'SIGTERM']) {
            if (signalHandlers.has(signal)) continue;
            const handler = () => {
                void shutdown(signal).then(() => exit(0), error => {
                    log.error('SHUTDOWN_FAILED: auth preserved', error);
                    exit(78);
                });
            };
            signalHandlers.set(signal, handler);
            signals.on(signal, handler);
        }
    }

    return { start, shutdown, installSignalHandlers };
}

module.exports = { createWhatsAppLifecycle, inspectAuth, AUTH_PATH };
