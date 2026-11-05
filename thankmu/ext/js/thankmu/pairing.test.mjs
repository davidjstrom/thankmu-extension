// Tests for the ThankMu pairing logic (W-P3 part B). Pure: chrome.storage, fetch and the RNG are injected.
// Run: node --test thankmu/ext/js/thankmu/pairing.test.mjs  (tests/run.sh and scripts/build_chrome.sh run every *.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPairing, newInstallId, pairUrl, ERRORS, KEYS, assertAppOrigin, externalListener, ACCOUNT_ERRORS, HANDOFF_CODE_RE, HANDOFF_PAGES, PAIRING_TTL_MS } from './pairing.js';

const ORIGIN = 'https://app.example.invalid';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const INSTALL = 'A'.repeat(43);
const TOKEN = 'tmc_' + 'Zx9-_'.repeat(8) + 'Zx9';   // 43 chars after the prefix
const CLIENT = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

function fakeStorage(init = {}) {
    const data = { ...init };
    return {
        data,
        async get(keys) {
            const ks = keys === null ? Object.keys(data) : [].concat(keys);
            const out = {};
            for (const k of ks) { if (k in data) { out[k] = data[k]; } }
            return out;
        },
        async set(obj) { Object.assign(data, obj); },
        async remove(keys) { for (const k of [].concat(keys)) { delete data[k]; } },
    };
}

function meBody(over = {}) {
    return { client_id: CLIENT, kind: 'plugin', external_id: INSTALL, household_id: 'h', user_id: 'u', ...over };
}

const HANG = Symbol('hang');
const hangForever = async () => new Promise(() => {});

function fakeFetch(respond) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init });
        const r = typeof respond === 'function' ? respond(url, init) : respond;
        if (r instanceof Error) { throw r; }
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            headers: { get: k => r.headers?.[k] ?? null },
            async json() {
                if (r.body === HANG) { return new Promise(() => {}); }   // headers arrived, body never does
                if (r.body === undefined) { throw new SyntaxError('no json'); }
                return r.body;
            },
        };
    };
    fn.calls = calls;
    return fn;
}

// Every log line the module writes, plus every console.* call while a test runs: the token must appear in none.
const logged = [];
const log = (...a) => { logged.push(a.map(String).join(' ')); };
for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const orig = console[m];
    console[m] = (...a) => { logged.push(a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ')); if (process.env.THANKMU_TEST_VERBOSE) { orig(...a); } };
}

function setup({ storage, fetch, confirmTimeoutMs, apiTimeoutMs } = {}) {
    storage = storage ?? fakeStorage({ [KEYS.installId]: INSTALL });
    fetch = fetch ?? fakeFetch({ status: 200, body: meBody() });
    const p = createPairing({ appOrigin: ORIGIN, extensionId: EXT_ID, storage, fetch, getRandomValues: a => { a.fill(7); return a; }, log, confirmTimeoutMs, apiTimeoutMs });
    return { p, storage, fetch };
}

const goodMsg = (over = {}) => ({ type: 'thankmu.pair', v: 1, external_id: INSTALL, client_id: CLIENT, token: TOKEN, ...over });
const goodSender = { origin: ORIGIN, url: ORIGIN + '/pair' };

test('install id: >=128 bits, base64url, from getRandomValues', () => {
    let asked = 0;
    const id = newInstallId(a => { asked = a.length; for (let i = 0; i < a.length; i++) { a[i] = 255 - i; } return a; });
    assert.ok(asked >= 16, 'at least 16 random bytes');
    assert.match(id, /^[A-Za-z0-9_-]{22,64}$/);
    assert.ok(!id.includes('='));
});

test('install id: created once, persisted, never regenerated (concurrent callers share it)', async () => {
    const storage = fakeStorage();
    const { p } = setup({ storage });
    const [a, b] = await Promise.all([p.ensureInstallId(), p.ensureInstallId()]);
    assert.equal(a, b);
    assert.equal(storage.data[KEYS.installId], a);
    // A second instance (a new service-worker lifetime) keeps the stored id.
    const { p: p2 } = setup({ storage });
    assert.equal(await p2.ensureInstallId(), a);
});

test('pair url carries the install id and extension id in the fragment only', async () => {
    const { p } = setup();
    assert.equal(await p.pairUrl(), `${ORIGIN}/pair#install=${INSTALL}&ext=${EXT_ID}`);
    assert.equal(pairUrl(ORIGIN, INSTALL, EXT_ID), `${ORIGIN}/pair#install=${INSTALL}&ext=${EXT_ID}`);
});

test('app origin must be a bare https origin', () => {
    for (const bad of [undefined, '', 'http://app.example.invalid', 'https://app.example.invalid/', 'https://app.example.invalid/x', 'app.example.invalid']) {
        assert.throws(() => assertAppOrigin(bad), /APP_ORIGIN/, String(bad));
        assert.throws(() => createPairing({ appOrigin: bad, extensionId: EXT_ID, storage: fakeStorage(), fetch: fakeFetch({ status: 200 }), getRandomValues: a => a, log }), /APP_ORIGIN/);
    }
    assert.equal(assertAppOrigin('https://app.example.invalid:8443'), 'https://app.example.invalid:8443');
});

test('happy path: confirms with GET /api/client/me (Bearer, no cookies) and only then stores', async () => {
    const { p, storage, fetch } = setup();
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: true });
    assert.equal(fetch.calls.length, 1);
    const { url, init } = fetch.calls[0];
    assert.equal(url, `${ORIGIN}/api/client/me`);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(storage.data[KEYS.token], TOKEN);
    assert.equal(storage.data[KEYS.clientId], CLIENT);
});

