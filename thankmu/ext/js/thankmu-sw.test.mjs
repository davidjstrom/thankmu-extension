// The service-worker entry must load upstream's worker even when the ThankMu module fails to start
// (W-P3 part B review). Loads the real thankmu-sw.js + thankmu/sw.js + pairing.js from a temp copy, with
// a stub upstream background.js that records that it ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function stage(configJs) {
    const dir = mkdtempSync(join(tmpdir(), 'thankmu-sw-'));
    mkdirSync(join(dir, 'js', 'thankmu'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    copyFileSync(join(HERE, 'thankmu-sw.js'), join(dir, 'js', 'thankmu-sw.js'));
    copyFileSync(join(HERE, 'thankmu', 'sw.js'), join(dir, 'js', 'thankmu', 'sw.js'));
    copyFileSync(join(HERE, 'thankmu', 'pairing.js'), join(dir, 'js', 'thankmu', 'pairing.js'));
    copyFileSync(join(HERE, 'thankmu', 'tipjar.js'), join(dir, 'js', 'thankmu', 'tipjar.js'));
    copyFileSync(join(HERE, 'thankmu', 'popupstate.js'), join(dir, 'js', 'thankmu', 'popupstate.js'));
    writeFileSync(join(dir, 'js', 'thankmu', 'config.js'), configJs);
    writeFileSync(join(dir, 'js', 'background.js'),
        'globalThis.__upstream = { loaded: true, externalBefore: globalThis.__externalListeners?.length ?? 0 };\n');
    return pathToFileURL(join(dir, 'js', 'thankmu-sw.js')).href;
}

function fakeChrome() {
    globalThis.__externalListeners = [];
    const ev = arr => ({ addListener: f => arr.push(f) });
    return {
        runtime: {
            id: 'abcdefghijklmnopabcdefghijklmnop',
            getURL: p => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' + p,
            onMessageExternal: ev(globalThis.__externalListeners),
            onMessage: ev([]), onInstalled: ev([]), onStartup: ev([]),
        },
        storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
                   session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
        tabs: { create: async () => {} },
    };
}

async function load(configJs, chromeStub) {
    delete globalThis.__upstream;
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    if (chromeStub) { globalThis.chrome = chromeStub; } else { delete globalThis.chrome; }
    try {
        await import(stage(configJs));
    } finally {
        console.error = orig;
    }
    return errors;
}

const GOOD = 'export const BUILD_TARGET = "dev";\nexport const APP_ORIGIN = "https://app.example.invalid";\n';

test('normal start: ThankMu registers onMessageExternal before upstream runs, upstream loads', async () => {
    const errors = await load(GOOD, fakeChrome());
    assert.equal(globalThis.__upstream?.loaded, true);
    assert.equal(globalThis.__upstream.externalBefore, 1, 'pairing listener exists before upstream evaluates');
    assert.deepEqual(errors, []);
});

test('ThankMu init throws (no chrome API): upstream blocking worker still loads', async () => {
    const errors = await load(GOOD, undefined);
    assert.equal(globalThis.__upstream?.loaded, true);
    assert.ok(errors.some(e => e.includes('pairing disabled')), errors.join('\n'));
});

test('ThankMu init throws (bad APP_ORIGIN): upstream blocking worker still loads', async () => {
    const errors = await load('export const BUILD_TARGET = "dev";\nexport const APP_ORIGIN = "http://insecure.invalid/";\n', fakeChrome());
    assert.equal(globalThis.__upstream?.loaded, true);
    assert.ok(errors.some(e => e.includes('APP_ORIGIN')), errors.join('\n'));
});

// The app handoff through the real worker wiring (W-P4): the worker opens the tab itself; the page's reply never
// carries the URL with the one-time code.
function chromeWithAccount({ tabsFail = false } = {}) {
    const c = fakeChrome();
    const onMessage = [];
    c.runtime.onMessage = { addListener: f => onMessage.push(f) };
    const data = { 'thankmu.installId': 'A'.repeat(43), 'thankmu.token': 'tmc_' + 'k'.repeat(43), 'thankmu.clientId': 'c1' };
    c.storage.local = {
        get: async keys => Object.fromEntries([].concat(keys).filter(k => k in data).map(k => [k, data[k]])),
        set: async o => { Object.assign(data, o); },
        remove: async keys => { for (const k of [].concat(keys)) { delete data[k]; } },
    };
    const tabs = { created: [], updated: [] };
    c.tabs = {
        create: async o => { if (tabsFail) { throw new Error(`no tab for ${o.url}`); } tabs.created.push(o); },
        update: async (id, o) => { if (tabsFail) { throw new Error(`no tab for ${o.url}`); } tabs.updated.push([id, o]); },
    };
    return { c, onMessage, tabs, data };
}

const CODE = 'S'.repeat(43);
async function askWorker(onMessage, msg, sender) {
    return new Promise(resolve => {
        const keep = onMessage[0](msg, sender, resolve);
        assert.equal(keep, true, 'keeps the channel open');
    });
}

test('worker: thankmu:open-account (the account page\'s Settings button) in place updates the sender tab; a plain click opens a new tab', async () => {
    const { c, onMessage, tabs } = chromeWithAccount();
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => { fetchCalls.push([url, init]); return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ code: CODE, expires_in: 60 }) }; };
    await load(GOOD, c);
    const page = { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/thankmu-account.html', tab: { id: 7 } };
    const r1 = await askWorker(onMessage, { what: 'thankmu:open-account', inPlace: true }, page);
    assert.deepEqual(r1, { ok: true, opened: 'app' });
    assert.deepEqual(tabs.updated, [[7, { url: `https://app.example.invalid/open?code=${CODE}&next=/settings` }]]);
    const r2 = await askWorker(onMessage, { what: 'thankmu:open-account' }, page);
    assert.deepEqual(r2, { ok: true, opened: 'app' });
    assert.deepEqual(tabs.created, [{ url: `https://app.example.invalid/open?code=${CODE}&next=/settings` }]);
    assert.equal(fetchCalls[0][0], 'https://app.example.invalid/api/access/handoff');
    delete globalThis.fetch;
});

