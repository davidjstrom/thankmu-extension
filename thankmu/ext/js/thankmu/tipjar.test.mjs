// Tests for the ad-slot tip jar logic (W-T1 part A). Pure: storage, fetch and the digest are injected.
// Run: node --test thankmu/ext/js/thankmu/tipjar.test.mjs  (tests/run.sh and scripts/build_chrome.sh run every *.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPairing, KEYS } from './pairing.js';
import {
    createTipJar, normalizeDomain, candidateDomains, propertyStatus, pageOf, pathHash, cleanText,
    TIPJAR_KEYS, AMOUNTS_CENTS, DISMISS_MS, PARTNERS_PATH, PARTNERS_REFRESH_MS, PARTNERS_STALE_MAX_MS,
    TITLE_MAX, AUTHOR_MAX, contentListener, PENDING_TTL_MS, GIVE_DEADLINE_MS,
} from './tipjar.js';

const ORIGIN = 'https://app.example.invalid';
const TOKEN = 'tmc_' + 'Zx9-_'.repeat(8) + 'Zx9';
const KEY = '0b6c3f4e-8d1a-4c2b-9e7f-112233445566';
const digest = (alg, data) => webcrypto.subtle.digest(alg, data);

function fakeStorage(init = {}) {
    const data = structuredClone(init);
    return {
        data,
        async get(keys) {
            const ks = keys === null ? Object.keys(data) : [].concat(keys);
            const out = {};
            for (const k of ks) { if (k in data) { out[k] = structuredClone(data[k]); } }
            return out;
        },
        async set(obj) { Object.assign(data, structuredClone(obj)); },
        async remove(keys) { for (const k of [].concat(keys)) { delete data[k]; } },
    };
}

const PARTNERS = {
    entries: [
        { domain: 'blocked.example', status: 'blocked' },
        { domain: 'oaklandside.example', status: 'partner' },
        { domain: 'blog.mixed.example', status: 'partner' },
        { domain: 'mixed.example', status: 'blocked' },
    ],
    truncated: false,
};

// Routes by path; records every call so the privacy tests can read exactly what left the browser.
function fakeApp(routes = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url, init });
        const path = url.slice(ORIGIN.length);
        const route = routes[`${init.method || 'GET'} ${path}`] ?? (path === PARTNERS_PATH ? { status: 200, body: PARTNERS, headers: { ETag: '"v1"' } } : undefined);
        const r = await (typeof route === 'function' ? route(url, init) : route);
        if ( r === undefined ) { throw new Error(`unexpected call ${init.method || 'GET'} ${url}`); }
        if ( r instanceof Error ) { throw r; }
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            headers: { get: k => r.headers?.[k] ?? null },
            async json() { if ( r.body === undefined ) { throw new SyntaxError('no json'); } return structuredClone(r.body); },
        };
    };
    fn.calls = calls;
    return fn;
}

function setup({ routes, store = {}, paired = true, now = 1_800_000_000_000, keys, jarOpts = {} } = {}) {
    const storage = fakeStorage({ ...(paired ? { [KEYS.token]: TOKEN, [KEYS.clientId]: 'c1', [KEYS.account]: 'reader-1' } : {}), ...store });
    const fetch = fakeApp(routes);
    const logs = [];
    const log = (...a) => logs.push(a.join(' '));
    const pairing = createPairing({ appOrigin: ORIGIN, extensionId: 'x', storage, fetch, getRandomValues: a => a, log });
    const clock = { t: now };
    const session = fakeStorage();
    // The worker mints tip/pledge keys; tests see KEY unless they pass their own sequence.
    const randomKey = keys ? ( ) => keys.shift() : ( ) => KEY;
    const jar = createTipJar({ appOrigin: ORIGIN, storage, session, fetch, apiFetch: pairing.apiFetch, accountId: pairing.accountId, digest, randomKey, now: () => clock.t, log, ...jarOpts });
    return { jar, storage, session, fetch, logs, clock };
}

const PAGE = 'https://www.oaklandside.example/news/story?utm_source=x&id=secret#comments';
const UNKNOWN = 'https://news.unknown.example/2026/10/30/a-story?ref=feed';
const META = { title: 'Council\nvotes\u0000 on budget', author: 'Jane Doe' };

// --- pure helpers ---------------------------------------------------------------------------------

test('normalizeDomain matches the app (lowercase, no trailing dot, leading www. stripped, IPs and single labels refused)', () => {
    assert.equal(normalizeDomain('WWW.Example.COM.'), 'example.com');
    assert.equal(normalizeDomain('www.www.example.com'), 'example.com');
    assert.equal(normalizeDomain('www.com'), 'www.com');
    assert.equal(normalizeDomain('news.example.co.uk'), 'news.example.co.uk');
    for ( const bad of [ '', 'localhost', '127.0.0.1', '10.1', '[::1]', 'example.123', 'ex ample.com', 'faß.de', '-a.com' ] ) {
        assert.equal(normalizeDomain(bad), null, bad);
    }
});

test('candidateDomains walks from the host to the registered parent, never a bare TLD', () => {
    assert.deepEqual(candidateDomains('a.b.example.com'), [ 'a.b.example.com', 'b.example.com', 'example.com' ]);
    assert.deepEqual(candidateDomains('www.example.com'), [ 'example.com' ]);
    assert.deepEqual(candidateDomains('localhost'), []);
});

test('propertyStatus: the longest registered match wins, absent is unknown', () => {
    const e = PARTNERS.entries;
    assert.equal(propertyStatus(e, 'oaklandside.example'), 'partner');
    assert.equal(propertyStatus(e, 'www.oaklandside.example'), 'partner');
    assert.equal(propertyStatus(e, 'sports.blocked.example'), 'blocked');   // a subdomain of a blocked property
    assert.equal(propertyStatus(e, 'blog.mixed.example'), 'partner');       // separately registered tenant
    assert.equal(propertyStatus(e, 'news.mixed.example'), 'blocked');
    assert.equal(propertyStatus(e, 'unknown.example'), 'unknown');
});

test('pageOf: http(s) only; the hash input is scheme + // + lowercase host + path, no query, no fragment, no port', () => {
    assert.deepEqual(pageOf('https://WWW.Oaklandside.example:8443/News/Story?x=1#y'),
        { domain: 'oaklandside.example', hashInput: 'https://www.oaklandside.example/News/Story' });
    assert.deepEqual(pageOf('http://example.com'), { domain: 'example.com', hashInput: 'http://example.com/' });
    for ( const bad of [ 'chrome://settings', 'file:///etc/passwd', 'https://127.0.0.1/', 'https://localhost/', 'not a url', undefined ] ) {
        assert.equal(pageOf(bad), null, String(bad));
    }
});

test('pathHash is lowercase hex SHA-256 of the hash input (known answer)', async () => {
    assert.equal(await pathHash('https://example.com/news/story', digest),
        '906074d8fb3ef840e7804b45f5be9eaadc6f2908310da75e8d5d62855c3edf6d');
});

test('cleanText caps by code point, never splitting an emoji (the app counts code points)', () => {
    const t = 'x'.repeat(TITLE_MAX - 1) + '😀😀';
    const out = cleanText(t, TITLE_MAX);
    assert.equal(Array.from(out).length, TITLE_MAX);
    assert.ok(out.endsWith('😀'), 'the last emoji is whole');
    assert.ok(!/[\ud800-\udbff]$/.test(out), 'no lone high surrogate');
});