const rejects = [
    ['wrong origin', goodMsg(), { origin: 'https://evil.example.invalid', url: 'https://evil.example.invalid/' }, ERRORS.badOrigin],
    ['origin with a path-like suffix', goodMsg(), { origin: ORIGIN + '.evil.invalid' }, ERRORS.badOrigin],
    ['no sender origin', goodMsg(), {}, ERRORS.badOrigin],
    ['not an object', 'hello', goodSender, ERRORS.badMessage],
    ['wrong type', goodMsg({ type: 'thankmu.other' }), goodSender, ERRORS.badMessage],
    ['wrong version', goodMsg({ v: 2 }), goodSender, ERRORS.badVersion],
    ['wrong install id', goodMsg({ external_id: 'B'.repeat(43) }), goodSender, ERRORS.installMismatch],
    ['missing install id', goodMsg({ external_id: undefined }), goodSender, ERRORS.installMismatch],
    ['bad token: wrong prefix', goodMsg({ token: 'tmx_' + 'a'.repeat(43) }), goodSender, ERRORS.badToken],
    ['bad token: too short', goodMsg({ token: 'tmc_' + 'a'.repeat(42) }), goodSender, ERRORS.badToken],
    ['bad token: bad char', goodMsg({ token: 'tmc_' + 'a'.repeat(42) + '=' }), goodSender, ERRORS.badToken],
    ['bad token: trailing newline', goodMsg({ token: TOKEN + '\n' }), goodSender, ERRORS.badToken],
    ['bad client id', goodMsg({ client_id: '../x' }), goodSender, ERRORS.badMessage],
];
for (const [name, msg, sender, code] of rejects) {
    test(`rejects before any network call: ${name} -> ${code}`, async () => {
        const { p, storage, fetch } = setup();
        assert.deepEqual(await p.handleExternal(msg, sender), { ok: false, error: code });
        assert.equal(fetch.calls.length, 0);
        assert.equal(storage.data[KEYS.token], undefined);
    });
}

test('no stored install id -> not_ready', async () => {
    const { p, fetch } = setup({ storage: fakeStorage() });
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: false, error: ERRORS.notReady });
    assert.equal(fetch.calls.length, 0);
});

const confirmFails = [
    ['/me external_id mismatch', { status: 200, body: meBody({ external_id: 'C'.repeat(43) }) }, ERRORS.meMismatch],
    ['/me client_id mismatch', { status: 200, body: meBody({ client_id: 'other' }) }, ERRORS.meMismatch],
    ['/me kind is not plugin', { status: 200, body: meBody({ kind: 'box' }) }, ERRORS.meMismatch],
    ['/me 401', { status: 401, body: { detail: 'Unauthorized' } }, ERRORS.tokenRejected],
    ['/me 500', { status: 500, body: {} }, ERRORS.confirmFailed],
    ['/me not json', { status: 200 }, ERRORS.confirmFailed],
    ['/me network error', new TypeError('Failed to fetch'), ERRORS.confirmFailed],
];
for (const [name, resp, code] of confirmFails) {
    test(`confirm step: ${name} -> ${code}, nothing stored`, async () => {
        const { p, storage } = setup({ fetch: fakeFetch(resp) });
        assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: false, error: code });
        assert.equal(storage.data[KEYS.token], undefined);
        assert.equal(storage.data[KEYS.clientId], undefined);
    });
}

