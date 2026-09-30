'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createWhatsAppLifecycle, AUTH_PATH, inspectAuth } = require('../whatsapp-lifecycle');

const reasons = {
    loggedOut: 401, connectionClosed: 428, connectionLost: 408, timedOut: 408,
    restartRequired: 515, badSession: 500, connectionReplaced: 440
};
const tick = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function credentials(registered = true) {
    return { registered, registrationId: 123, advSecretKey: 'fake-test-secret',
        noiseKey: {}, signedIdentityKey: {}, signedPreKey: {},
        ...(registered ? { me: { id: 'test@s.whatsapp.net' } } : {}) };
}
function harness(t, options = {}) {
    const events = [], logs = [], exits = [], sockets = [], reads = [], loads = [];
    const scheduled = new Map(), history = [], signals = new EventEmitter();
    let initCount = 0;
    const state = { creds: credentials(options.registered ?? true), keys: {
        get: async () => ({}),
        set: async data => { events.push('keys:start'); await options.keyWrite?.(data); events.push('keys:end'); }
    } };
    const timers = {
        setTimeout(callback, delay) {
            const timer = { callback, delay };
            history.push(timer); scheduled.set(timer, timer); return timer;
        },
        clearTimeout(timer) { scheduled.delete(timer); }
    };
    const io = {
        async readFile(file) {
            reads.push(file);
            if (options.readError) throw options.readError;
            return JSON.stringify(options.diskCreds ?? state.creds);
        },
        async readdir() { return options.files ?? []; }
    };
    const lifecycle = createWhatsAppLifecycle({
        DisconnectReason: reasons, phoneNumber: 'test', setup: options.setup ?? false,
        io, timers, signals, settle: async () => {}, exit: code => exits.push(code),
        log: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
        initialize: async () => { initCount++; await options.initialize?.(); },
        async useMultiFileAuthState(authPath) {
            loads.push(authPath);
            await options.load?.();
            if (options.fallback) state.creds = credentials(false);
            return { state, saveCreds: async () => {
                events.push('creds:start'); await options.credentialWrite?.(); events.push('creds:end');
            } };
        },
        makeWASocket(config) {
            options.construct?.();
            const sock = {
                ev: new EventEmitter(), config, pairs: 0, ended: 0,
                async requestPairingCode() { sock.pairs++; return 'FAKECODE'; },
                end() {
                    sock.ended++; events.push('socket:end');
                    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: {
                        error: { output: { statusCode: 428 } }
                    } });
                }
            };
            sockets.push(sock); events.push('socket:create'); return sock;
        },
        attachMessages: options.attachMessages ?? (() => () => events.push('messages:detach'))
    });
    t.after(async () => { await lifecycle.shutdown('test cleanup').catch(() => {}); await tick(); });
    const fire = async (timer, stale = false) => {
        if (!stale) assert(scheduled.delete(timer), 'timer must be pending');
        timer.callback(); await tick();
    };
    const update = (connection, code, sock = sockets.at(-1)) => sock.ev.emit('connection.update', {
        connection, lastDisconnect: { error: Object.assign(new Error('test disconnect'), { output: { statusCode: code } }) }
    });
    const reconnect = async code => {
        update('close', code); await tick();
        assert.equal(scheduled.size, 1);
        await fire([...scheduled.keys()][0]);
    };
    return { lifecycle, state, signals, events, logs, exits, sockets, reads, loads,
        scheduled, history, fire, update, reconnect, initCount: () => initCount };
}

test('registered startup: stable project auth path, one owner, no pairing even with --pair', async t => {
    const h = harness(t, { setup: true });
    const a = h.lifecycle.start(), b = h.lifecycle.start();
    assert.equal(a, b);
    await a;
    await h.lifecycle.start();
    h.update('connecting'); await tick();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].pairs, 0);
    assert.equal(h.scheduled.size, 0);
    assert.deepEqual(h.loads, [path.join(__dirname, '..', 'auth')]);
    assert.equal(AUTH_PATH, h.loads[0]);
    assert(h.logs.some(([label]) => label === 'AUTH_LOADED'));
});