test('cleanText strips control characters, collapses spaces, caps length, and drops empties', () => {
    assert.equal(cleanText('  Council\nvotes\u0000 on\u007f budget ', TITLE_MAX), 'Council votes on budget');
    assert.equal(cleanText('x'.repeat(TITLE_MAX + 50), TITLE_MAX).length, TITLE_MAX);
    assert.equal(cleanText('   ', AUTHOR_MAX), undefined);
    assert.equal(cleanText(42, AUTHOR_MAX), undefined);
    assert.equal(cleanText('https://example.com/people/jane', AUTHOR_MAX, { noUrl: true }), undefined);
});

// --- check: when a prompt may show -----------------------------------------------------------------

test('check: a partner page shows the tip prompt; an unlisted one the pledge prompt', async () => {
    const { jar } = setup();
    assert.deepEqual(await jar.check(PAGE), { show: true, domain: 'oaklandside.example', mode: 'tip', paired: true });
    assert.deepEqual(await jar.check(UNKNOWN), { show: true, domain: 'news.unknown.example', mode: 'pledge', paired: true });
});

test('check: blocked publishers (ADR-014) get no prompt, subdomains included', async () => {
    const { jar } = setup();
    assert.equal((await jar.check('https://blocked.example/a')).show, false);
    assert.equal((await jar.check('https://www.sports.blocked.example/a')).show, false);
});

test('check: signed out there is no card, and no request at all (not even the partner list)', async () => {
    const { jar, fetch } = setup({ paired: false });
    assert.deepEqual(await jar.check(PAGE), { show: false, reason: 'signed_out' });
    assert.equal(fetch.calls.length, 0);
});

test('check: fails closed when the partner list has never been fetched', async () => {
    const { jar } = setup({ routes: { [`GET ${PARTNERS_PATH}`]: new TypeError('offline') } });
    assert.deepEqual(await jar.check(UNKNOWN), { show: false, reason: 'no_partner_list' });
    const r2 = setup({ routes: { [`GET ${PARTNERS_PATH}`]: { status: 503 } } });
    assert.equal((await r2.jar.check(UNKNOWN)).show, false);
    const r3 = setup({ routes: { [`GET ${PARTNERS_PATH}`]: { status: 200, body: { entries: 'nope' } } } });
    assert.equal((await r3.jar.check(UNKNOWN)).show, false);
});

test('check: the global off switch and the app itself mean no prompt', async () => {
    const { jar } = setup();
    await jar.setPromptsOn(false);
    assert.deepEqual(await jar.check(PAGE), { show: false, reason: 'off' });
    await jar.setPromptsOn(true);
    assert.equal((await jar.check(PAGE)).show, true);
    assert.deepEqual(await jar.check(`${ORIGIN}/dashboard`), { show: false, reason: 'app' });
    assert.deepEqual(await jar.check('chrome://newtab/'), { show: false, reason: 'not_a_page' });
});

test('dismiss hides the prompt on that domain (any subdomain spelling) for a day, then it returns; undo restores it', async () => {
    const { jar, clock } = setup();
    assert.equal(await jar.dismiss(PAGE), 'oaklandside.example');
    assert.deepEqual(await jar.check('https://oaklandside.example/other'), { show: false, reason: 'dismissed' });
    assert.equal((await jar.check(UNKNOWN)).show, true, 'another domain is unaffected');
    clock.t += DISMISS_MS - 1;
    assert.equal((await jar.check(PAGE)).show, false);
    clock.t += 2;
    assert.equal((await jar.check(PAGE)).show, true);
    await jar.dismiss(PAGE);
    await jar.undismiss(PAGE);
    assert.equal((await jar.check(PAGE)).show, true);
});

test('dismissals are pruned when they expire (storage does not grow with browsing)', async () => {
    const { jar, clock, storage } = setup();
    await jar.dismiss(PAGE);
    clock.t += DISMISS_MS + 1;
    await jar.dismiss(UNKNOWN);
    assert.deepEqual(Object.keys(storage.data[TIPJAR_KEYS.dismissed]), [ 'news.unknown.example' ]);
});

test('promptsState reports the switch and whether the active tab\'s domain is hidden today', async () => {
    const { jar } = setup();
    assert.deepEqual(await jar.promptsState(PAGE), { on: true, hidden: null });
    await jar.dismiss(PAGE);
    assert.deepEqual(await jar.promptsState(PAGE), { on: true, hidden: 'oaklandside.example' });
    assert.deepEqual(await jar.promptsState(undefined), { on: true, hidden: null });
});

// --- the partner list cache -------------------------------------------------------------------------

test('partner list: cached, revalidated with If-None-Match after the refresh interval, 304 keeps the entries', async () => {
    let n = 0;
    const { jar, fetch, clock } = setup({ routes: { [`GET ${PARTNERS_PATH}`]: (url, init) => {
        n += 1;
        if ( init.headers?.['If-None-Match'] === '"v1"' ) { return { status: 304, headers: { ETag: '"v1"' } }; }
        return { status: 200, body: PARTNERS, headers: { ETag: '"v1"' } };
    } } });
    await jar.check(PAGE); await jar.check(PAGE);
    assert.equal(n, 1);
    clock.t += PARTNERS_REFRESH_MS + 1;
    assert.equal((await jar.check(PAGE)).mode, 'tip');
    assert.equal(n, 2);
    const last = fetch.calls.at(-1);
    assert.equal(last.url, ORIGIN + PARTNERS_PATH, 'no query: the list request says nothing about the page');
    assert.equal(last.init.credentials, 'omit');
    assert.equal(last.init.headers.Authorization, undefined, 'the partner list is public; no token');
});

test('partner list: a failed refresh keeps a stale list for a while, then fails closed', async () => {
    let up = true;
    const { jar, clock } = setup({ routes: { [`GET ${PARTNERS_PATH}`]: () => up ? { status: 200, body: PARTNERS, headers: { ETag: '"v1"' } } : new TypeError('offline') } });
    await jar.check(PAGE);
    up = false;
    clock.t += PARTNERS_REFRESH_MS + 1;
    assert.equal((await jar.check(PAGE)).show, true);
    clock.t += PARTNERS_STALE_MAX_MS;
    assert.deepEqual(await jar.check(PAGE), { show: false, reason: 'no_partner_list' });
});

// --- actions ------------------------------------------------------------------------------------------

test('like posts exactly {idempotency_key, domain, path_hash, title, author} to /api/likes with the token', async () => {
    const { jar, fetch } = setup({ routes: { 'POST /api/likes': { status: 201, body: { id: 'l1', property_status: 'partner', replayed: false } } } });
    assert.deepEqual(await jar.like(PAGE, META, KEY), { ok: true });
    const call = fetch.calls.find(c => c.url === ORIGIN + '/api/likes');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(call.init.body);
    assert.deepEqual(Object.keys(body).sort(), [ 'author', 'domain', 'idempotency_key', 'path_hash', 'title' ]);
    assert.equal(body.domain, 'oaklandside.example');
    assert.equal(body.path_hash, await pathHash('https://www.oaklandside.example/news/story', digest));
    assert.equal(body.title, 'Council votes on budget');
    assert.equal(body.author, 'Jane Doe');
    assert.equal(body.idempotency_key, KEY);
});

test('like omits missing title and author rather than sending blanks', async () => {
    const { jar, fetch } = setup({ routes: { 'POST /api/likes': { status: 200, body: { id: 'l1', property_status: 'unknown', replayed: true } } } });
    assert.deepEqual(await jar.like(UNKNOWN, { title: '  ' }, KEY), { ok: true, replayed: true });
    const body = JSON.parse(fetch.calls.find(c => c.url.endsWith('/api/likes')).init.body);
    assert.deepEqual(Object.keys(body).sort(), [ 'domain', 'idempotency_key', 'path_hash' ]);
});