test('a refused pairing from the app drops the old token (the page rotated it); no revoked flag', async () => {
    const OLD = 'tmc_' + 'o'.repeat(43);
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: OLD, [KEYS.clientId]: CLIENT });
    const { p } = setup({ storage, fetch: fakeFetch({ status: 401, body: {} }) });
    assert.equal((await p.handleExternal(goodMsg(), goodSender)).error, ERRORS.tokenRejected);
    assert.equal(storage.data[KEYS.token], undefined);
    assert.equal(storage.data[KEYS.clientId], undefined);
    assert.equal(storage.data[KEYS.revoked], undefined);
    assert.equal(storage.data[KEYS.installId], INSTALL);
});

test('a message not proven to come from the app for this install leaves the existing pairing alone', async () => {
    const OLD = 'tmc_' + 'o'.repeat(43);
    for (const [msg, sender] of [[goodMsg(), { origin: 'https://evil.invalid' }], [goodMsg({ external_id: 'B'.repeat(43) }), goodSender], [goodMsg({ v: 2 }), goodSender]]) {
        const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: OLD, [KEYS.clientId]: CLIENT });
        const { p } = setup({ storage });
        assert.equal((await p.handleExternal(msg, sender)).ok, false);
        assert.equal(storage.data[KEYS.token], OLD);
    }
});

test('onMessageExternal listener: returns true synchronously, answers {ok: true} later via sendResponse', async () => {
    const { p } = setup();
    const replies = [];
    let resolveSent; const sent = new Promise(r => { resolveSent = r; });
    const ret = externalListener(p)(goodMsg(), goodSender, r => { replies.push(r); resolveSent(); });
    assert.equal(ret, true);
    assert.equal(replies.length, 0, 'not answered synchronously');
    await sent;
    assert.deepEqual(replies, [{ ok: true }]);
});

test('onMessageExternal listener: an unexpected error answers {ok: false, error: "internal"}', async () => {
    const boom = { handleExternal: async () => { throw new Error('storage exploded'); } };
    const reply = await new Promise(resolve => { assert.equal(externalListener(boom)(goodMsg(), goodSender, resolve), true); });
    assert.deepEqual(reply, { ok: false, error: 'internal' });
});

test('duplicate message with the already-stored token is success, without another /me call (page resend)', async () => {
    const { p, fetch } = setup();
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: true });
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: true });
    assert.equal(fetch.calls.length, 1);
});

test('a duplicate is still checked: wrong origin or install id is refused even for the stored token', async () => {
    const { p } = setup();
    await p.handleExternal(goodMsg(), goodSender);
    assert.equal((await p.handleExternal(goodMsg(), { origin: 'https://evil.invalid' })).error, ERRORS.badOrigin);
    assert.equal((await p.handleExternal(goodMsg({ external_id: 'B'.repeat(43) }), goodSender)).error, ERRORS.installMismatch);
});

test('a hanging /me answers confirm_failed within the timeout, aborts the fetch, stores nothing', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL });
    let aborted = false;
    const hang = async (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
    const p = createPairing({ appOrigin: ORIGIN, extensionId: EXT_ID, storage, fetch: hang, getRandomValues: a => a, log, confirmTimeoutMs: 30 });
    const t0 = Date.now();
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: false, error: ERRORS.confirmFailed });
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(aborted);
    assert.equal(storage.data[KEYS.token], undefined);
});

test('/me sends headers then stalls the body: confirm_failed within the limit, nothing stored', async () => {
    const { p, storage } = setup({ fetch: fakeFetch({ status: 200, body: HANG }), confirmTimeoutMs: 30 });
    const t0 = Date.now();
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: false, error: ERRORS.confirmFailed });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(storage.data[KEYS.token], undefined);
});

test('status: a hanging app call (no headers) returns unverified within the limit and keeps the pairing', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p } = setup({ storage, fetch: hangForever, apiTimeoutMs: 30 });
    const t0 = Date.now();
    assert.deepEqual(await p.status(), { paired: true, verified: false, clientId: CLIENT });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(storage.data[KEYS.token], TOKEN);
});