test('worker: a refused tab answers {ok: false, error: open_failed}, never the URL or the code', async () => {
    const { c, onMessage } = chromeWithAccount({ tabsFail: true });
    globalThis.fetch = async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ code: CODE, expires_in: 60 }) });
    await load(GOOD, c);
    const r = await askWorker(onMessage, { what: 'thankmu:open-account', inPlace: true },
        { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/thankmu-account.html', tab: { id: 3 } });
    assert.deepEqual(r, { ok: false, error: 'open_failed' });
    assert.ok(!JSON.stringify(r).includes(CODE));
    delete globalThis.fetch;
});

test('worker: open-account from a web page (content script) is ignored', async () => {
    const { c, onMessage } = chromeWithAccount();
    await load(GOOD, c);
    assert.equal(onMessage[0]({ what: 'thankmu:open-account' }, { url: 'https://evil.example.invalid/', tab: { id: 1 } }, () => {}), undefined);
});

// W-T1 part A: the ad-slot channel through the real worker wiring.
const TAB = { id: 'abcdefghijklmnopabcdefghijklmnop', tab: { id: 9 }, frameId: 0, url: 'https://news.example.org/a/story?x=1' };
const POPUP = { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/thankmu-popup.html' };
function ask(listener, msg, sender) {
    return new Promise(resolve => { assert.equal(listener(msg, sender, resolve), true, 'keeps the channel open'); });
}

test('worker: the content-script channel answers slot-check; the extension-page channel stays closed to it', async () => {
    const { c, onMessage } = chromeWithAccount();
    globalThis.fetch = async url => {
        assert.equal(url, 'https://app.example.invalid/api/publishers/partners');
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ entries: [], truncated: false }) };
    };
    await load(GOOD, c);
    assert.equal(onMessage.length, 2);
    const r = await ask(onMessage[1], { what: 'thankmu:slot-check' }, TAB);
    assert.deepEqual(r, { show: true, domain: 'news.example.org', mode: 'pledge', paired: true, amounts: [ 25, 50, 100 ] });
    assert.equal(onMessage[0]({ what: 'thankmu:prompts-set', on: false }, TAB, () => {}), undefined, 'a page cannot flip the switch');
    assert.equal(onMessage[1]({ what: 'thankmu:slot-check' }, POPUP, () => {}), undefined, 'extension pages are not tabs');
    delete globalThis.fetch;
});

test('worker: the popup switch turns the card off and on, and says when this site is hidden for today', async () => {
    const { c, onMessage } = chromeWithAccount();
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ entries: [], truncated: false }) });
    await load(GOOD, c);
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:prompts-set', on: false, tabUrl: TAB.url }, POPUP), { on: false, hidden: null });
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-check' }, TAB), { show: false, reason: 'off' });
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:prompts-set', on: true, tabUrl: TAB.url }, POPUP), { on: true, hidden: null });
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-dismiss' }, TAB), { ok: true });
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:prompts-state', tabUrl: TAB.url }, POPUP), { on: true, hidden: 'news.example.org' });
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:prompts-undismiss', tabUrl: TAB.url }, POPUP), { on: true, hidden: null });
    delete globalThis.fetch;
});

test('worker: the card\'s Reload opens the app at /wallet/topup itself (the card\'s only hop); the reply never carries the code', async () => {
    const { c, onMessage, tabs } = chromeWithAccount();
    globalThis.fetch = async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ code: CODE, expires_in: 60 }) });
    await load(GOOD, c);
    const r = await ask(onMessage[1], { what: 'thankmu:slot-reload' }, TAB);
    assert.deepEqual(r, { ok: true, opened: 'app' });
    assert.deepEqual(tabs.created, [{ url: `https://app.example.invalid/open?code=${CODE}&next=/wallet/topup` }]);
    // E2E-02: the card's old "See your tips" hop (next=/dashboard) is gone; the message is not answered at all.
    assert.equal(onMessage[1]({ what: 'thankmu:slot-account' }, TAB, () => {}), undefined);
    assert.equal(tabs.created.length, 1);
    delete globalThis.fetch;
});