test('a tip at a partner spends from the wallet: POST /api/ledger/spends with kind tip, context ad_slot and the story (W-T7 part B)', async () => {
    const { jar, fetch } = setup({ routes: { 'POST /api/ledger/spends': { status: 201, body: { spend_id: 's', amount_cents: 50, domain: 'oaklandside.example', replayed: false, balance: { balance_cents: 950, promotional_cents: 950 } } } } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, meta: META }), { ok: true, kind: 'tip' });
    const body = JSON.parse(fetch.calls.find(c => c.url.endsWith('/api/ledger/spends')).init.body);
    assert.deepEqual(body, { idempotency_key: KEY, kind: 'tip', domain: 'oaklandside.example', amount_cents: 50, context: 'ad_slot',
        path_hash: await pathHash('https://www.oaklandside.example/news/story', digest), title: 'Council votes on budget', author: 'Jane Doe' });
});

test('a replayed answer (200 replayed) is a definite success the card can call "went through earlier"', async () => {
    const { jar } = setup({ routes: { 'POST /api/ledger/spends': { status: 200, body: { spend_id: 's', amount_cents: 50, domain: 'oaklandside.example', replayed: true, balance: { balance_cents: 950, promotional_cents: 950 } } } } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: true, kind: 'tip', replayed: true });
});

test('a tip elsewhere is a pledge: POST /api/pledges with context ad_slot and the story fields', async () => {
    const { jar, fetch } = setup({ routes: { 'POST /api/pledges': { status: 201, body: { id: 'p', replayed: false } } } });
    assert.deepEqual(await jar.give(UNKNOWN, { mode: 'pledge', cents: 25, meta: META }), { ok: true, kind: 'pledge' });
    const body = JSON.parse(fetch.calls.find(c => c.url.endsWith('/api/pledges')).init.body);
    assert.deepEqual(Object.keys(body).sort(), [ 'amount_cents', 'author', 'context', 'domain', 'idempotency_key', 'path_hash', 'title' ]);
    assert.equal(body.context, 'ad_slot');
    assert.equal(body.amount_cents, 25);
    assert.equal(body.domain, 'news.unknown.example');
});

test('give refuses amounts outside the offered set and malformed keys without calling the app', async () => {
    const { jar, fetch } = setup();
    for ( const bad of [ 0, -50, 49, 50.5, '50', 10_000 ] ) {
        assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: bad }), { ok: false, error: 'invalid' }, String(bad));
    }
    assert.deepEqual(await jar.like(PAGE, {}, 'has spaces in it'), { ok: false, error: 'invalid' });
    assert.equal(fetch.calls.filter(c => !c.url.endsWith(PARTNERS_PATH)).length, 0);
    assert.deepEqual([ ...AMOUNTS_CENTS ], [ 25, 50, 100 ]);
});

test('give never does the other kind of action than the reader confirmed: a changed status re-renders', async () => {
    const { jar, fetch } = setup();
    assert.deepEqual(await jar.give(PAGE, { mode: 'pledge', cents: 50 }), { ok: false, error: 'changed', mode: 'tip' });
    assert.deepEqual(await jar.give(UNKNOWN, { mode: 'tip', cents: 50 }), { ok: false, error: 'changed', mode: 'pledge' });
    assert.equal(fetch.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('actions on a blocked domain never reach the app', async () => {
    const { jar, fetch } = setup();
    assert.deepEqual(await jar.like('https://blocked.example/a', {}, KEY), { ok: false, error: 'blocked' });
    assert.deepEqual(await jar.give('https://blocked.example/a', { mode: 'pledge', cents: 50 }), { ok: false, error: 'blocked' });
    assert.equal(fetch.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('error mapping per the contract (as merged)', async () => {
    const cases = [
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 402, body: { error: 'insufficient_funds' } }, { ok: false, error: 'insufficient' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 402, body: { error: 'insufficient_balance' } }, { ok: false, error: 'insufficient' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 429, body: { error: 'velocity_limited', limit: 'user_24h' } }, { ok: false, error: 'velocity' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '30' } }, { ok: false, error: 'rate_limited' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 409, body: { error: 'publisher_blocked' } }, { ok: false, error: 'blocked' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 409, body: { error: 'publisher_not_payable' } }, { ok: false, error: 'changed', mode: 'pledge' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 409, body: { error: 'not_partner' } }, { ok: false, error: 'changed', mode: 'pledge' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 409, body: { error: 'idempotency_conflict' } }, { ok: false, error: 'already_sent' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 500 }, { ok: false, error: 'uncertain' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 503 }, { ok: false, error: 'uncertain' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', new TypeError('offline'), { ok: false, error: 'uncertain' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 404, body: { detail: 'Not Found' } }, { ok: false, error: 'invalid' } ],
        [ 'POST /api/ledger/spends', PAGE, 'tip', { status: 422, body: { error: 'invalid_domain' } }, { ok: false, error: 'invalid' } ],
        [ 'POST /api/pledges', UNKNOWN, 'pledge', { status: 409, body: { error: 'use_tip' } }, { ok: false, error: 'changed', mode: 'tip' } ],
        [ 'POST /api/pledges', UNKNOWN, 'pledge', { status: 422, body: { error: 'validation', fields: [ 'amount_cents' ] } }, { ok: false, error: 'amounts_changed' } ],
        [ 'POST /api/pledges', UNKNOWN, 'pledge', { status: 422, body: { detail: [] } }, { ok: false, error: 'invalid' } ],
    ];
    for ( const [ route, url, mode, reply, want ] of cases ) {
        // use_tip / not_payable: the refreshed list says the opposite of the cached one.
        let listCalls = 0;
        const flipped = { entries: [ ...PARTNERS.entries.filter(e => e.domain !== 'oaklandside.example'), ...(mode === 'pledge' ? [ { domain: 'unknown.example', status: 'partner' } ] : []) ], truncated: false };
        const { jar } = setup({ routes: { [route]: reply, [`GET ${PARTNERS_PATH}`]: () => ({ status: 200, body: listCalls++ === 0 ? PARTNERS : flipped }) } });
        assert.deepEqual(await jar.give(url, { mode, cents: 50 }), want, `${route} ${JSON.stringify(reply.body ?? reply.message ?? reply.status)}`);
    }
});

test('409 publisher_not_payable while the refreshed list still says partner: a definite "not a partner" refusal, key released', async () => {
    const { jar, session, fetch } = setup({ routes: { 'POST /api/ledger/spends': { status: 409, body: { error: 'publisher_not_payable' } } } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'not_partner' });
    assert.ok(Object.values(session.data).every(e => e.settled), 'settled: nothing left unresolved');
    const before = fetch.calls.length;
    // Not 'pending': another amount goes to the app again (the earlier refusal recorded nothing).
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 25 }), { ok: false, error: 'not_partner' });
    assert.ok(fetch.calls.length > before);
});

test('409 publisher_blocked refreshes the partner list at once, so the next check shows nothing', async () => {
    let listCalls = 0;
    const nowBlocked = { entries: [ { domain: 'oaklandside.example', status: 'blocked' } ], truncated: false };
    const { jar } = setup({ routes: {
        'POST /api/likes': { status: 409, body: { error: 'publisher_blocked' } },
        [`GET ${PARTNERS_PATH}`]: () => ({ status: 200, body: listCalls++ === 0 ? PARTNERS : nowBlocked }),
    } });
    assert.equal((await jar.check(PAGE)).show, true);
    assert.deepEqual(await jar.like(PAGE, {}, KEY), { ok: false, error: 'blocked' });
    assert.equal(listCalls, 2);
    assert.equal((await jar.check(PAGE)).show, false);
});

test('401 on an action: the token is cleared (compare-and-clear) and the page falls back to signed out', async () => {
    const { jar, storage, fetch } = setup({ routes: { 'POST /api/likes': { status: 401, body: { detail: 'Unauthorized' } } } });
    assert.deepEqual(await jar.like(PAGE, {}, KEY), { ok: false, error: 'unpaired' });
    assert.equal(storage.data[KEYS.token], undefined);
    assert.equal(storage.data[KEYS.revoked], true);
    // Back to signed-out behaviour: no card, the pill instead, and no further request.
    const before = fetch.calls.length;
    assert.deepEqual(await jar.check(PAGE), { show: false, reason: 'signed_out' });
    assert.deepEqual(await jar.gate(PAGE), { go: false, pill: true });
    assert.equal(fetch.calls.length, before);
});

test('unpaired: actions answer unpaired without a network call', async () => {
    const { jar, fetch } = setup({ paired: false });
    assert.deepEqual(await jar.like(PAGE, {}, KEY), { ok: false, error: 'unpaired' });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'unpaired' });
    assert.deepEqual(await jar.balance(), { ok: false, error: 'unpaired' });
    assert.equal(fetch.calls.length, 0, 'signed out: no request at all, the partner list included');
});