test('apiFetch: a stalled body is cut off by the same limit', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p } = setup({ storage, fetch: fakeFetch({ status: 200, body: HANG }), apiTimeoutMs: 30 });
    await assert.rejects(p.apiFetch('/api/client/me'), /timeout/);
    assert.equal(storage.data[KEYS.token], TOKEN);
});

test('a late 401 for an old token does not wipe a token paired in the meantime (compare-and-clear)', async () => {
    const NEW = 'tmc_' + 'n'.repeat(43);
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const fetch = fakeFetch((url, init) => {
        // while the old token's call is in flight, a new pairing lands
        if (init.headers.Authorization === `Bearer ${TOKEN}`) { storage.data[KEYS.token] = NEW; return { status: 401, body: {} }; }
        return { status: 200, body: meBody() };
    });
    const { p } = setup({ storage, fetch });
    const r = await p.apiFetch('/api/client/me');
    assert.equal(r.status, 401);
    assert.equal(r.cleared, false);
    assert.equal(storage.data[KEYS.token], NEW);
    assert.equal(storage.data[KEYS.revoked], undefined);
    // status() in the same race reports on the new token
    storage.data[KEYS.token] = TOKEN;
    assert.deepEqual(await p.status(), { paired: true, verified: true, clientId: CLIENT });
    assert.equal(storage.data[KEYS.token], NEW);
});

test('default api timeout leaves room inside the page\'s 20 s budget', async () => {
    const { API_TIMEOUT_MS } = await import('./pairing.js');
    assert.ok(API_TIMEOUT_MS > 0 && API_TIMEOUT_MS <= 15000);
});

test('default confirm timeout leaves room inside the page\'s 20 s budget', async () => {
    const { CONFIRM_TIMEOUT_MS } = await import('./pairing.js');
    assert.ok(CONFIRM_TIMEOUT_MS > 0 && CONFIRM_TIMEOUT_MS <= 15000);
});

test('replies are exactly {ok: true} or {ok: false, error: <short non-empty id>}', async () => {
    const codes = Object.values(ERRORS);
    for (const c of codes) { assert.match(c, /^[a-z_]{1,32}$/); }
    const { p } = setup();
    const r = await p.handleExternal(goodMsg(), goodSender);
    assert.deepEqual(Object.keys(r), ['ok']); assert.equal(r.ok, true);
    const f = await p.handleExternal(goodMsg({ v: 9 }), goodSender);
    assert.deepEqual(Object.keys(f).sort(), ['error', 'ok']); assert.equal(f.ok, false); assert.ok(codes.includes(f.error));
});

test('status: unpaired without a token, no network call', async () => {
    const { p, fetch } = setup();
    assert.deepEqual(await p.status(), { paired: false });
    assert.equal(fetch.calls.length, 0);
});

test('status: paired and confirmed', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p, fetch } = setup({ storage });
    assert.deepEqual(await p.status(), { paired: true, verified: true, clientId: CLIENT });
    assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('any 401 from the app clears the token (password reset revokes it); install id stays', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p } = setup({ storage, fetch: fakeFetch({ status: 401, body: { detail: 'Unauthorized' } }) });
    assert.deepEqual(await p.status(), { paired: false, revoked: true });
    assert.equal(storage.data[KEYS.token], undefined);
    assert.equal(storage.data[KEYS.clientId], undefined);
    assert.equal(storage.data[KEYS.installId], INSTALL);
    assert.equal(storage.data[KEYS.revoked], true);
    // the pairing screen keeps saying why until the user pairs again
    assert.deepEqual(await p.status(), { paired: false, revoked: true });
});

test('a successful pair clears the revoked flag; so does unpair', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.revoked]: true });
    const { p } = setup({ storage });
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: true });
    assert.equal(storage.data[KEYS.revoked], undefined);
    storage.data[KEYS.revoked] = true;
    await p.unpair();
    assert.equal(storage.data[KEYS.revoked], undefined);
});

test('apiFetch: a 401 on any client call clears the token', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p } = setup({ storage, fetch: fakeFetch({ status: 401, body: {} }) });
    const r = await p.apiFetch('/api/client/anything');
    assert.equal(r.status, 401);
    assert.equal(storage.data[KEYS.token], undefined);
});

test('apiFetch: refuses paths outside the app origin and fails loudly without a token', async () => {
    const { p } = setup();
    await assert.rejects(p.apiFetch('https://elsewhere.invalid/x'), /path/);
    await assert.rejects(p.apiFetch('//elsewhere.invalid/x'), /path/);
    await assert.rejects(p.apiFetch('/api/client/me'), /not paired/);
});