test('explicit initial setup may pair once, after rechecking registration', async t => {
    const h = harness(t, { setup: true, registered: false });
    await h.lifecycle.start();
    h.update('connecting'); h.update('connecting');
    assert.equal(h.scheduled.size, 1);
    await h.fire([...h.scheduled.keys()][0]);
    assert.equal(h.sockets[0].pairs, 1);
    h.update('connecting');
    assert.equal(h.scheduled.size, 0);
    await h.reconnect(428);
    h.update('connecting');
    assert.equal(h.sockets[1].pairs, 0);
    assert.equal(h.scheduled.size, 0);
});

test('pairing callback cannot pair after credentials become registered', async t => {
    const h = harness(t, { setup: true, registered: false });
    await h.lifecycle.start(); h.update('connecting');
    const timer = [...h.scheduled.keys()][0];
    h.state.creds.registered = true;
    await h.fire(timer);
    assert.equal(h.sockets[0].pairs, 0);
});

test('normal unregistered startup fails closed without calling auth helper', async t => {
    const h = harness(t, { registered: false });
    await h.lifecycle.start(); await tick();
    assert.equal(h.loads.length, 0);
    assert.equal(h.sockets.length, 0);
    assert.deepEqual(h.exits, [78]);
    assert(h.logs.some(args => args.some(value => String(value).includes('PAIRING_REQUIRED'))));
});

test('missing auth only permits explicit setup in an empty directory', async t => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const h = harness(t, { registered: false, setup: true, readError: missing });
    await h.lifecycle.start(); h.update('connecting');
    await h.fire([...h.scheduled.keys()][0]);
    assert.equal(h.sockets[0].pairs, 1);
    await assert.rejects(inspectAuth('/fake/auth', true, {
        readFile: async () => { throw missing; }, readdir: async () => ['session-old.json']
    }), /nonempty/);
    await assert.rejects(inspectAuth('/fake/auth', false, {
        readFile: async () => { throw missing; }, readdir: async () => []
    }), /PAIRING_REQUIRED/);
});

test('malformed or unreadable auth never falls back to pairing', async t => {
    const h = harness(t, { setup: true, readError: new SyntaxError('truncated credentials') });
    await h.lifecycle.start(); await tick();
    assert.equal(h.loads.length, 0); assert.equal(h.sockets.length, 0);
    assert.deepEqual(h.exits, [78]);
});

test('helper fallback after preflight is rejected', async t => {
    const h = harness(t, { fallback: true });
    await h.lifecycle.start(); await tick();
    assert.equal(h.sockets.length, 0); assert.deepEqual(h.exits, [78]);
});

test('transient reconnect reuses auth and initializes database only once', async t => {
    const h = harness(t);
    await h.lifecycle.start();
    for (const code of [428, 408, 515, 503, undefined]) {
        await h.reconnect(code); h.update('connecting');
    }
    assert.equal(h.loads.length, 1); assert.equal(h.initCount(), 1);
    assert.equal(h.sockets.length, 6);
    assert(h.sockets.every(sock => sock.pairs === 0));
    assert(h.sockets.every(sock => sock.config.auth.creds === h.state.creds));
    assert(h.sockets.slice(0, -1).every(sock => sock.ended === 1));
});

test('duplicate closes and stale reconnect callbacks cannot create sockets or timers', async t => {
    const h = harness(t); await h.lifecycle.start();
    h.update('close', 428); h.update('close', 428); await tick();
    assert.equal(h.scheduled.size, 1);
    const timer = [...h.scheduled.keys()][0];
    await h.fire(timer); await h.fire(timer, true);
    assert.equal(h.sockets.length, 2); assert.equal(h.scheduled.size, 0);
    await h.lifecycle.start(); assert.equal(h.sockets.length, 2);
});

test('stale pairing timer cannot pair a replacement socket', async t => {
    const h = harness(t, { setup: true, registered: false });
    await h.lifecycle.start(); h.update('connecting');
    const pairingTimer = [...h.scheduled.keys()][0];
    await h.reconnect(408);
    await h.fire(pairingTimer, true); h.update('connecting');
    assert(h.sockets.every(sock => sock.pairs === 0));
    assert.equal(h.scheduled.size, 0);
});