test('balance reads GET /api/ledger/balance', async () => {
    const { jar } = setup({ routes: { 'GET /api/ledger/balance': { status: 200, body: { balance_cents: 1250, promotional_cents: 1000, purchased_cents: 250, currency: 'usd' } } } });
    assert.deepEqual(await jar.balance(), { ok: true, balance_cents: 1250 });
    const bad = setup({ routes: { 'GET /api/ledger/balance': { status: 200, body: { balance_cents: '12' } } } });
    assert.deepEqual(await bad.jar.balance(), { ok: false, error: 'unavailable' });
});

// --- privacy: what leaves the browser -------------------------------------------------------------

test('privacy: a page load sends nothing about the page; actions send only the domain, the path hash and the page metadata', async () => {
    const SECRET_PATH = '/investigations/2026/the-mayor-secret-story';
    const url = `https://www.oaklandside.example${SECRET_PATH}?token=abc123&email=reader%40example.com#frag`;
    const { jar, fetch, logs } = setup({ routes: {
        'POST /api/likes': { status: 201, body: { id: 'l', property_status: 'partner', replayed: false } },
        'POST /api/ledger/spends': { status: 201, body: { spend_id: 's', amount_cents: 50, domain: 'oaklandside.example', replayed: false, balance: { balance_cents: 0, promotional_cents: 0 } } },
        'GET /api/ledger/balance': { status: 200, body: { balance_cents: 100, promotional_cents: 100, purchased_cents: 0, currency: 'usd' } },
    } });
    await jar.check(url);
    await jar.dismiss(url); await jar.undismiss(url);
    await jar.promptsState(url);
    // Page load and prompt bookkeeping: only the public partner list, no parameters, no body, no token.
    assert.deepEqual(fetch.calls.map(c => [ c.init.method || 'GET', c.url ]), [ [ 'GET', ORIGIN + PARTNERS_PATH ] ]);
    assert.equal(fetch.calls[0].init.body, undefined);

    await jar.like(url, { title: 'The story', author: 'A Reporter' }, KEY);
    await jar.balance();
    await jar.give(url, { mode: 'tip', cents: 50, meta: { title: 'The story' } });
    const hash = await pathHash(`https://www.oaklandside.example${SECRET_PATH}`, digest);
    const allowed = new Set([ 'idempotency_key', 'domain', 'path_hash', 'title', 'author', 'amount_cents', 'context', 'kind' ]);
    for ( const c of fetch.calls ) {
        assert.ok(c.url === ORIGIN + PARTNERS_PATH || /^\/api\/(likes|pledges|ledger\/spends|ledger\/balance)$/.test(c.url.slice(ORIGIN.length)), c.url);
        assert.ok(!c.url.includes('?'), `no query string: ${c.url}`);
        const sent = `${c.url} ${c.init.body ?? ''} ${JSON.stringify(c.init.headers ?? {})}`;
        for ( const leak of [ 'investigations', 'mayor', 'abc123', 'reader', 'frag', 'www.oaklandside' ] ) {
            assert.ok(!sent.includes(leak), `"${leak}" left the browser: ${sent}`);
        }
        if ( c.init.body !== undefined ) {
            const body = JSON.parse(c.init.body);
            for ( const k of Object.keys(body) ) { assert.ok(allowed.has(k), `unexpected field ${k}`); }
            if ( 'path_hash' in body ) { assert.equal(body.path_hash, hash); }
        }
    }
    for ( const line of logs ) {
        assert.ok(!line.includes('investigations') && !line.includes(TOKEN), `log line leaks: ${line}`);
    }
});

// --- the content-script channel (sw.js wires it to chrome.runtime.onMessage) -----------------------

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const tabSender = (over = {}) => ({ id: EXT, tab: { id: 7 }, frameId: 0, url: PAGE, origin: 'https://www.oaklandside.example', ...over });

function channel(jar, extra = {}) {
    const opened = [];
    const listener = contentListener({
        tipjar: jar, extensionId: EXT,
        openSignup: async ( ) => { opened.push('signup'); return { ok: true }; },
        openReload: async ( ) => { opened.push('reload'); return { ok: true, opened: 'app' }; },
        ...extra,
    });
    const ask = (msg, sender = tabSender()) => new Promise((resolve, reject) => {
        const kept = listener(msg, sender, resolve);
        if ( kept !== true ) { resolve(kept === undefined ? 'ignored' : kept); }
        setTimeout(( ) => reject(new Error('no reply')), 1000);
    });
    return { ask, opened };
}

test('channel: only this extension\'s content script in a top-level http(s) tab is answered', async () => {
    const { jar } = setup();
    const { ask } = channel(jar);
    assert.equal(await ask({ what: 'thankmu:slot-check' }, tabSender({ id: 'another-extension-id-aaaaaaaaaaa' })), 'ignored');
    assert.equal(await ask({ what: 'thankmu:slot-check' }, tabSender({ tab: undefined })), 'ignored');
    assert.equal(await ask({ what: 'thankmu:slot-check' }, tabSender({ frameId: 3 })), 'ignored');
    assert.equal(await ask({ what: 'thankmu:slot-check' }, tabSender({ url: 'chrome-extension://x/popup.html' })), 'ignored');
    assert.equal(await ask({ what: 'thankmu:status' }), 'ignored', 'the extension-page channel is not reachable from here');
    assert.equal(await ask({ what: 'thankmu:slot-nope' }), 'ignored');
    assert.equal(await ask('thankmu:slot-check'), 'ignored');
});