test('status: network error keeps the pairing (unverified), does not clear', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p } = setup({ storage, fetch: fakeFetch(new TypeError('offline')) });
    assert.deepEqual(await p.status(), { paired: true, verified: false, clientId: CLIENT });
    assert.equal(storage.data[KEYS.token], TOKEN);
});

test('unpair clears local token state and keeps the install id', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p, fetch } = setup({ storage });
    await p.unpair();
    assert.deepEqual(Object.keys(storage.data), [KEYS.installId]);
    assert.equal(fetch.calls.length, 0, 'server-side revoke is done from the app, not here');
});

test('the token never appears in any log line or reply', async () => {
    // Exercise every path once more with a distinctive token, then scan everything that was logged.
    const T = 'tmc_' + 'SECRETsecret0123456789_-SECRETsecret0123456';
    assert.match(T, /^tmc_[A-Za-z0-9_-]{43}$/);
    const replies = [];
    const variants = [
        { status: 200, body: meBody() }, { status: 401, body: {} }, { status: 500, body: { echo: 'x' } },
        { status: 200 }, new TypeError('offline'), { status: 200, body: meBody({ external_id: 'x' }) },
    ];
    for (const v of variants) {
        const storage = fakeStorage({ [KEYS.installId]: INSTALL });
        const { p } = setup({ storage, fetch: fakeFetch(v) });
        replies.push(await p.handleExternal(goodMsg({ token: T }), goodSender));
        replies.push(await p.handleExternal(goodMsg({ token: T }), { origin: 'https://evil.invalid' }));
        replies.push(await p.handleExternal(goodMsg({ token: T, external_id: 'nope' }), goodSender));
        storage.data[KEYS.token] = T; storage.data[KEYS.clientId] = CLIENT;
        replies.push(await p.status());
    }
    assert.ok(logged.length > 0, 'the module logs its outcomes');
    for (const line of logged) { assert.ok(!line.includes(T) && !line.includes(T.slice(4)), `token leaked into a log line: ${line}`); }
    for (const r of replies) { assert.ok(!JSON.stringify(r).includes(T.slice(4)), `token leaked into a reply: ${JSON.stringify(r)}`); }
});

// ---------------------------------------------------------------- the app handoff (W-A12, W-P4; "Settings" by default since E2E-02)

const CODE = 'Hc0DE-handoff_' + 'q'.repeat(29);   // 43 URL-safe characters
const pairedStorage = () => fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
function tabSpy(fail) {
    const opened = [];
    const fn = async url => { if (fail) { throw new Error(`cannot open ${url}`); } opened.push(url); };
    fn.opened = opened;
    return fn;
}

test('handoff: paired -> POST /api/access/handoff (Bearer, no body, no cookies, no redirects), then opens /open?code=&next=/settings', async () => {
    assert.match(CODE, HANDOFF_CODE_RE);
    const storage = pairedStorage();
    const { p, fetch } = setup({ storage, fetch: fakeFetch({ status: 201, body: { code: CODE, expires_in: 60 } }) });
    const tab = tabSpy();
    assert.deepEqual(await p.openAccount(tab), { ok: true, opened: 'app' });
    assert.equal(fetch.calls.length, 1);
    const { url, init } = fetch.calls[0];
    assert.equal(url, `${ORIGIN}/api/access/handoff`);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, undefined, 'no body');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal, 'bounded by the api timeout');
    assert.deepEqual(tab.opened, [`${ORIGIN}/open?code=${CODE}&next=/settings`]);
    assert.equal(storage.data[KEYS.token], TOKEN, 'the pairing is kept');
    assert.ok(!JSON.stringify(storage.data).includes(CODE), 'the code is never stored');
});

test('handoff: unpaired -> opens /login, no network call', async () => {
    const { p, fetch } = setup();
    const tab = tabSpy();
    assert.deepEqual(await p.openAccount(tab), { ok: true, opened: 'login' });
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(tab.opened, [`${ORIGIN}/login`]);
});

test('handoff: 401 -> compare-and-clear drops the token, sets revoked, opens nothing, caller shows pairing', async () => {
    const storage = pairedStorage();
    const { p } = setup({ storage, fetch: fakeFetch({ status: 401, body: { detail: 'Unauthorized' } }) });
    const tab = tabSpy();
    assert.deepEqual(await p.openAccount(tab), { ok: true, opened: 'pairing' });
    assert.deepEqual(tab.opened, []);
    assert.equal(storage.data[KEYS.token], undefined);
    assert.equal(storage.data[KEYS.revoked], true);
    assert.equal(storage.data[KEYS.installId], INSTALL);
});