test('loggedOut preserves auth and stops reconnect and pairing', async t => {
    const h = harness(t); await h.lifecycle.start();
    h.update('close', 401); await tick();
    await h.lifecycle.start();
    assert.equal(h.sockets.length, 1); assert.equal(h.scheduled.size, 0);
    assert.deepEqual(h.exits, [78]);
    assert.equal(h.state.creds.registered, true);
    assert(h.logs.some(([label]) => label.startsWith('WHATSAPP_LOGGED_OUT')));
});

test('SIGTERM cancels reconnect; stale callback cannot restart after shutdown', async t => {
    const h = harness(t); h.lifecycle.installSignalHandlers(); await h.lifecycle.start();
    h.update('close', 428); await tick();
    const timer = [...h.scheduled.keys()][0];
    h.signals.emit('SIGTERM'); await tick();
    await h.fire(timer, true); await h.lifecycle.start();
    assert.equal(h.scheduled.size, 0); assert.equal(h.sockets.length, 1);
    assert.deepEqual(h.exits, [0]);
});

test('shutdown waits for BOTH creds and Signal-key writes before closing, without logout or filesystem mutations', async t => {
    const creds = deferred(), keys = deferred();
    const h = harness(t, { credentialWrite: () => creds.promise, keyWrite: () => keys.promise });
    await h.lifecycle.start();
    const sock = h.sockets[0];
    sock.ev.emit('creds.update', {});
    const keyWrite = sock.config.auth.keys.set({ session: { test: 'fake' } });
    await tick();
    const stop = h.lifecycle.shutdown(); await tick();
    assert.equal(sock.ended, 0);
    creds.resolve(); await tick(); assert.equal(sock.ended, 0);
    keys.resolve(); await keyWrite; await stop;
    assert.equal(sock.ended, 1);
    assert(h.events.indexOf('creds:end') < h.events.indexOf('socket:end'));
    assert(h.events.indexOf('keys:end') < h.events.indexOf('socket:end'));
    assert.equal(sock.ev.listenerCount('creds.update'), 0);
    assert.equal(h.state.creds.registered, true);
    // Fake sockets offer no logout, and fake filesystem offers no mutating API.
});

test('replacement waits for pending writes and rejects stale key writers', async t => {
    const keys = deferred();
    const h = harness(t, { keyWrite: () => keys.promise }); await h.lifecycle.start();
    const old = h.sockets[0];
    const write = old.config.auth.keys.set({}); await tick();
    h.update('close', 515); await tick();
    assert.equal(h.scheduled.size, 0); assert.equal(old.ended, 0);
    keys.resolve(); await write; await tick();
    assert.equal(h.scheduled.size, 1);
    await h.fire([...h.scheduled.keys()][0]);
    const count = h.events.filter(event => event === 'keys:start').length;
    await assert.rejects(old.config.auth.keys.set({}), /retired socket/); await tick();
    assert.equal(h.events.filter(event => event === 'keys:start').length, count);
    assert.equal(h.sockets[1].ended, 0, 'a stale callback must not shut down the replacement');
    assert.deepEqual(h.exits, []);
});

test('persistence failure is observed without an unhandled rejection or new pairing', async t => {
    const h = harness(t, { credentialWrite: async () => { throw new Error('disk unavailable'); } });
    await h.lifecycle.start();
    h.sockets[0].ev.emit('creds.update', {}); await tick();
    assert(h.logs.some(([label]) => label.startsWith('AUTH_PERSISTENCE_FAILED')));
    assert.equal(h.sockets[0].ended, 1);
    assert.equal(h.scheduled.size, 0);
    assert(h.exits.includes(78));
});

test('SIGINT during database initialization blocks socket creation', async t => {
    const initializing = deferred();
    const h = harness(t, { initialize: () => initializing.promise });
    h.lifecycle.installSignalHandlers();
    const started = h.lifecycle.start(); await tick();
    assert.equal(h.initCount(), 1);
    h.signals.emit('SIGINT'); initializing.resolve();
    await started; await tick();
    assert.equal(h.sockets.length, 0); assert.deepEqual(h.exits, [0]);
});