test('channel: the page address comes from the browser (sender.url), never from the message', async () => {
    const { jar, fetch } = setup({ routes: { 'POST /api/likes': { status: 201, body: { id: 'l', property_status: 'partner', replayed: false } } } });
    const { ask } = channel(jar);
    const check = await ask({ what: 'thankmu:slot-check', url: 'https://blocked.example/' });
    assert.deepEqual(check, { show: true, domain: 'oaklandside.example', mode: 'tip', paired: true, amounts: [ ...AMOUNTS_CENTS ] });
    assert.deepEqual(await ask({ what: 'thankmu:slot-like', key: KEY, meta: META, domain: 'evil.example', path_hash: 'f'.repeat(64) }), { ok: true });
    const body = JSON.parse(fetch.calls.find(c => c.url.endsWith('/api/likes')).init.body);
    assert.equal(body.domain, 'oaklandside.example');
    assert.equal(body.path_hash, await pathHash('https://www.oaklandside.example/news/story', digest));
});

test('channel: give, balance, dismiss, undismiss and reload (the card\'s only hop); no account hop, no pairing hop', async () => {
    const { jar } = setup({ routes: {
        'POST /api/ledger/spends': { status: 201, body: { spend_id: 's', amount_cents: 50, domain: 'oaklandside.example', replayed: false, balance: { balance_cents: 0, promotional_cents: 0 } } },
        'GET /api/ledger/balance': { status: 200, body: { balance_cents: 75, promotional_cents: 75, purchased_cents: 0, currency: 'usd' } },
    } });
    const { ask, opened } = channel(jar);
    assert.deepEqual(await ask({ what: 'thankmu:slot-give', mode: 'tip', cents: 50 }), { ok: true, kind: 'tip' });
    assert.deepEqual(await ask({ what: 'thankmu:slot-balance' }), { ok: true, balance_cents: 75 });
    assert.deepEqual(await ask({ what: 'thankmu:slot-dismiss' }), { ok: true });
    assert.deepEqual(await ask({ what: 'thankmu:slot-check' }), { show: false, reason: 'dismissed' });
    assert.deepEqual(await ask({ what: 'thankmu:slot-undismiss' }), { ok: true });
    assert.equal((await ask({ what: 'thankmu:slot-check' })).show, true);
    assert.deepEqual(await ask({ what: 'thankmu:slot-reload' }), { ok: true, opened: 'app' });
    assert.equal(await ask({ what: 'thankmu:slot-account' }), 'ignored');
    // The signed-in card has no pairing hop any more: signed out there is no card, only the pill.
    assert.equal(await ask({ what: 'thankmu:slot-pair' }), 'ignored');
    assert.deepEqual(opened, [ 'reload' ]);
});

test('channel: a failure inside answers unavailable, never an exception text', async () => {
    const { jar } = setup();
    const { ask } = channel(jar, { openSignup: async ( ) => { throw new Error(`boom ${TOKEN}`); } });
    assert.deepEqual(await ask({ what: 'thankmu:slot-signup' }), { ok: false, error: 'unavailable' });
});


// --- pending tips and pledges: an uncertain result never leads to a second charge -------------------

const SPEND_OK = { status: 201, body: { spend_id: 's', amount_cents: 50, domain: 'oaklandside.example', replayed: false, balance: { balance_cents: 0, promotional_cents: 0 } } };
const entries = session => Object.entries(session.data).filter(([ k ]) => k.startsWith('thankmu.pending|'));
const unresolved = session => entries(session).filter(([ , v ]) => v.settled === undefined);
const sleep = ms => new Promise(r => { setTimeout(r, ms); });
const spends = fetch => fetch.calls.filter(c => c.url.endsWith('/api/ledger/spends'));

test('pending: after a timeout or 5xx the same tip resends the same body and key, from the worker\'s session storage', async () => {
    let reply = new TypeError('timeout');
    const { jar, fetch, session } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb', 'key-three-cc' ], routes: { 'POST /api/ledger/spends': () => reply } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, meta: META }), { ok: false, error: 'uncertain' });
    assert.equal(unresolved(session).length, 1, 'persisted before the request, outside page memory');
    reply = { status: 502 };
    // The page's title changed meanwhile: the retry still sends the first body byte for byte (the app replays a key
    // only for the same body).
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, meta: { title: 'Updated headline' }, retry: true }), { ok: false, error: 'uncertain' });
    reply = { ...SPEND_OK, status: 200, body: { ...SPEND_OK.body, replayed: true } };
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), { ok: true, kind: 'tip', replayed: true });
    const sent = spends(fetch).map(c => c.init.body);
    assert.deepEqual(sent.map(b => JSON.parse(b).idempotency_key), [ 'key-one-aaaa', 'key-one-aaaa', 'key-one-aaaa' ]);
    assert.equal(new Set(sent).size, 1, 'every retry is the same body');
    assert.equal(JSON.parse(sent[0]).title, 'Council votes on budget');
    assert.equal(unresolved(session).length, 0, 'settled on success');
    reply = SPEND_OK;
    await jar.give(PAGE, { mode: 'tip', cents: 50 });
    assert.equal(JSON.parse(fetch.calls.at(-1).init.body).idempotency_key, 'key-two-bbbb', 'a new tip after a settled one is a new tip');
});

test('pending: a different amount while one is unresolved is refused and names the pending one', async () => {
    const { jar, fetch } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], routes: { 'POST /api/ledger/spends': new TypeError('timeout') } });
    await jar.give(PAGE, { mode: 'tip', cents: 50 });
    const before = fetch.calls.length;
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 25 }), { ok: false, error: 'pending', mode: 'tip', cents: 50 });
    assert.equal(fetch.calls.length, before, 'nothing sent');
});

test('pending: survives a new tip jar instance (card reload, worker restart) and expires after its TTL', async () => {
    const a = setup({ keys: [ 'key-one-aaaa' ], routes: { 'POST /api/pledges': new TypeError('timeout') } });
    await a.jar.give(UNKNOWN, { mode: 'pledge', cents: 25 });
    const pairing = createPairing({ appOrigin: ORIGIN, extensionId: 'x', storage: a.storage, fetch: a.fetch, getRandomValues: x => x, log: () => {} });
    const b = createTipJar({ appOrigin: ORIGIN, storage: a.storage, session: a.session, fetch: a.fetch, apiFetch: pairing.apiFetch, accountId: pairing.accountId, digest,
        randomKey: () => 'key-new-zzzz', now: () => a.clock.t, log: () => {} });
    assert.deepEqual(await b.give(UNKNOWN, { mode: 'pledge', cents: 50 }), { ok: false, error: 'pending', mode: 'pledge', cents: 25 });
    await b.give(UNKNOWN, { mode: 'pledge', cents: 25 });
    assert.equal(JSON.parse(a.fetch.calls.at(-1).init.body).idempotency_key, 'key-one-aaaa');
    a.clock.t += PENDING_TTL_MS + 1;
    await b.give(UNKNOWN, { mode: 'pledge', cents: 50 });
    assert.equal(JSON.parse(a.fetch.calls.at(-1).init.body).idempotency_key, 'key-new-zzzz');
    assert.ok(PENDING_TTL_MS >= 24 * 60 * 60 * 1000);
});