test('handoff: a late 401 for an old token keeps a token paired in the meantime', async () => {
    const NEW = 'tmc_' + 'n'.repeat(43);
    const storage = pairedStorage();
    const fetch = fakeFetch(() => { storage.data[KEYS.token] = NEW; return { status: 401, body: {} }; });
    const { p } = setup({ storage, fetch });
    const tab = tabSpy();
    assert.deepEqual(await p.openAccount(tab), { ok: false, error: ACCOUNT_ERRORS.unavailable });
    assert.equal(storage.data[KEYS.token], NEW);
    assert.deepEqual(tab.opened, []);
});

test('handoff: 429 -> rate_limited with Retry-After seconds, nothing opened, pairing kept', async () => {
    const storage = pairedStorage();
    const { p } = setup({ storage, fetch: fakeFetch({ status: 429, headers: { 'Retry-After': '1800' }, body: { error: 'rate_limited' } }) });
    const tab = tabSpy();
    assert.deepEqual(await p.openAccount(tab), { ok: false, error: ACCOUNT_ERRORS.rateLimited, retryAfter: 1800 });
    assert.deepEqual(tab.opened, []);
    assert.equal(storage.data[KEYS.token], TOKEN);
});

test('handoff: 429 without a usable Retry-After -> rate_limited without retryAfter', async () => {
    for (const headers of [undefined, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, { 'Retry-After': '-5' }]) {
        const { p } = setup({ storage: pairedStorage(), fetch: fakeFetch({ status: 429, headers, body: {} }) });
        assert.deepEqual(await p.openAccount(tabSpy()), { ok: false, error: ACCOUNT_ERRORS.rateLimited });
    }
});

const handoffBad = [
    ['500', { status: 500, body: {} }],
    ['200 instead of 201', { status: 200, body: { code: CODE, expires_in: 60 } }],
    ['201 not json', { status: 201 }],
    ['201 without a code', { status: 201, body: { expires_in: 60 } }],
    ['201 code too short', { status: 201, body: { code: CODE.slice(1), expires_in: 60 } }],
    ['201 code with a query injection', { status: 201, body: { code: CODE.slice(0, 30) + '&next=//evil', expires_in: 60 } }],
    ['201 code not a string', { status: 201, body: { code: 12345, expires_in: 60 } }],
    ['network error', new TypeError('Failed to fetch')],
];
for (const [name, resp] of handoffBad) {
    test(`handoff: ${name} -> unavailable, nothing opened, pairing kept`, async () => {
        const storage = pairedStorage();
        const { p } = setup({ storage, fetch: fakeFetch(resp) });
        const tab = tabSpy();
        assert.deepEqual(await p.openAccount(tab), { ok: false, error: ACCOUNT_ERRORS.unavailable });
        assert.deepEqual(tab.opened, []);
        assert.equal(storage.data[KEYS.token], TOKEN);
    });
}

test('handoff: a hanging or stalled handoff answers unavailable within the limit (headers and body)', async () => {
    for (const fetch of [hangForever, fakeFetch({ status: 201, body: HANG })]) {
        const { p } = setup({ storage: pairedStorage(), fetch, apiTimeoutMs: 30 });
        const tab = tabSpy();
        const t0 = Date.now();
        assert.deepEqual(await p.openAccount(tab), { ok: false, error: ACCOUNT_ERRORS.unavailable });
        assert.ok(Date.now() - t0 < 1000);
        assert.deepEqual(tab.opened, []);
    }
});

test('handoff: the default limit opens the code well inside its 60 s life', async () => {
    const { API_TIMEOUT_MS } = await import('./pairing.js');
    assert.ok(API_TIMEOUT_MS <= 15000, 'mint + open happens within the code\'s 60 s');
});

test('handoff: the browser refusing the tab -> open_failed, and the error does not carry the URL', async () => {
    const { p } = setup({ storage: pairedStorage(), fetch: fakeFetch({ status: 201, body: { code: CODE, expires_in: 60 } }) });
    const r = await p.openAccount(tabSpy(true));
    assert.deepEqual(r, { ok: false, error: ACCOUNT_ERRORS.openFailed });
});

test('handoff: openTab is required', async () => {
    const { p } = setup({ storage: pairedStorage() });
    await assert.rejects(p.openAccount(), /openTab/);
});

