// Tests for the popup's state (W-P6). Pure: the pairing object and storage are fakes.
// Run: node --test thankmu/ext/js/thankmu/popupstate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPopupState, popupFields, SHARE_MS } from './popupstate.js';
import { KEYS } from './pairing.js';

const TOKEN = 'tmc_' + 'a'.repeat(43);
const ME = { client_id: 'c', kind: 'plugin', external_id: 'x', household_id: 'h', user_id: 'u',
    wallet: { balance_cents: 2675, promotional_cents: 675, currency: 'usd', sandbox: true },
    counts: { tips_30d: 3, likes_30d: 9, likes_total: 14 }, limits: { spend_24h_remaining_cents: 4800 } };

function setup({ data = { [KEYS.token]: TOKEN }, answer = { status: 200, ok: true, body: ME }, pairing = false } = {}) {
    const store = { ...data };
    const storage = { get: async k => (k in store ? { [k]: store[k] } : {}) };
    const calls = [];
    let t = 0;
    const p = {
        apiFetch: async (path, init) => {
            calls.push([path, init.method]);
            const a = typeof answer === 'function' ? answer(store) : answer;
            if (a instanceof Error) { throw a; }
            return a;
        },
        pairingInProgress: async () => pairing,
    };
    const ps = createPopupState({ pairing: p, storage, now: () => t });
    return { ps, calls, store, tick: ms => { t += ms; } };
}

test('paired: one GET /api/client/me; the reply holds only the wallet and the likes count', async () => {
    const { ps, calls } = setup();
    const st = await ps.state();
    assert.deepEqual(st, { paired: true, verified: true, wallet: { balance_cents: 2675, promotional_cents: 675 }, likes: 14 });
    assert.deepEqual(calls, [[ '/api/client/me', 'GET' ]]);
    for (const secret of [ TOKEN, 'household_id', 'user_id', 'client_id', 'limits', 'tips_30d', 'likes_30d' ]) {
        assert.ok(!JSON.stringify(st).includes(secret), secret);
    }
});

test('signed out: no network call; says whether the token was revoked and whether pairing is in progress', async () => {
    let { ps, calls } = setup({ data: {} });
    assert.deepEqual(await ps.state(), { paired: false, revoked: false, pairing: false });
    assert.equal(calls.length, 0);
    ({ ps } = setup({ data: { [KEYS.revoked]: true }, pairing: true }));
    assert.deepEqual(await ps.state(), { paired: false, revoked: true, pairing: true });
});

test('unreachable, timed out or non-2xx: paired but unverified, and no wallet or likes (never a made-up $0.00)', async () => {
    for (const answer of [ new Error('timeout'), { status: 500, ok: false, body: undefined }, { status: 429, ok: false, body: {} } ]) {
        const { ps } = setup({ answer });
        assert.deepEqual(await ps.state(), { paired: true, verified: false }, String(answer.status ?? answer));
    }
});

test('401: apiFetch dropped the token, so the popup is signed out (revoked)', async () => {
    const { ps } = setup({ answer: store => { delete store[KEYS.token]; store[KEYS.revoked] = true; return { status: 401, ok: false }; } });
    assert.deepEqual(await ps.state(), { paired: false, revoked: true, pairing: false });
});

test('401 for an old token while a new pairing landed: unverified, the new pairing is kept', async () => {
    const { ps } = setup({ answer: store => { store[KEYS.token] = 'tmc_' + 'b'.repeat(43); return { status: 401, ok: false }; } });
    assert.deepEqual(await ps.state(), { paired: true, verified: false });
});

test('the two frames share one /me call; a new token or SHARE_MS later asks again', async () => {
    const { ps, calls, store, tick } = setup();
    const [ a, b ] = await Promise.all([ ps.state(), ps.state() ]);
    assert.deepEqual(a, b);
    await ps.state();
    assert.equal(calls.length, 1);
    tick(SHARE_MS);
    await ps.state();
    assert.equal(calls.length, 2);
    store[KEYS.token] = 'tmc_' + 'c'.repeat(43);
    await ps.state();
    assert.equal(calls.length, 3);
});

test('popupFields: malformed or missing parts are left out, each on its own', () => {
    assert.deepEqual(popupFields(undefined), {});
    assert.deepEqual(popupFields({ counts: { likes_total: 0 } }), { likes: 0 });
    assert.deepEqual(popupFields({ counts: { likes_30d: 5 } }), {}, 'the 30-day count is never shown as "likes"');
    for (const wallet of [
        { balance_cents: '2675', promotional_cents: 0, currency: 'usd' },
        { balance_cents: 26.75, promotional_cents: 0, currency: 'usd' },
        { balance_cents: -1, promotional_cents: 0, currency: 'usd' },
        { balance_cents: 100, promotional_cents: 200, currency: 'usd' },
        { balance_cents: 100, promotional_cents: 0, currency: 'eur' },
        { balance_cents: 100, currency: 'usd' },
    ]) {
        assert.deepEqual(popupFields({ wallet, counts: { likes_total: 2 } }), { likes: 2 }, JSON.stringify(wallet));
    }
    assert.deepEqual(popupFields({ wallet: ME.wallet, counts: { likes_total: -3 } }), { wallet: { balance_cents: 2675, promotional_cents: 675 } });
});

test('requires its collaborators', () => {
    assert.throws(() => createPopupState({ storage: {} }), /pairing is required/);
    assert.throws(() => createPopupState({ pairing: {} }), /storage is required/);
});