test('review !19: a 401 on a retry leaves the entry open; re-paired as the same account, Tip again resends the same key: one spend', async () => {
    const landed = new Set();
    let phase = '5xx';
    const spends = async (url, init) => {
        const key = JSON.parse(init.body).idempotency_key;
        if ( phase === '5xx' ) { landed.add(key); return { status: 503 }; }   // it landed, the answer did not
        if ( phase === '401' ) { return { status: 401, body: {} }; }
        const replayed = landed.has(key);
        landed.add(key);
        return { status: replayed ? 200 : 201, body: { spend_id: 's', amount_cents: 50, domain: 'oaklandside.example', replayed, balance: { balance_cents: 0, promotional_cents: 0 } } };
    };
    const { jar, storage, session } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], store: { [KEYS.account]: 'reader-a' },
        routes: { 'POST /api/ledger/spends': spends } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'uncertain' });
    phase = '401';
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), { ok: false, error: 'unpaired' });
    assert.equal(storage.data[KEYS.token], undefined, 'the token is gone');
    assert.equal(unresolved(session).length, 1, 'the 401 settled nothing');
    phase = 'ok';
    await storage.set({ [KEYS.token]: TOKEN, [KEYS.account]: 'reader-a' });   // re-paired, same reader
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: true, kind: 'tip', replayed: true });
    assert.deepEqual([ ...landed ], [ 'key-one-aaaa' ], 'one key, one spend');
});

test('review !19 retry 2: an upgraded browser (token, no stored account): 503 tip, 401, re-paired as the same account, Tip again: one spend', async () => {
    const landed = new Set();
    let phase = '5xx';
    const spends = async (url, init) => {
        const key = JSON.parse(init.body).idempotency_key;
        if ( phase === '5xx' ) { landed.add(key); return { status: 503 }; }
        if ( phase === '401' ) { return { status: 401, body: {} }; }
        const replayed = landed.has(key);
        landed.add(key);
        return { status: replayed ? 200 : 201, body: { spend_id: 's', amount_cents: 50, domain: 'oaklandside.example', replayed, balance: { balance_cents: 0, promotional_cents: 0 } } };
    };
    const me = { status: 200, body: { client_id: 'c1', kind: 'plugin', external_id: 'x', user_id: 'reader-a' } };
    const { jar, storage, session, fetch } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ],
        routes: { 'POST /api/ledger/spends': spends, 'GET /api/client/me': me } });
    await storage.remove(KEYS.account);   // paired by an older build
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'uncertain' });
    assert.equal(storage.data[KEYS.account], 'reader-a', 'learnt from /me before anything was written');
    assert.ok(entries(session).every(([ k ]) => k.startsWith('thankmu.pending|reader-a|')), JSON.stringify(entries(session)));
    assert.ok(!entries(session).some(([ k ]) => k.includes('legacy')));
    phase = '401';
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), { ok: false, error: 'unpaired' });
    phase = 'ok';
    await storage.set({ [KEYS.token]: TOKEN, [KEYS.account]: 'reader-a' });   // re-paired (the pairing stores the account)
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: true, kind: 'tip', replayed: true });
    assert.deepEqual([ ...landed ], [ 'key-one-aaaa' ], 'one key, one spend');
    assert.equal(fetch.calls.filter(c => c.url.endsWith('/api/client/me')).length, 1, 'the account is learnt once');
});

test('review !19 retry 2: no account known and /me unreachable: nothing is written and nothing is sent', async () => {
    const { jar, storage, session, fetch } = setup({ routes: { 'GET /api/client/me': new TypeError('offline') } });
    await storage.remove(KEYS.account);
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'unavailable' });
    assert.equal(entries(session).length, 0);
    assert.equal(fetch.calls.filter(c => c.url.endsWith('/api/ledger/spends')).length, 0);
});

test('review !19: a first send that gets 401 is taken back (nothing landed); the next tip is a fresh one', async () => {
    const { jar, session } = setup({ routes: { 'POST /api/ledger/spends': { status: 401, body: {} } } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'unpaired' });
    assert.equal(entries(session).length, 0);
});

test('review !19: an unresolved tip belongs to its account: after sign-out another account resends and learns nothing; the first gets it back', async () => {
    const posts = [];
    const { jar, storage } = setup({ store: { [KEYS.account]: 'reader-a' },
        routes: { 'POST /api/ledger/spends': async (url, init) => { posts.push(JSON.parse(init.body).idempotency_key); return { status: 503 }; } } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'uncertain' });
    await storage.remove([ KEYS.token, KEYS.account ]);                                   // A signs out
    await storage.set({ [KEYS.token]: TOKEN, [KEYS.account]: 'reader-b' });              // B pairs
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), { ok: false, error: 'unknown_retry' });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, peek: true }), { ok: false, error: 'none' });
    assert.equal(posts.length, 1, 'nothing sent under B for A\'s tip');
    await storage.set({ [KEYS.account]: 'reader-a' });                                   // A again
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, peek: true }), { ok: false, error: 'pending', mode: 'tip', cents: 50 });
});

test('review !19: the reload hop answers only with the tip jar on', async () => {
    const { jar, storage } = setup();
    const { ask, opened } = channel(jar);
    await jar.setPromptsOn(false);
    assert.deepEqual(await ask({ what: 'thankmu:slot-reload' }), { ok: false, error: 'off' });
    await jar.setPromptsOn(true);
    await storage.remove(KEYS.token);
    assert.deepEqual(await ask({ what: 'thankmu:slot-reload' }), { ok: false, error: 'unpaired' });
    assert.deepEqual(opened, []);
});

test('pending: definite refusals settle the entry (402, 409, 422, 429 refused before recording, 401, any other 4xx)', async () => {
    for ( const reply of [ { status: 402, body: { error: 'insufficient_funds' } }, { status: 409, body: { error: 'publisher_blocked' } },
                           { status: 409, body: { error: 'publisher_not_payable' } }, { status: 404, body: {} }, { status: 400, body: {} },
                           { status: 409, body: { error: 'idempotency_conflict' } }, { status: 422, body: { detail: [] } },
                           { status: 429, body: { error: 'velocity_limited', limit: 'x' } }, { status: 429, body: { error: 'rate_limited' } },
                           { status: 401, body: {} } ] ) {
        const { jar, session } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], routes: { 'POST /api/ledger/spends': reply } });
        const first = await jar.give(PAGE, { mode: 'tip', cents: 50 });
        assert.equal(unresolved(session).length, 0, JSON.stringify(reply));
        // A late "Try again" gets that same outcome back, never a new send.
        if ( reply.status !== 401 ) { assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), first, JSON.stringify(reply)); }
    }
});

// The deadline tests run on node:test's fake timers (setTimeout only), with the real constants: time moves only when
// the test ticks it, so a slow CI runner can't change the order of events (pipeline 4343 failed on wall-clock timing).
// Everything else (promises, setImmediate, the SHA-256 digest on libuv's thread pool) runs for real; settle() lets
// the async work between ticks finish. It waits on the REAL setTimeout (captured before any test mocks it): that
// only gives the thread pool room, it never decides an order, because fake time stands still meanwhile.
const realSetTimeout = globalThis.setTimeout;
async function settle() {
    for ( let round = 0; round < 4; round++ ) {
        for ( let i = 0; i < 20; i++ ) { await new Promise(r => { setImmediate(r); }); }
        await new Promise(r => { realSetTimeout(r, 2); });
    }
}
async function advance(t, ms, step = 500) {
    // Settle before each tick: whatever the last step started reaches its next timer at the time it was started.
    for ( let done = 0; done < ms; done += step ) { await settle(); t.mock.timers.tick(Math.min(step, ms - done)); }
    await settle();
}
// A promise and whether it has settled yet, without waiting for it.
function track(p) { const s = { done: false, value: undefined }; p.then(v => { s.done = true; s.value = v; }); return s; }