test('handoff: the handoff code never appears in a log line, a reply or storage', async () => {
    const C = 'CODEsecret0123456789_-CODEsecret0123456789x';
    assert.match(C, HANDOFF_CODE_RE);
    const replies = [];
    const stores = [];
    const variants = [
        { status: 201, body: { code: C, expires_in: 60 } }, { status: 200, body: { code: C } },
        { status: 201, body: { code: C + 'x' } }, { status: 500, body: { code: C } }, { status: 429, body: { code: C } },
        { status: 401, body: { code: C } },
    ];
    for (const v of variants) {
        for (const fail of [false, true]) {
            const storage = pairedStorage();
            const { p } = setup({ storage, fetch: fakeFetch(v) });
            replies.push(await p.openAccount(tabSpy(fail)));
            stores.push(storage.data);
        }
    }
    assert.ok(logged.length > 0);
    for (const line of logged) { assert.ok(!line.includes(C.slice(0, 20)), `code leaked into a log line: ${line}`); }
    for (const r of replies) { assert.ok(!JSON.stringify(r).includes(C.slice(0, 20)), `code leaked into a reply: ${JSON.stringify(r)}`); }
    for (const s of stores) { assert.ok(!JSON.stringify(s).includes(C.slice(0, 20)), 'code stored'); }
    for (const c of Object.values(ACCOUNT_ERRORS)) { assert.match(c, /^[a-z_]{1,32}$/); }
});

test('handoff: a concurrent status check that gets the 401 first still ends on pairing, not /login or an error', async () => {
    const storage = pairedStorage();
    let releaseHandoff;
    const handoffGate = new Promise(r => { releaseHandoff = r; });
    const fetch = async (url, init) => {
        if (url.endsWith('/api/access/handoff')) { await handoffGate; }
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ detail: 'Unauthorized' }) };
    };
    const { p } = setup({ storage, fetch });
    const tab = tabSpy();
    const acct = p.openAccount(tab);
    const st = await p.status();               // /me 401 lands first and clears the token
    assert.deepEqual(st, { paired: false, revoked: true });
    releaseHandoff();
    assert.deepEqual(await acct, { ok: true, opened: 'pairing' });
    assert.deepEqual(tab.opened, []);
    assert.equal(storage.data[KEYS.token], undefined);
});

// --- W-P6: the popup's handoff pages and "pairing in progress" -------------------------------------------------

test('popup handoff: each page key opens /open with its fixed next; Open your feed lands on /feed (W-T10); no /dashboard hop is left', async () => {
    assert.deepEqual({ ...HANDOFF_PAGES }, { feed: '/feed', wallet: '/wallet/topup', reload: '/wallet/topup', settings: '/settings' });
    for (const [page, next] of Object.entries(HANDOFF_PAGES)) {
        const { p } = setup({ storage: pairedStorage(), fetch: fakeFetch({ status: 201, body: { code: CODE, expires_in: 60 } }) });
        const tab = tabSpy();
        assert.deepEqual(await p.openAccount(tab, page), { ok: true, opened: 'app' });
        assert.deepEqual(tab.opened, [`${ORIGIN}/open?code=${CODE}&next=${next}`], page);
    }
});

test('popup handoff: an unknown page key (or a path, or an inherited name) fails loudly before any network call', async () => {
    for (const page of ['/wallet', 'https://evil.example.invalid/', 'constructor', 'toString', '', 7, null]) {
        const { p, fetch } = setup({ storage: pairedStorage(), fetch: fakeFetch({ status: 201, body: { code: CODE } }) });
        const tab = tabSpy();
        await assert.rejects(p.openAccount(tab, page), /unknown page/, String(page));
        assert.equal(fetch.calls.length, 0);
        assert.deepEqual(tab.opened, []);
    }
});

test('pairing in progress: marked, true while younger than the TTL, false after it or once paired', async () => {
    let t = 1_000_000;
    const storage = fakeStorage({ [KEYS.installId]: INSTALL });
    const p = createPairing({ appOrigin: ORIGIN, extensionId: EXT_ID, storage, fetch: fakeFetch({ status: 200, body: meBody() }),
        getRandomValues: a => a, log, now: () => t });
    assert.equal(await p.pairingInProgress(), false);
    await p.markPairingStarted();
    assert.equal(await p.pairingInProgress(), true);
    t += PAIRING_TTL_MS - 1;
    assert.equal(await p.pairingInProgress(), true);
    t += 1;
    assert.equal(await p.pairingInProgress(), false, 'an abandoned pairing goes back to Sign in');
    await p.markPairingStarted();
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: true });
    assert.equal(storage.data[KEYS.pairingStarted], undefined, 'a finished pairing clears the mark');
    assert.equal(await p.pairingInProgress(), false);
});