test('shutdown during auth loading or initialization cannot create a socket', async t => {
    const loading = deferred();
    const h = harness(t, { load: () => loading.promise });
    const start = h.lifecycle.start(); await tick();
    const stop = h.lifecycle.shutdown(); loading.resolve();
    await start; await stop;
    assert.equal(h.sockets.length, 0); assert.equal(h.initCount(), 0);
});

test('backoff is capped, has one timer, and resets only after a stable connection', async t => {
    const h = harness(t); await h.lifecycle.start();
    const delays = [];
    for (let i = 0; i < 9; i++) {
        h.update('close', 408); await tick();
        assert.equal(h.scheduled.size, 1);
        const timer = [...h.scheduled.keys()][0]; delays.push(timer.delay); await h.fire(timer);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    h.update('open');
    await h.fire([...h.scheduled.keys()][0]);
    h.update('close', 408); await tick();
    assert.equal([...h.scheduled.keys()][0].delay, 1000);
});

test('badSession and replacement conflicts cool down instead of pairing or tight retry loops', async t => {
    const h = harness(t); await h.lifecycle.start();
    for (const code of [500, 500, 500, 440, 440, 440]) {
        h.update('close', code); await tick();
        const timer = [...h.scheduled.keys()][0];
        if (code === 500 && h.history.length === 3) assert.equal(timer.delay, 300000);
        if (code === 440) assert(timer.delay >= 60000);
        await h.fire(timer);
    }
    assert.equal(h.history.at(-1).delay, 900000);
    assert(h.sockets.every(sock => sock.pairs === 0));
    assert.deepEqual(h.exits, []);
});

test('socket construction failure retries without reinitializing the application', async t => {
    let calls = 0;
    const h = harness(t, { construct: () => { if (++calls === 1) throw new Error('temporary failure'); } });
    await h.lifecycle.start(); await tick();
    assert.equal(h.scheduled.size, 1);
    await h.fire([...h.scheduled.keys()][0]);
    assert.equal(h.sockets.length, 1); assert.equal(h.initCount(), 1);
});

test('a second lifecycle in the same process cannot acquire socket ownership', async t => {
    const first = harness(t), second = harness(t);
    await first.lifecycle.start();
    await assert.rejects(second.lifecycle.start(), /already owns/);
    assert.equal(second.sockets.length, 0);
});

test('real index wiring initializes once and attaches gameplay handler to each generation', async t => {
    let initializations = 0, bound = 0;
    const h = harness(t, { initialize: async () => { initializations++; },
        attachMessages: () => { bound++; return () => {}; } });
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    let actual;
    const context = vm.createContext({
        require(name) {
            if (name === '@whiskeysockets/baileys') return {};
            if (name === './whatsapp-lifecycle') return { createWhatsAppLifecycle(options) { actual = options; return h.lifecycle; } };
            if (name === 'pino') return () => ({});
            return {};
        }, console: { log() {}, error() {} }
    });
    vm.runInContext(source, context); await tick();
    assert.equal(actual.initialize.name, 'startBot');
    assert.equal(actual.attachMessages.name, 'attachMessages');
    assert.equal(actual.socketOptions.syncFullHistory, false);
    await h.reconnect(428);
    assert.equal(initializations, 1); assert.equal(bound, 2);
    const events = new EventEmitter();
    const detach = actual.attachMessages({ ev: events }, () => false);
    assert.equal(events.listenerCount('messages.upsert'), 1);
    events.emit('messages.upsert', { messages: [{}], type: 'notify' });
    detach(); assert.equal(events.listenerCount('messages.upsert'), 0);
});

test('PM2 configuration selects one fork worker and never enables pairing', () => {
    const config = require('../ecosystem.config.cjs');
    assert.equal(config.apps.length, 1);
    const app = config.apps[0];
    assert.equal(app.instances, 1); assert.equal(app.exec_mode, 'fork');
    assert.equal(app.cwd, '/home/ubuntu/Valkyrie-game-'); assert.equal(app.watch, false);
    assert(app.kill_timeout >= 30000); assert.deepEqual(app.stop_exit_codes, [78]);
    assert.equal(app.args, undefined);
});