test('B1: a refresh (8 s) plus a POST (8 s) overrunning the card: answered "uncertain" at the deadline, one spend, "Try again" learns the outcome', async t => {
    t.mock.timers.enable({ apis: [ 'setTimeout' ] });
    let refreshed = 0;
    let posted = 0;
    const { jar, fetch, clock } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], routes: {
        [`GET ${PARTNERS_PATH}`]: async () => { if ( refreshed++ > 0 ) { await sleep(8000); } return { status: 200, body: PARTNERS }; },
        'POST /api/ledger/spends': async () => { posted++; await sleep(8000); return SPEND_OK; },
    } });
    await jar.check(PAGE);                     // the list is cached once (no wait), then goes stale
    clock.t += PARTNERS_REFRESH_MS + 1;
    const first = track(jar.give(PAGE, { mode: 'tip', cents: 50 }));
    await advance(t, 8000);                    // the refresh answers; the POST goes out
    assert.equal(posted, 1);
    assert.equal(first.done, false);
    await advance(t, GIVE_DEADLINE_MS - 8000 - 500);
    assert.equal(first.done, false, 'not before the deadline');
    await advance(t, 500);                     // the deadline: 12 s, the POST still in flight
    assert.deepEqual(first.value, { ok: false, error: 'uncertain' }, 'the POST went out with no answer yet: honest "may not have gone through"');
    const readSrc = readFileSync(new URL('./adslot.js', import.meta.url), 'utf8');
    assert.ok(GIVE_DEADLINE_MS < Number(/const SEND_TIMEOUT_MS = (\d+);/.exec(readSrc)[1]), 'answered before the card would give up');
    await advance(t, 4000);                    // the POST's 201 lands at 16 s and is recorded
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), { ok: true, kind: 'tip', replayed: true });
    assert.equal(spends(fetch).length, 1, 'one spend: the retry was answered from the settled outcome, no new key');
});

test('B1: past the deadline before the POST, nothing goes out, ever (the card was told "could not reach")', async t => {
    t.mock.timers.enable({ apis: [ 'setTimeout' ] });
    let calls = 0;
    // The list request's own limit (10 s) is lifted here so the refresh alone can outlast give()'s deadline.
    const { jar, fetch, clock, session } = setup({ jarOpts: { timeoutMs: 60000 }, routes: {
        [`GET ${PARTNERS_PATH}`]: async () => { if ( calls++ > 0 ) { await sleep(GIVE_DEADLINE_MS + 3000); } return { status: 200, body: PARTNERS }; },
        'POST /api/ledger/spends': SPEND_OK,
    } });
    await jar.check(PAGE);
    clock.t += PARTNERS_REFRESH_MS + 1;
    const first = track(jar.give(PAGE, { mode: 'tip', cents: 50 }));
    await advance(t, GIVE_DEADLINE_MS);
    assert.deepEqual(first.value, { ok: false, error: 'unavailable' });
    await advance(t, 5000);                    // the refresh answers late: still nothing goes out
    assert.equal(spends(fetch).length, 0);
    assert.equal(entries(session).length, 0);
    // A retry with nothing on record never mints a key.
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), { ok: false, error: 'unknown_retry' });
    assert.equal(spends(fetch).length, 0);
});

test('B1: the worker\'s deadline is below the card\'s wait', () => {
    const src = readFileSync(new URL('./adslot.js', import.meta.url), 'utf8');
    const card = Number(/const SEND_TIMEOUT_MS = (\d+);/.exec(src)[1]);
    assert.ok(GIVE_DEADLINE_MS + 2000 <= card, `${GIVE_DEADLINE_MS} vs ${card}`);
});

test('C4: an unresolved pledge never blocks a tip once the publisher has joined (no changed/pending cycle)', async () => {
    let list = { entries: [], truncated: false };
    const { jar, fetch, clock } = setup({ keys: [ 'key-pledge-aa', 'key-tip-bbbbb' ], routes: {
        [`GET ${PARTNERS_PATH}`]: () => ({ status: 200, body: list }),
        'POST /api/pledges': new TypeError('timeout'),
        'POST /api/ledger/spends': SPEND_OK,
    } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'pledge', cents: 50 }), { ok: false, error: 'uncertain' });
    list = PARTNERS;   // oaklandside.example joins
    clock.t += PARTNERS_REFRESH_MS + 1;
    // The card's pending pledge "Try again" now learns the site takes tips...
    assert.deepEqual(await jar.give(PAGE, { mode: 'pledge', cents: 50, retry: true }), { ok: false, error: 'changed', mode: 'tip' });
    // ...and a tip goes through at once: the open pledge entry is not in its way.
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 25 }), { ok: true, kind: 'tip' });
    assert.equal(JSON.parse(spends(fetch)[0].init.body).idempotency_key, 'key-tip-bbbbb');
});

test('C7: each page\'s entry has its own storage key, so two tabs never overwrite each other', async () => {
    const { jar, session } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], routes: { 'POST /api/ledger/spends': new TypeError('timeout') } });
    await Promise.all([ jar.give(PAGE, { mode: 'tip', cents: 50 }), jar.give('https://oaklandside.example/other-story', { mode: 'tip', cents: 25 }) ]);
    assert.equal(unresolved(session).length, 2);
});

test('gate: signed in, the switch and today\'s dismissal, with no network call; never the pill', async () => {
    const { jar, fetch } = setup();
    assert.deepEqual(await jar.gate(PAGE), { go: true, pill: false });
    await jar.dismiss(PAGE);
    assert.deepEqual(await jar.gate(PAGE), { go: false, pill: false });
    await jar.setPromptsOn(false);
    assert.deepEqual(await jar.gate(UNKNOWN), { go: false, pill: false });
    assert.equal(fetch.calls.length, 0);
});

test('gate: signed out, the pill (never cards), from storage only; dismissed per domain for a day, apart from the cards', async () => {
    const { jar, fetch, clock, storage } = setup({ paired: false });
    assert.deepEqual(await jar.gate(PAGE), { go: false, pill: true });
    assert.deepEqual(await jar.gate(`${ORIGIN}/pair`), { go: false, pill: false }, 'never on the app itself');
    assert.deepEqual(await jar.gate('chrome://newtab/'), { go: false, pill: false });
    assert.equal(await jar.dismissPill('https://news.oaklandside.example/x'), 'news.oaklandside.example');
    assert.equal(await jar.dismissPill(PAGE), 'oaklandside.example');
    assert.deepEqual(await jar.gate(PAGE), { go: false, pill: false });
    assert.deepEqual(await jar.gate(UNKNOWN), { go: false, pill: true }, 'another domain still shows it');
    assert.equal(storage.data[TIPJAR_KEYS.dismissed], undefined, 'the pill has its own dismissals: the cards are not hidden after pairing');
    clock.t += DISMISS_MS;
    assert.deepEqual(await jar.gate(PAGE), { go: false, pill: true }, 'back the next day');
    assert.equal(fetch.calls.length, 0);
});

test('gate: signed out with the tip jar switched off shows no pill (decision: off means nothing in the page)', async () => {
    const { jar, fetch } = setup({ paired: false, store: { [TIPJAR_KEYS.promptsOff]: true } });
    assert.deepEqual(await jar.gate(PAGE), { go: false, pill: false });
    assert.equal(fetch.calls.length, 0);
});

test('gate: signed out, a partner list cached from an earlier session still hides the pill on a blocked property; none is fetched', async () => {
    const cached = { etag: '"v1"', entries: PARTNERS.entries, fetchedAt: 1 };   // however old: it is never refreshed signed out
    const { jar, fetch } = setup({ paired: false, store: { [TIPJAR_KEYS.partners]: cached } });
    assert.deepEqual(await jar.gate('https://www.sports.blocked.example/a'), { go: false, pill: false });
    assert.deepEqual(await jar.gate(PAGE), { go: false, pill: true });
    assert.equal(fetch.calls.length, 0);
});