test('pairing in progress: unpair and a clock that went backwards both end it; garbage is ignored', async () => {
    let t = 5_000_000;
    const storage = pairedStorage();
    const p = createPairing({ appOrigin: ORIGIN, extensionId: EXT_ID, storage, fetch: fakeFetch({ status: 200, body: meBody() }),
        getRandomValues: a => a, log, now: () => t });
    await p.markPairingStarted();
    assert.equal(await p.pairingInProgress(), false, 'already paired');
    await p.unpair();
    assert.equal(storage.data[KEYS.pairingStarted], undefined);
    await storage.set({ [KEYS.pairingStarted]: t + 60_000 });
    assert.equal(await p.pairingInProgress(), false, 'a start in the future is not trusted');
    await storage.set({ [KEYS.pairingStarted]: 'soon' });
    assert.equal(await p.pairingInProgress(), false);
});

test('signup url: the reader sign-up, returning to this install\'s pairing page (next is one encoded fragment value)', async () => {
    const { p, fetch } = setup();
    const url = await p.signupUrl();
    assert.equal(url, `${ORIGIN}/signup/reader#next=${encodeURIComponent(`/pair#install=${INSTALL}&ext=${EXT_ID}`)}`);
    // The app reads next with URLSearchParams over the fragment: &ext= must not split off.
    assert.equal(new URLSearchParams(new URL(url).hash.slice(1)).get('next'), `/pair#install=${INSTALL}&ext=${EXT_ID}`);
    assert.equal(fetch.calls.length, 0, 'signed out, building it calls nothing');
});

test('review !19 retry 2: /me without a user_id (missing or empty) refuses the pairing (me_mismatch), nothing stored', async () => {
    for ( const user_id of [ undefined, '', 7 ] ) {
        const body = meBody(); if ( user_id === undefined ) { delete body.user_id; } else { body.user_id = user_id; }
        const { p, storage } = setup({ fetch: fakeFetch({ status: 200, body }) });
        assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: false, error: ERRORS.meMismatch }, String(user_id));
        assert.equal(storage.data[KEYS.token], undefined);
        assert.equal(storage.data[KEYS.account], undefined);
    }
});

test('review !19 retry 2: status() stores the account of a token paired by an older build; accountId() learns it once', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.token]: TOKEN, [KEYS.clientId]: CLIENT });
    const { p, fetch } = setup({ storage });
    assert.equal((await p.status()).verified, true);
    assert.equal(storage.data[KEYS.account], 'u');
    assert.equal(await p.accountId(), 'u');
    assert.equal(fetch.calls.length, 1, 'stored: no second /me');
    delete storage.data[KEYS.account];
    assert.equal(await p.accountId(), 'u');
    assert.equal(fetch.calls.length, 2);
    await p.unpair();
    assert.equal(await p.accountId(), null);
});

test('pairing stores the reader\'s account (me.user_id) with the token; clearing the token clears it', async () => {
    const { p, storage } = setup();
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: true });
    assert.equal(storage.data[KEYS.account], 'u');
    await p.unpair();
    assert.equal(storage.data[KEYS.account], undefined);
});

test('pairing turns the tip jar on: a successful pairing clears the off switch; a refused one leaves it', async () => {
    const storage = fakeStorage({ [KEYS.installId]: INSTALL, [KEYS.tipJarOff]: true });
    const { p } = setup({ storage, fetch: fakeFetch({ status: 401 }) });
    assert.deepEqual(await p.handleExternal(goodMsg(), goodSender), { ok: false, error: ERRORS.tokenRejected });
    assert.equal(storage.data[KEYS.tipJarOff], true);
    const { p: p2 } = setup({ storage });
    assert.deepEqual(await p2.handleExternal(goodMsg(), goodSender), { ok: true });
    assert.equal(storage.data[KEYS.tipJarOff], undefined);
    assert.equal(KEYS.tipJarOff, 'thankmu.prompts.off', 'the popup switch\'s key, unchanged (tipjar.js TIPJAR_KEYS.promptsOff)');
});