// W-P6: the D2 popup's messages through the real worker wiring.
const ME = { client_id: 'c1', kind: 'plugin', external_id: 'x', household_id: 'h', user_id: 'u',
    wallet: { balance_cents: 2675, promotional_cents: 675, currency: 'usd', sandbox: true },
    counts: { tips_30d: 3, likes_30d: 9, likes_total: 14 }, limits: { spend_24h_remaining_cents: 4800 } };

test('worker: popup-state answers from /api/client/me with only what the popup shows', async () => {
    const { c, onMessage } = chromeWithAccount();
    const seen = [];
    globalThis.fetch = async (url, init) => { seen.push([url, init.method]); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ME }; };
    await load(GOOD, c);
    const r = await ask(onMessage[0], { what: 'thankmu:popup-state' }, POPUP);
    assert.deepEqual(r, { paired: true, verified: true, wallet: { balance_cents: 2675, promotional_cents: 675 }, likes: 14 });
    assert.deepEqual(seen, [[ 'https://app.example.invalid/api/client/me', 'GET' ]]);
    assert.equal(onMessage[0]({ what: 'thankmu:popup-state' }, { url: 'https://evil.example.invalid/', tab: { id: 1 } }, () => {}), undefined,
        'a web page cannot read the wallet');
    delete globalThis.fetch;
});

test('worker: open-app maps the page key to its fixed next; an unknown key opens nothing', async () => {
    const { c, onMessage, tabs } = chromeWithAccount();
    globalThis.fetch = async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ code: CODE, expires_in: 60 }) });
    await load(GOOD, c);
    for (const [page, next] of [[ 'feed', '/feed' ], [ 'wallet', '/wallet/topup' ], [ 'reload', '/wallet/topup' ], [ 'settings', '/settings' ]]) {
        tabs.created.length = 0;
        assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:open-app', page }, POPUP), { ok: true, opened: 'app' });
        assert.deepEqual(tabs.created, [{ url: `https://app.example.invalid/open?code=${CODE}&next=${next}` }], page);
    }
    tabs.created.length = 0;
    for (const page of [ '/evil', 'https://evil.example.invalid/', 'toString', undefined ]) {
        assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:open-app', page }, POPUP), { ok: false, error: 'internal' }, String(page));
    }
    assert.deepEqual(tabs.created, []);
    delete globalThis.fetch;
});

test('worker: Sign in opens the pairing tab and only then marks pairing in progress; Join free opens sign-up', async () => {
    const { c, onMessage, tabs, data } = chromeWithAccount();
    delete data['thankmu.token'];
    await load(GOOD, c);
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:popup-state' }, POPUP), { paired: false, revoked: false, pairing: false });
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:pair' }, POPUP), { ok: true });
    assert.match(tabs.created[0].url, /^https:\/\/app\.example\.invalid\/pair#install=/);
    assert.equal(typeof data['thankmu.pairingStartedAt'], 'number');
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:popup-state' }, POPUP), { paired: false, revoked: false, pairing: true });
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:open-signup' }, POPUP), { ok: true });
    // The sign-up returns to this install's pairing page (W-T10 keeps next through sign-up).
    assert.deepEqual(tabs.created[1], { url: `https://app.example.invalid/signup/reader#next=${encodeURIComponent(`/pair#install=${'A'.repeat(43)}&ext=abcdefghijklmnopabcdefghijklmnop`)}` });
});

test('worker: signed out, the page and the popup make no request at all; the pill opens the same sign-up', async () => {
    const { c, onMessage, tabs, data } = chromeWithAccount();
    delete data['thankmu.token'];
    const calls = [];
    globalThis.fetch = async url => { calls.push(url); throw new Error(`no request may leave signed out: ${url}`); };
    await load(GOOD, c);
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-gate' }, TAB), { go: false, pill: true });
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-check' }, TAB), { show: false, reason: 'signed_out' });
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-balance' }, TAB), { ok: false, error: 'unpaired' });
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-signup' }, TAB), { ok: true });
    assert.match(tabs.created[0].url, /^https:\/\/app\.example\.invalid\/signup\/reader#next=%2Fpair%23install%3D/);
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:popup-state' }, POPUP), { paired: false, revoked: false, pairing: false });
    assert.deepEqual(await ask(onMessage[0], { what: 'thankmu:prompts-state', tabUrl: TAB.url }, POPUP), { on: true, hidden: null });
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-pill-dismiss' }, TAB), { ok: true });
    assert.deepEqual(await ask(onMessage[1], { what: 'thankmu:slot-gate' }, TAB), { go: false, pill: false });
    assert.deepEqual(calls, []);
    delete globalThis.fetch;
});

test('worker: a refused pairing tab does not mark pairing in progress', async () => {
    const { c, onMessage, data } = chromeWithAccount({ tabsFail: true });
    delete data['thankmu.token'];
    await load(GOOD, c);
    const r = await ask(onMessage[0], { what: 'thankmu:pair' }, POPUP);
    assert.equal(r.ok, false);
    assert.equal(data['thankmu.pairingStartedAt'], undefined);
});