test('signed out: nothing the content script can send makes a request; the pill opens the sign-up that returns to pairing', async () => {
    const { jar, fetch } = setup({ paired: false });
    const { ask, opened } = channel(jar);
    assert.deepEqual(await ask({ what: 'thankmu:slot-gate' }), { go: false, pill: true });
    assert.deepEqual(await ask({ what: 'thankmu:slot-check' }), { show: false, reason: 'signed_out' });
    assert.deepEqual(await ask({ what: 'thankmu:slot-like', key: KEY, meta: META }), { ok: false, error: 'unpaired' });
    assert.deepEqual(await ask({ what: 'thankmu:slot-give', mode: 'tip', cents: 50 }), { ok: false, error: 'unpaired' });
    assert.deepEqual(await ask({ what: 'thankmu:slot-balance' }), { ok: false, error: 'unpaired' });
    assert.deepEqual(await ask({ what: 'thankmu:slot-signup' }), { ok: true });
    assert.deepEqual(await ask({ what: 'thankmu:slot-pill-dismiss' }), { ok: true });
    assert.deepEqual(await ask({ what: 'thankmu:slot-gate' }), { go: false, pill: false });
    assert.deepEqual(opened, [ 'signup' ]);
    assert.equal(fetch.calls.length, 0);
});

test('switched off while signed in: like, give (a retry of a pending tip too), peek and balance answer off with no request', async t => {
    const { jar, fetch, session } = setup({ routes: { 'POST /api/ledger/spends': { status: 503 } } });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50 }), { ok: false, error: 'uncertain' });
    const before = fetch.calls.length;
    await jar.setPromptsOn(false);
    assert.deepEqual(await jar.like(PAGE, {}, KEY), { ok: false, error: 'off' });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }), { ok: false, error: 'off' });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, peek: true }), { ok: false, error: 'off' });
    assert.deepEqual(await jar.balance(), { ok: false, error: 'off' });
    assert.equal(fetch.calls.length, before, 'no request while off');
    assert.equal(unresolved(session).length, 1, 'the pending tip keeps its key for when the jar is on again');
    await jar.setPromptsOn(true);
});

test('pairing turns the tip jar on: off, then paired again, the gate says cards', async () => {
    const { jar, storage } = setup({ paired: false });
    await jar.setPromptsOn(false);
    assert.equal(storage.data[KEYS.tipJarOff], true, 'the popup switch and pairing share one key');
    await storage.set({ [KEYS.token]: TOKEN });
    await storage.remove(KEYS.tipJarOff);   // what pairing.js handleExternal does on success (pairing.test.mjs)
    assert.deepEqual(await jar.gate(PAGE), { go: true, pill: false });
});

test('review C1: a late 201, then Cancel and a tip again: the card learns it landed (peek), one spend', async t => {
    t.mock.timers.enable({ apis: [ 'setTimeout' ] });
    // A 5 s deadline and an 8 s POST (inside the app call's own 10 s limit): the POST outlasts the deadline.
    const { jar, fetch } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], jarOpts: { giveDeadlineMs: 5000 }, routes: {
        'POST /api/ledger/spends': async () => { await sleep(8000); return SPEND_OK; },
    } });
    const first = track(jar.give(PAGE, { mode: 'tip', cents: 50 }));
    await advance(t, 5000);
    assert.deepEqual(first.value, { ok: false, error: 'uncertain' });
    // Peek while it is still in flight: open.
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, peek: true }), { ok: false, error: 'pending', mode: 'tip', cents: 50 });
    await advance(t, 3500);                    // the 201 lands at 8 s
    // The reader cancelled and taps Tip again: the card peeks and shows "went through" instead of a fresh tip.
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, peek: true }), { ok: true, kind: 'tip', replayed: true });
    // Even a send of another amount, while the card still holds the unresolved flag, goes as a retry: no new key.
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 25, retry: true }), { ok: true, kind: 'tip', replayed: true });
    assert.equal(spends(fetch).length, 1);
    // Nothing on record for another page: peek says none and sends nothing.
    assert.deepEqual(await jar.give('https://oaklandside.example/other', { mode: 'tip', cents: 50, peek: true }), { ok: false, error: 'none' });
    assert.equal(spends(fetch).length, 1);
});

test('review C2: the deadline after the entry is written but before the POST: the entry is taken back, nothing goes out', async t => {
    t.mock.timers.enable({ apis: [ 'setTimeout' ] });
    const { jar, fetch, session } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], routes: { 'POST /api/ledger/spends': SPEND_OK } });
    const set = session.set.bind(session);
    let slow = true;
    // Writing the entry outlasts the deadline.
    session.set = async obj => { if ( slow ) { await sleep(GIVE_DEADLINE_MS + 2000); } return set(obj); };
    const first = track(jar.give(PAGE, { mode: 'tip', cents: 50 }));
    await advance(t, GIVE_DEADLINE_MS);
    assert.deepEqual(first.value, { ok: false, error: 'unavailable' });
    await advance(t, 3000);                    // the write finishes after the deadline
    assert.equal(entries(session).length, 0, 'no entry left behind');
    assert.equal(spends(fetch).length, 0, 'nothing went out');
    slow = false;
    // A different amount next is a fresh tip, not refused as pending.
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 25 }), { ok: true, kind: 'tip' });
    assert.equal(spends(fetch).length, 1);
});

test('review C1 (round 3): uncertain in flight, a retry answers unavailable, the late 201 lands, Tip again: one spend', async t => {
    t.mock.timers.enable({ apis: [ 'setTimeout' ] });
    let slowList = false;
    // A 5 s deadline, a 9 s POST, and a list refresh (6 s) that outlasts the retry's own deadline (its 10 s request
    // limit lifted). Times: send at 0, "uncertain" at 5, retry at 5 answers "unavailable" at 10, the 201 lands at 9.
    const { jar, fetch, clock } = setup({ keys: [ 'key-one-aaaa', 'key-two-bbbb' ], jarOpts: { giveDeadlineMs: 5000, timeoutMs: 60000 }, routes: {
        [`GET ${PARTNERS_PATH}`]: async () => { if ( slowList ) { await sleep(6000); } return { status: 200, body: PARTNERS }; },
        'POST /api/ledger/spends': async () => { await sleep(9000); return SPEND_OK; },
    } });
    await jar.check(PAGE);
    const first = track(jar.give(PAGE, { mode: 'tip', cents: 50 }));
    await advance(t, 5000);
    assert.deepEqual(first.value, { ok: false, error: 'uncertain' });
    // "Try again" while the list refresh outlasts the deadline: no answer at all (the card must keep its flag).
    slowList = true;
    clock.t += PARTNERS_REFRESH_MS + 1;
    const retry = track(jar.give(PAGE, { mode: 'tip', cents: 50, retry: true }));
    await advance(t, 5000);
    assert.deepEqual(retry.value, { ok: false, error: 'unavailable' });
    slowList = false;
    await advance(t, 2000);                    // the refresh ends; the first POST's 201 (at 9 s) is recorded
    // The card kept the flag, so "Tip again" peeks first and shows "went through"; a send would go as a retry.
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 50, peek: true }), { ok: true, kind: 'tip', replayed: true });
    assert.deepEqual(await jar.give(PAGE, { mode: 'tip', cents: 25, retry: true }), { ok: true, kind: 'tip', replayed: true });
    assert.equal(spends(fetch).length, 1);
});
