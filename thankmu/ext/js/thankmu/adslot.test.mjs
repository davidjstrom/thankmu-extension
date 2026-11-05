// Tests for the ad-slot content script (W-T1 part A): the card's states and strings, slot finding and the page
// metadata it reads. adslot.js is a classic content script (manifest content scripts cannot be modules), so the test
// runs it in a vm context with the test flag set; then it exports its pure parts instead of starting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'adslot.js'), 'utf8');

function load(extra = {}) {
    const ctx = vm.createContext({ __THANKMU_ADSLOT_TEST__: true, ...extra });
    vm.runInContext(SRC, ctx, { filename: 'adslot.js' });
    return ctx.ThankMuAdSlot;
}
const A = load();

// The strategy doc's canonical strings (phase-4-thank-you-tip-jar.md §Working shape; design-feedback round 2).
const PARTNER_LINE = 'Would you like to tip the publisher?';
const PLEDGE_LINE = 'Pledge a tip; they get it when they join ThankMu.';

const base = { domain: 'oaklandside.example', paired: true, mode: 'tip', balance: 1250, amount: null, liked: false, amounts: [ 25, 50, 100 ] };
// Values made in the vm realm have its Array/Object prototypes: copy them into this realm before deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));
const view = (state, over = {}) => plain(A.view(state, { ...base, ...over }));
const labels = v => v.actions.map(a => a.label);
const allText = v => [ v.from, v.line, v.sub, v.note, ...labels(v) ].filter(Boolean).join(' | ');

test('the canonical strings are exactly the strategy doc\'s', () => {
    assert.equal(A.PARTNER_LINE, PARTNER_LINE);
    assert.equal(A.PLEDGE_LINE, PLEDGE_LINE);
});

test('ask: like first, then tip; partners get the tip line, everyone else the pledge line', () => {
    const t = view('ask');
    assert.equal(t.line, PARTNER_LINE);
    assert.equal(t.from, 'ThankMu · in place of an ad');
    assert.deepEqual(t.actions.map(a => [ a.id, a.label, a.kind ]), [
        [ 'like', 'Like', 'primary' ], [ 'tip', 'Tip', 'btn' ], [ 'share', 'Share', 'link' ] ]);
    assert.equal(t.actions[0].heart, true);
    assert.equal(t.sub, 'oaklandside.example. A like is free; your ad blocker keeps working either way.');
    const p = view('ask', { mode: 'pledge' });
    assert.equal(p.line, PLEDGE_LINE);
    assert.deepEqual(labels(p), [ 'Like', 'Pledge a tip', 'Share' ]);
    assert.ok(t.dismiss && p.dismiss, 'every card can be dismissed');
});

test('the card is signed-in only: no state offers Connect or pairing (signed out the page gets the pill instead)', () => {
    for ( const mode of [ 'tip', 'pledge' ] ) {
        for ( const state of [ 'ask', 'shared', 'liked', 'amounts', 'confirm', 'done', 'reload', 'dismissed' ] ) {
            const v = view(state, { mode, amount: 50 });
            assert.ok(!v.actions.some(a => a.id === 'pair'), `${mode} ${state}`);
            assert.ok(!allText(v).includes('Connect'), `${mode} ${state}`);
        }
    }
});

// --- the signed-out corner pill (ADR-013, founder 2026-11-02) --------------------------------------

test('pill: the D1 glyph and at most four words; its labels name ThankMu and say what it opens', () => {
    const words = A.PILL_TEXT.trim().split(/\s+/);
    assert.ok(words.length >= 1 && words.length <= 4, A.PILL_TEXT);
    assert.equal(A.PILL_TEXT, 'Turn on tip jar');
    assert.ok(A.PILL_LABEL.startsWith('ThankMu'), 'attribution on the element');
    assert.match(A.PILL_LABEL, /sign/i);
    assert.match(A.PILL_HIDE_LABEL, /today/);
});

test('pill: the glyph is thankmu/icon.svg\'s geometry (plate, mark, coin), coloured by tokens only', () => {
    const icon = readFileSync(join(HERE, '../../../icon.svg'), 'utf8');
    const d = /<path class="fg" d="([^"]+)"/.exec(icon)[1];
    const coin = /<circle class="coin" cx="(\d+)" cy="(\d+)" r="(\d+)"/.exec(icon).slice(1);
    assert.ok(A.GLYPH_SVG.includes(`d="${d}"`), 'the mark\'s path');
    assert.ok(A.GLYPH_SVG.includes(`cx="${coin[0]}" cy="${coin[1]}" r="${coin[2]}"`), 'the coin');
    assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(/i.test(A.GLYPH_SVG), 'no literal colour');
    assert.ok(A.GLYPH_SVG.includes('aria-hidden="true"'));
});

test('pill: placement prefers bottom-right, moves to bottom-left over a page control, hides when both cover one', () => {
    const vp = { width: 1200, height: 800 };
    const size = { width: 180, height: 48 };
    const at = (covers) => plain(A.pillPlacement(vp, size, covers));
    assert.deepEqual(at(( ) => 'none'), { corner: 'right', left: 1200 - 16 - 180, top: 800 - 16 - 48 });
    assert.deepEqual(at(( ) => 'content'), { corner: 'right', left: 1004, top: 736 }, 'plain text under it is fine');
    assert.deepEqual(at(r => (r.left > 600 ? 'control' : 'none')), { corner: 'left', left: 16, top: 736 });
    assert.equal(A.pillPlacement(vp, size, ( ) => 'control'), null);
});

test('pill: the corner it is in now is probed first; if clear, the other is never probed', () => {
    const vp = { width: 1200, height: 800 };
    const size = { width: 180, height: 48 };
    const probed = [];
    const r = plain(A.pillPlacement(vp, size, rect => { probed.push(rect.left); return 'none'; }, 'left'));
    assert.equal(r.corner, 'left');
    assert.deepEqual(probed, [ 16 ]);
    probed.length = 0;
    assert.equal(plain(A.pillPlacement(vp, size, rect => { probed.push(rect.left); return rect.left === 16 ? 'control' : 'none'; }, 'left')).corner, 'right');
    assert.deepEqual(probed, [ 16, 1004 ]);
});

test('pill: under 320 px wide it shows only where it covers nothing at all', () => {
    const size = { width: 150, height: 48 };
    assert.equal(A.pillPlacement({ width: 300, height: 600 }, size, ( ) => 'content'), null);
    assert.equal(plain(A.pillPlacement({ width: 300, height: 600 }, size, ( ) => 'none')).corner, 'right');
    assert.equal(plain(A.pillPlacement({ width: 320, height: 600 }, size, ( ) => 'content')).corner, 'right');
});

test('pill: a page control is a link, a form control, a button, anything focusable or clickable by role, or a fixed widget', () => {
    const node = (tag, attrs = {}, parent = null, position = 'static') => ({
        nodeType: 1, tagName: tag.toUpperCase(), parentElement: parent, position,
        hasAttribute: k => k in attrs, getAttribute: k => attrs[k] ?? null,
    });
    const pos = n => n.position;
    const body = node('body');
    for ( const tag of [ 'a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'video', 'iframe' ] ) {
        assert.equal(A.isPageControl(node(tag, {}, body), pos), true, tag);
    }
    assert.equal(A.isPageControl(node('div', { role: 'button' }, body), pos), true);
    assert.equal(A.isPageControl(node('div', { tabindex: '0' }, body), pos), true);
    assert.equal(A.isPageControl(node('div', { onclick: 'x()' }, body), pos), true);
    assert.equal(A.isPageControl(node('div', { contenteditable: 'true' }, body), pos), true);
    assert.equal(A.isPageControl(node('span', {}, node('a', {}, body)), pos), true, 'inside a link');
    assert.equal(A.isPageControl(node('div', {}, node('div', {}, body, 'fixed')), pos), true, 'a fixed widget (chat, cookie bar)');
    assert.equal(A.isPageControl(node('div', {}, body, 'sticky'), pos), true);
    assert.equal(A.isPageControl(node('p', {}, body), pos), false);
    assert.equal(A.isPageControl(node('div', { tabindex: '-1' }, body), pos), false, 'not in the tab order');
});

test('liked: the tip offer follows at once, amounts in dollars and cents, no default selected', () => {
    const t = view('liked', { liked: true });
    assert.equal(t.line, 'Liked.');
    assert.equal(t.heartLine, true);
    assert.equal(t.sub, 'Add a tip?');
    assert.deepEqual(t.actions.map(a => [ a.id, a.label, a.cents, !!a.pressed ]), [
        [ 'amount', '25¢', 25, false ], [ 'amount', '50¢', 50, false ], [ 'amount', '$1', 100, false ], [ 'dismiss', 'Not now', undefined, false ] ]);
    assert.equal(view('liked', { liked: true, mode: 'pledge' }).sub, PLEDGE_LINE);
});

test('amounts the wallet cannot cover are disabled for tips, never for pledges (no money moves)', () => {
    const t = view('amounts', { balance: 60 });
    assert.equal(t.line, 'Tip oaklandside.example');
    assert.equal(t.sub, 'Choose an amount.');
    assert.deepEqual(t.actions.filter(a => a.id === 'amount').map(a => !!a.disabled), [ false, false, true ]);
    assert.equal(t.note, 'Your wallet has $0.60.');
    assert.equal(t.noteAction?.id, 'reload');
    const p = view('amounts', { balance: 0, mode: 'pledge' });
    assert.equal(p.line, PLEDGE_LINE);
    assert.deepEqual(p.actions.filter(a => a.id === 'amount').map(a => !!a.disabled), [ false, false, false ]);
    assert.equal(p.note, undefined);
    // Unknown balance (it could not be read): nothing disabled; the app is the judge (402).
    assert.deepEqual(view('amounts', { balance: null }).actions.filter(a => a.disabled), []);
});

test('confirm: tips say where the money comes from; pledges say nothing is charged and when it lapses', () => {
    const t = view('confirm', { amount: 50 });
    assert.equal(t.line, 'Tip oaklandside.example 50¢?');
    assert.equal(t.sub, 'From your ThankMu wallet.');
    assert.deepEqual(t.actions.map(a => [ a.id, a.label ]), [ [ 'send', 'Send 50¢ tip' ], [ 'back', 'Back' ] ]);
    assert.equal(t.actions[0].money, true, 'the send button moves money: the trusted-click check applies');
    const p = view('confirm', { amount: 100, mode: 'pledge' });
    assert.equal(p.line, 'Pledge a $1 tip to oaklandside.example?');
    assert.equal(p.sub, 'Nothing is charged now. When they join ThankMu, we\'ll ask you once before it\'s sent. If they haven\'t joined in 12 months, it lapses.');
    assert.deepEqual(p.actions.map(a => [ a.id, a.label ]), [ [ 'send', 'Pledge $1' ], [ 'back', 'Back' ] ]);
});

test('done, reload, dismissed and shared states', () => {
    const d = view('done', { amount: 50 });
    assert.equal(d.line, 'Tip sent.');
    assert.equal(d.sub, '50¢ to oaklandside.example, from your wallet.');
    // E2E-02: no link into the app after a tip or pledge (the old "See your tips" opened /open…next=/dashboard).
    assert.deepEqual(labels(d), []);
    const dp = view('done', { amount: 50, mode: 'pledge' });
    // A pledge says pledged, never "tip sent", and that nothing was charged.
    assert.equal(dp.line, 'Pledged.');
    assert.equal(dp.sub, '50¢ for oaklandside.example. Nothing was charged; we\'ll ask you once when they join ThankMu.');
    assert.deepEqual(labels(dp), []);
    const short = view('reload', { liked: false, short: true });
    assert.equal(short.line, 'Not enough in your wallet for this tip.');
    assert.equal(short.sub, 'Nothing was charged. Reload your wallet to keep tipping.');
    assert.deepEqual(labels(short), [ 'Reload', 'Not now' ]);
    const r = view('reload', { liked: true, balance: 10 });
    assert.equal(r.line, 'Liked. Your balance is too low to tip.');
    assert.equal(r.sub, 'Reload your wallet to keep tipping. Your first reload comes with a bonus.');
    assert.deepEqual(labels(r), [ 'Reload', 'Not now' ]);
    const x = view('dismissed');
    assert.equal(x.line, undefined);
    assert.equal(x.sub, 'Hidden on oaklandside.example for today.');
    assert.deepEqual(x.actions.map(a => [ a.id, a.label ]), [ [ 'undo', 'Undo' ] ]);
    assert.equal(x.dismiss, false);
    assert.equal(view('shared').line, 'Link copied.');
});

test('errors read as plain sentences and keep a way forward', () => {
    const cases = {
        velocity: 'That\'s your spending limit for today. Nothing was charged.',
        rate_limited: 'Too many at once. Nothing was sent. Try again in a minute.',
        unavailable: 'Could not reach ThankMu just now. Try again in a moment.',
        amounts_changed: 'This version of ThankMu is out of date. Update it to tip.',
        invalid: 'Something went wrong. Try again.',
        copy_failed: 'Could not copy the link.',
    };
    for ( const [ error, text ] of Object.entries(cases) ) {
        const v = view('error', { error, amount: 50 });
        assert.equal(v.sub, text, error);
        assert.ok(v.actions.length >= 1 && v.dismiss, error);
    }
});

test('vocabulary: likes and tips only, never "thank-you" or "heart" as words, never promotional credit', () => {
    const states = [ 'ask', 'liked', 'amounts', 'confirm', 'done', 'reload', 'dismissed', 'shared' ];
    for ( const mode of [ 'tip', 'pledge' ] ) {
        for ( const paired of [ true ] ) {
            for ( const s of states ) {
                const t = allText(view(s, { mode, paired, amount: 50, liked: true })).toLowerCase();
                for ( const bad of [ 'thank-you', 'thank you', 'heart', 'promotional', 'token', 'points' ] ) {
                    assert.ok(!t.includes(bad), `${s}/${mode}: "${bad}" in ${t}`);
                }
            }
        }
    }
});

test('money: cents under a dollar as ¢, whole dollars bare, the rest with cents; balances always $x.yy', () => {
    assert.equal(A.money(25), '25¢');
    assert.equal(A.money(100), '$1');
    assert.equal(A.money(950), '$9.50');
    assert.equal(A.balanceText(5), '$0.05');
    assert.equal(A.balanceText(1250), '$12.50');
});

// --- page metadata (title and byline, sent only on an action) --------------------------------------

function fakeMetaDoc({ metas = {}, title = '', ld = [] } = {}) {
    return {
        title,
        querySelector(sel) {
            const m = /^meta\[(name|property)="([^"]+)"\]$/.exec(sel);
            if ( m && metas[m[2]] !== undefined ) { return { getAttribute: k => (k === 'content' ? metas[m[2]] : null) }; }
            return null;
        },
        querySelectorAll(sel) {
            return sel === 'script[type="application/ld+json"]' ? ld.map(t => ({ textContent: t })) : [];
        },
    };
}

test('readMeta: og:title before the document title; author from meta, never a profile URL; JSON-LD byline', () => {
    assert.deepEqual(plain(A.readMeta(fakeMetaDoc({ metas: { 'og:title': 'OG title', author: 'Jane Doe' }, title: 'Doc | Site' }))),
        { title: 'OG title', author: 'Jane Doe' });
    assert.deepEqual(plain(A.readMeta(fakeMetaDoc({ title: 'Doc title', metas: { 'article:author': 'https://example.com/jane' } }))),
        { title: 'Doc title' });
    assert.deepEqual(plain(A.readMeta(fakeMetaDoc({ title: 'T', ld: [ 'not json', JSON.stringify({ '@type': 'NewsArticle', author: [ { name: 'A. Reporter' } ] }) ] }))),
        { title: 'T', author: 'A. Reporter' });
    assert.deepEqual(plain(A.readMeta(fakeMetaDoc({ title: 'T', ld: [ JSON.stringify({ '@graph': [ { '@type': 'Article', author: { name: 'G. Writer' } } ] }) ] }))),
        { title: 'T', author: 'G. Writer' });
    assert.deepEqual(plain(A.readMeta(fakeMetaDoc({}))), {});
});

// --- slot finding ---------------------------------------------------------------------------------

// A tiny DOM: el(attrs, ...children). `ad` marks what the slot selectors match; `none` is display:none on that
// element; `w`/`h` its box. getClientRects() is empty when the element or an ancestor is display:none.
function el(opts = {}, ...children) {
    const e = { nodeType: 1, tagName: (opts.tag ?? 'div').toUpperCase(), ...opts, children, parentElement: null, childElementCount: children.length };
    for ( const c of children ) { c.parentElement = e; }
    e.getClientRects = ( ) => {
        for ( let n = e; n; n = n.parentElement ) { if ( n.none ) { return []; } }
        return [ { width: e.w ?? 300, height: e.h ?? 250 } ];
    };
    e.getBoundingClientRect = ( ) => e.getClientRects()[0] ?? { width: 0, height: 0 };
    return e;
}
function fakeDoc(body) {
    const html = el({ tag: 'html' }, body);
    const all = [];
    (function walk(n) { all.push(n); n.children.forEach(walk); })(html);
    return { body, documentElement: html, querySelectorAll: ( ) => all.filter(n => n.ad) };
}

test('findSlot: a slot the blocker hid; the card goes after its outermost hidden wrapper', () => {
    const slot = el({ ad: true });
    const wrapper = el({ none: true }, slot);
    const doc = fakeDoc(el({ tag: 'body' }, el({ tag: 'article' }), wrapper));
    assert.equal(A.findSlot(doc)?.anchor, wrapper);
});

test('findSlot: an empty slot whose ad never loaded counts (network-blocked), after the second look', () => {
    const slot = el({ ad: true, h: 0 });
    const doc = fakeDoc(el({ tag: 'body' }, slot));
    assert.deepEqual([ A.findSlot(doc)?.anchor === slot, A.findSlot(doc)?.kind ], [ true, 'empty' ]);
    // A slot whose size the page reserves in CSS, left empty, counts as well.
    const sized = el({ ad: true, w: 300, h: 250 });
    assert.equal(A.findSlot(fakeDoc(el({ tag: 'body' }, sized)))?.anchor, sized);
});

test('findSlot: a slot showing an ad is not a blocked slot; nothing to find means null', () => {
    const live = el({ ad: true }, el({ tag: 'iframe' }));
    assert.equal(A.findSlot(fakeDoc(el({ tag: 'body' }, live))), null);
    assert.equal(A.findSlot(fakeDoc(el({ tag: 'body' }, el({ tag: 'p' })))), null);
});

test('findSlot never anchors on <body> or <html> (a hidden page is not a slot)', () => {
    const body = el({ tag: 'body', none: true }, el({ ad: true }));
    assert.equal(A.findSlot(fakeDoc(body)), null);
});

test('the slot selectors are a non-empty list of strings', () => {
    assert.ok(Array.isArray(A.SLOT_SELECTORS) && A.SLOT_SELECTORS.length >= 5);
    assert.ok(A.SLOT_SELECTORS.every(s => typeof s === 'string' && s.length > 0));
});

test('outside the test flag the script starts only in a top-level http(s) page with the extension runtime', () => {
    // No chrome runtime: it must not throw and must not export.
    const ctx = vm.createContext({});
    vm.runInContext(SRC, ctx);
    assert.equal(ctx.ThankMuAdSlot, undefined);
});

test('pending: an uncertain tip pins the card to retrying that same tip (or cancelling); no other amount is offered', () => {
    const t = view('pending', { amount: 50 });
    assert.equal(t.line, 'Your 50¢ tip may not have gone through.');
    assert.equal(t.sub, 'Try again. If it did go through, you won\'t be charged twice.');
    assert.deepEqual(t.actions.map(a => [ a.id, a.label, !!a.money ]), [ [ 'send', 'Try again', true ], [ 'cancel', 'Cancel', false ] ]);
    assert.ok(!t.actions.some(a => a.id === 'amount' || a.id === 'back'), 'no way to pick another amount while unresolved');
    const p = view('pending', { amount: 25, mode: 'pledge' });
    assert.equal(p.line, 'Your 25¢ pledge may not have gone through.');
    assert.equal(p.sub, 'Try again. If it did go through, it won\'t be pledged twice.');
});

test('a conflict means the earlier one landed: a definite done state', () => {
    assert.equal(view('done', { amount: 50, already: true }).sub, 'Your earlier tip went through.');
    assert.equal(view('done', { amount: 50, already: true, mode: 'pledge' }).sub, 'Your earlier pledge went through.');
});

test('Send is armed only after the confirm card has been visible for ARM_MS; double and triple clicks never send', () => {
    const t0 = 10_000;
    // From the amounts state or the liked state the amount click (detail 1) shows confirm at t0, Send in the same place.
    for ( const from of [ 'amounts', 'liked' ] ) {
        const shown = { shownAt: t0, visibleSince: t0 };
        assert.equal(A.sendAllowed({ ...shown, now: t0 + 80, detail: 2 }), 'ignore', `${from}: second click of a double-click`);
        assert.equal(A.sendAllowed({ ...shown, now: t0 + 160, detail: 3 }), 'ignore', `${from}: third click of a triple-click`);
        assert.equal(A.sendAllowed({ ...shown, now: t0 + 200, detail: 1 }), 'ignore', `${from}: too soon after the card changed`);
        assert.equal(A.sendAllowed({ ...shown, now: t0 + A.ARM_MS, detail: 1 }), 'ok', `${from}: a deliberate click`);
        assert.equal(A.sendAllowed({ ...shown, now: t0 + 5000, detail: 2 }), 'ignore', `${from}: a double-click is never a send`);
    }
    // Visibility must be continuous: became visible late, or not visible now.
    assert.equal(A.sendAllowed({ shownAt: t0, visibleSince: t0 + 900, now: t0 + 1000, detail: 1 }), 'ignore');
    assert.equal(A.sendAllowed({ shownAt: t0, visibleSince: null, now: t0 + 5000, detail: 1 }), 'not_visible');
    assert.ok(A.ARM_MS >= 400 && A.ARM_MS <= 1000);
});

test('amount buttons ignore the extra clicks of a double-click too', () => {
    assert.equal(A.clickCounts({ id: 'amount' }, 2), false);
    assert.equal(A.clickCounts({ id: 'amount' }, 1), true);
    assert.equal(A.clickCounts({ id: 'like' }, 2), true, 'a like is free and idempotent');
});

test('not visible on Send: the card says why instead of doing nothing', () => {
    const v = view('confirm', { amount: 50, notice: 'not_visible' });
    assert.equal(v.note, 'Scroll the card fully into view, then send.');
    assert.equal(view('pending', { amount: 50, notice: 'not_visible' }).note, 'Scroll the card fully into view, then send.');
});

// The real start-up path (not the test export): without the design tokens the card must not start at all, so no
// element is created and no shadow root attached; with them it does start (it schedules its first look).
function startInPage(tokens) {
    const calls = { timers: 0, createElement: [], attachShadow: 0, errors: [], storageListeners: 0, docEvents: [] };
    const ctx = vm.createContext({
        chrome: { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', sendMessage: async () => ({}) },
            storage: { onChanged: { addListener: () => { calls.storageListeners++; } } } },
        location: { protocol: 'https:' },
        document: { createElement: t => { calls.createElement.push(t); return { attachShadow: () => { calls.attachShadow++; } }; }, querySelectorAll: () => [],
            addEventListener: t => { calls.docEvents.push(t); } },
        console: { error: m => { calls.errors.push(String(m)); } },
        setTimeout: () => { calls.timers++; return 0; },
        clearTimeout: () => {},
        crypto: { getRandomValues: a => a },
    });
    ctx.window = ctx;
    ctx.window.top = ctx;
    if ( tokens !== undefined ) { ctx.ThankMuTokensCss = tokens; }
    vm.runInContext(SRC, ctx, { filename: 'adslot.js' });
    return calls;
}

test('no design tokens: the card never starts, creates no element, attaches no shadow root, and says why', () => {
    for ( const tokens of [ undefined, '', 42 ] ) {
        const c = startInPage(tokens);
        assert.equal(c.attachShadow, 0);
        assert.deepEqual(c.createElement, []);
        assert.equal(c.timers, 0, 'it must not even look for slots');
        assert.equal(c.errors.length, 1);
        assert.match(c.errors[0], /design tokens missing/);
    }
});

test('with the design tokens the card starts (it schedules its first look for an ad slot)', () => {
    const c = startInPage('.tm-slot { --white: #fff; }');
    assert.equal(c.errors.length, 0);
    assert.ok(c.timers >= 1);
    // Review of MR !19: it follows the switch, Sign out and pairing at once (storage events), and on coming back to the tab.
    assert.equal(c.storageListeners, 1);
    assert.deepEqual(c.docEvents, [ 'visibilitychange' ]);
});

// --- E2E-02: a card in every emptied slot -------------------------------------------------------------------

test('findSlots: every emptied slot on the page, in order (no more one-per-page rule)', () => {
    const a = el({ ad: true });
    const wa = el({ none: true }, a);
    const b = el({ ad: true, w: 300, h: 250 });
    const c = el({ ad: true, w: 728, h: 90 });
    const doc = fakeDoc(el({ tag: 'body' }, wa, el({ tag: 'p' }), b, c));
    const found = A.findSlots(doc);
    assert.equal(found.length, 3);
    assert.deepEqual([ found[0].anchor === wa, found[1].anchor === b, found[2].anchor === c ], [ true, true, true ]);
    assert.deepEqual(plain(found.map(f => f.kind)), [ 'hidden', 'empty', 'empty' ]);
});

test('findSlots: a slot holding only empty wrappers is empty (thestreet.com: <div.ad-slot><div id=ad-…></div></div>)', () => {
    const slot = el({ ad: true, w: 322, h: 300 }, el({ tag: 'div' }, el({ tag: 'div' })));
    assert.equal(A.findSlots(fakeDoc(el({ tag: 'body' }, slot)))[0]?.anchor, slot);
    for ( const tag of [ 'iframe', 'img', 'video', 'ins', 'a', 'svg' ] ) {
        const full = el({ ad: true, w: 322, h: 300 }, el({ tag: 'div' }, el({ tag })));
        assert.deepEqual(plain(A.findSlots(fakeDoc(el({ tag: 'body' }, full)))), [], tag);
    }
    const text = el({ ad: true, w: 300, h: 250, textContent: 'Advertisement' }, el({ tag: 'span', textContent: 'Advertisement' }));
    assert.deepEqual(plain(A.findSlots(fakeDoc(el({ tag: 'body' }, text)))), []);
});

test('findSlots: the ad tag\'s own script is not content (the standard GPT slot left empty by a blocked request)', () => {
    const script = el({ tag: 'script' });
    script.childNodes = [ { nodeType: 3, data: 'googletag.cmd.push(function() { googletag.display("div-gpt-ad-1"); });' } ];
    const slot = el({ ad: true, w: 300, h: 250 }, script);
    slot.childNodes = [ { nodeType: 3, data: '\n  ' }, script ];
    assert.equal(A.findSlots(fakeDoc(el({ tag: 'body' }, slot)))[0]?.anchor, slot);
    // Text a reader sees still counts as content.
    const label = el({ tag: 'span' });
    label.childNodes = [ { nodeType: 3, data: 'Sponsored' } ];
    const shown = el({ ad: true, w: 300, h: 250 }, script, label);
    shown.childNodes = [ script, label ];
    assert.deepEqual(plain(A.findSlots(fakeDoc(el({ tag: 'body' }, shown)))), []);
});

test('findSlots: nested matches are one slot, the outermost (one card per ad, never one per wrapper)', () => {
    const inner = el({ ad: true, w: 300, h: 250 });
    const outer = el({ ad: true, w: 300, h: 250 }, el({ tag: 'div' }, inner));
    assert.deepEqual(plain(A.findSlots(fakeDoc(el({ tag: 'body' }, outer))).map(f => f.anchor === outer)), [ true ]);
    // Hidden: the inner match climbs to the same hidden wrapper as the outer one.
    const hi = el({ ad: true });
    const ho = el({ ad: true }, hi);
    const wrap = el({ none: true }, ho);
    assert.deepEqual(plain(A.findSlots(fakeDoc(el({ tag: 'body' }, wrap))).map(f => f.anchor === wrap)), [ true ]);
});

test('findSlots: a slot the page hides itself (its own breakpoint CSS) is not an emptied slot', () => {
    // thestreet.com: three variants of each in-content slot, two hidden by .not-size-* rules at any width.
    const shown = el({ ad: true, w: 730, h: 140, cls: 'not-size-d' });
    const pageHidden = el({ ad: true, none: true, cls: 'not-size-c' });
    const blockerHidden = el({ ad: true, none: true, cls: 'header' });
    const doc = fakeDoc(el({ tag: 'body' }, shown, pageHidden, blockerHidden));
    const found = A.findSlots(doc, { pageHides: n => n.cls === 'not-size-c' });
    assert.deepEqual(plain(found.map(f => f.anchor.cls)), [ 'not-size-d', 'header' ]);
    // A hidden wrapper the page hides counts the same.
    const inWrap = el({ ad: true });
    const wrap = el({ none: true, cls: 'page-hides-me' }, inWrap);
    assert.deepEqual(plain(A.findSlots(fakeDoc(el({ tag: 'body' }, wrap)), { pageHides: n => n.cls === 'page-hides-me' })), []);
});

test('findSlots: no card for fixed-position slots (interstitials, sticky footers) or 0 x 0 out-of-page slots', () => {
    const fixed = el({ ad: true, w: 728, h: 90, cls: 'fixed' });
    const zero = el({ ad: true, w: 0, h: 0 });
    const collapsed = el({ ad: true, w: 640, h: 0 });   // GPT collapsed an empty slot: width is still known
    const found = A.findSlots(fakeDoc(el({ tag: 'body' }, fixed, zero, collapsed)), { isFixed: n => n.cls === 'fixed' });
    assert.deepEqual(plain(found.map(f => f.anchor === collapsed)), [ true ]);
});

test('readyToShow: hidden slots at once; an empty slot only when the previous look saw it empty; never twice', () => {
    const h = { anchor: { id: 'h' }, el: { id: 'he' }, kind: 'hidden' };
    const e1 = { anchor: { id: 'e1' }, el: { id: 'e1' }, kind: 'empty' };
    e1.anchor = e1.el;
    const first = A.readyToShow([ h, e1 ], new Set(), new Set());
    assert.deepEqual(plain(first.ready.map(s => s.kind)), [ 'hidden' ]);
    const second = A.readyToShow([ h, e1 ], first.empties, new Set([ h.anchor ]));
    assert.deepEqual(plain(second.ready.map(s => s.el.id)), [ 'e1' ]);
    const third = A.readyToShow([ h, e1 ], second.empties, new Set([ h.anchor, e1.anchor ]));
    assert.deepEqual(plain(third.ready), []);
    // Looks go on for a minute, for slots a page adds as the reader scrolls.
    assert.ok(A.LOOKS_MS.length >= 3 && A.LOOKS_MS.at(-1) >= 30000);
    assert.ok(A.LOOKS_MS.every((t, i) => i === 0 || t - A.LOOKS_MS[i - 1] >= 3500), 'two looks are at least 3.5 s apart');
});

test('cardSize: each card the width of its slot (never wider than its room); compact for banners and narrow slots; none below the minimum', () => {
    assert.deepEqual(plain(A.cardSize({ width: 300, height: 250 }, 1000, 'empty')), { width: 300, minHeight: null, compact: false });
    assert.deepEqual(plain(A.cardSize({ width: 322, height: 300 }, 1000, 'hidden')), { width: 322, minHeight: 300, compact: false });
    assert.deepEqual(plain(A.cardSize({ width: 728, height: 90 }, 1000, 'hidden')), { width: 728, minHeight: 90, compact: true });
    assert.deepEqual(plain(A.cardSize({ width: 730, height: 140 }, 643, 'empty')), { width: 643, minHeight: null, compact: true });
    assert.deepEqual(plain(A.cardSize({ width: 200, height: 600 }, 1000, 'hidden')), { width: 200, minHeight: 600, compact: true });
    assert.deepEqual(plain(A.cardSize({ width: 300, height: 1050 }, 1000, 'hidden')), { width: 300, minHeight: 600, compact: false });
    assert.deepEqual(plain(A.cardSize({ width: null, height: null }, 1348, 'hidden')), { width: 300, minHeight: null, compact: false });
    assert.deepEqual(plain(A.cardSize({ width: null, height: 119 }, 1348, 'hidden')), { width: 300, minHeight: 119, compact: true });
    assert.equal(A.cardSize({ width: 120, height: 600 }, 1000, 'hidden'), null);
    assert.equal(A.cardSize({ width: 300, height: 250 }, 150, 'empty'), null);
    assert.equal(A.cardSize({ width: null, height: null }, null, 'hidden'), null);
    assert.equal(A.px('300px'), 300);
    assert.equal(A.px('118.8px'), 118.8);
    assert.equal(A.px('auto'), null);
    assert.equal(A.px('100%'), null);
});

test('compact card: no "from" line and no sub-line on the first ask, no Share; every other state keeps its words', () => {
    const c = view('ask', { compact: true });
    assert.equal(c.from, undefined);
    assert.equal(c.sub, undefined);
    assert.equal(c.line, PARTNER_LINE);
    assert.deepEqual(labels(c), [ 'Like', 'Tip' ]);
    assert.equal(view('confirm', { compact: true, amount: 50, mode: 'pledge' }).sub, view('confirm', { amount: 50, mode: 'pledge' }).sub);
    assert.equal(view('done', { compact: true, amount: 50, mode: 'pledge' }).sub, view('done', { amount: 50, mode: 'pledge' }).sub);
    assert.ok(c.dismiss);
});

test('refusals show in place: blocked and not a partner, each saying nothing moved', () => {
    const b = view('refused', { refusal: 'blocked' });
    assert.equal(b.line, 'oaklandside.example isn\'t taking likes or tips through ThankMu.');
    assert.equal(b.sub, 'Nothing was sent.');
    assert.deepEqual(labels(b), []);
    const n = view('refused', { refusal: 'not_partner' });
    assert.equal(n.line, 'oaklandside.example can\'t take tips through ThankMu yet.');
    assert.equal(n.sub, 'Nothing was charged.');
    // A tip refused as not payable while the list agreed: the card turns to the pledge and says why.
    const sw = view('amounts', { mode: 'pledge', notice: 'not_partner' });
    assert.equal(sw.note, 'oaklandside.example isn\'t a ThankMu partner yet, so nothing was charged.');
    assert.equal(sw.line, PLEDGE_LINE);
});

test('the card offers no way into the app but Reload (the reload offer)', () => {
    // Every action id the card can show, and which of them opens a tab: only this one (the worker answers no other).
    const IN_CARD = new Set([ 'like', 'tip', 'share', 'amount', 'send', 'back', 'cancel', 'dismiss', 'undo' ]);
    const OPENS = new Set([ 'reload' ]);
    const states = [ 'ask', 'shared', 'liked', 'amounts', 'confirm', 'pending', 'done', 'reload', 'refused', 'dismissed', 'error' ];
    for ( const mode of [ 'tip', 'pledge' ] ) {
        for ( const state of states ) {
            for ( const over of [ {}, { paired: false }, { already: true }, { short: true, liked: true }, { balance: 10 }, { compact: true },
                                  { refusal: 'not_partner' }, { notice: 'not_partner' } ] ) {
                const v = view(state, { mode, amount: 50, error: 'invalid', refusal: 'blocked', ...over });
                for ( const a of [ ...v.actions, ...(v.noteAction ? [ v.noteAction ] : []) ] ) {
                    assert.ok(IN_CARD.has(a.id) || OPENS.has(a.id), `${mode} ${state} ${JSON.stringify(over)}: ${a.id}`);
                }
            }
        }
    }
    // After a tip or a pledge the card offers nothing that leaves the page.
    for ( const mode of [ 'tip', 'pledge' ] ) { assert.deepEqual(labels(view('done', { mode, amount: 50 })), []); }
});

test('C5: refusals on a pledge read as pledges; a blind retry is never sent', () => {
    assert.equal(view('error', { mode: 'pledge', error: 'amounts_changed' }).sub, 'The amounts changed. Pick one again.');
    assert.equal(view('error', { mode: 'pledge', error: 'velocity' }).sub, 'That\'s today\'s limit. Try again tomorrow.');
    assert.equal(view('error', { mode: 'tip', error: 'velocity' }).sub, 'That\'s your spending limit for today. Nothing was charged.');
    assert.equal(view('error', { error: 'unknown_retry' }).sub, 'We can\'t tell whether that went through. Check your wallet before you try again.');
    for ( const state of [ 'ask', 'liked', 'amounts', 'confirm', 'done', 'reload', 'refused', 'error' ] ) {
        assert.ok(!allText(view(state, { amount: 50, balance: 10, liked: true, refusal: 'blocked', error: 'invalid' })).includes('welcome credit'), state);
    }
});

test('C1: the page\'s hidden attribute and invisible ancestors mean "the page hid it"', () => {
    const viaAttr = el({ ad: true, none: true, hiddenAttr: true });
    const fromBlocker = el({ ad: true, none: true });
    const doc = fakeDoc(el({ tag: 'body' }, viaAttr, fromBlocker));
    // pageHidesFn's rule for the attribute, as a callback here.
    const found = A.findSlots(doc, { pageHides: n => n.hiddenAttr === true });
    assert.deepEqual(plain(found.map(f => f.anchor === fromBlocker)), [ true ]);
    const insideInvisible = el({ ad: true, w: 300, h: 250 });
    const invisible = el({ cls: 'invisible' }, insideInvisible);
    assert.deepEqual(plain(A.findSlots(fakeDoc(el({ tag: 'body' }, invisible)), { concealed: n => within(invisible, n) })), []);
    function within(outer, n) { for ( let x = n; x; x = x.parentElement ) { if ( x === outer ) { return true; } } return false; }
});

test('C1: with unreadable stylesheets, one card per sibling group of slots (responsive variants), fewer rather than duplicates', () => {
    // Three variants of one slot under one parent; the page shows one (a box) and hides two with CSS we can't read.
    const shown = el({ ad: true, w: 730, h: 140 }, el({ tag: 'div' }));
    const v1 = el({ ad: true, none: true });
    const v2 = el({ ad: true, none: true });
    const group = el({ tag: 'div' }, v1, shown, v2);
    const found = A.findSlots(fakeDoc(el({ tag: 'body' }, group)), { unreadable: () => true });
    assert.deepEqual(plain(found.map(f => f.anchor === shown)), [ true ]);
    // All variants hidden: still at most one card for the group.
    const h1 = el({ ad: true, none: true });
    const h2 = el({ ad: true, none: true });
    const g2 = el({ tag: 'div' }, h1, h2);
    assert.equal(A.findSlots(fakeDoc(el({ tag: 'body' }, g2)), { unreadable: () => true }).length, 1);
    // A sibling that merely contains slots (thestreet.com's <main>), or a 0 x 0 slot, is not a variant.
    const header = el({ ad: true, none: true });
    const wrap = el({ none: true }, header);
    const main = el({ tag: 'main', w: 606, h: 12000 }, el({ ad: true, w: 300, h: 250 }, el({ tag: 'iframe' })));
    const zero = el({ ad: true, w: 0, h: 0 });
    const page = A.findSlots(fakeDoc(el({ tag: 'body' }, zero, wrap, main)), { unreadable: () => true });
    assert.deepEqual(plain(page.map(f => f.anchor === wrap)), [ true ]);
    // With every stylesheet readable, the page's CSS decides and siblings are separate slots.
    assert.equal(A.findSlots(fakeDoc(el({ tag: 'body' }, el({ tag: 'div' }, el({ ad: true, none: true }), el({ ad: true, none: true }))))).length, 2);
});

test('placement B: the card goes over the empty box unless the layout would not let it line up', () => {
    const block = { display: 'block', paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' };
    const slot = { position: 'static', float: 'none' };
    const pr = { left: 0, right: 330 };
    const sr = { left: 4, right: 326, height: 300 };
    assert.equal(A.overlayFits(block, slot, pr, sr), true);
    assert.equal(A.overlayFits({ ...block, display: 'flex', flexDirection: 'column' }, slot, pr, sr), true);
    assert.equal(A.overlayFits({ ...block, display: 'flex', flexDirection: 'row' }, slot, pr, sr), false, 'a flex row');
    assert.equal(A.overlayFits({ ...block, display: 'flex' }, slot, pr, sr), false, 'flex defaults to a row');
    assert.equal(A.overlayFits({ ...block, display: 'grid' }, slot, pr, sr), false, 'a grid');
    assert.equal(A.overlayFits(block, { ...slot, float: 'left' }, pr, sr), false, 'a float');
    assert.equal(A.overlayFits(block, { ...slot, position: 'absolute' }, pr, sr), false, 'positioned');
    assert.equal(A.overlayFits(block, slot, { left: 0, right: 643 }, { left: 0, right: 730, height: 140 }), false, 'wider than the column');
    assert.equal(A.overlayFits({ ...block, paddingLeft: '20px' }, slot, pr, { left: 10, right: 300, height: 250 }), false, 'out into the padding');
    assert.equal(A.overlayFits(block, slot, pr, { ...sr, height: 0 }), false, 'no height');
    assert.equal(A.overlayFits(block, slot, pr, { ...sr, height: 1050 }), false, 'taller than any card');
});

test('placement B, review C3: a floated sibling over any part of the box keeps the card after the slot', () => {
    const block = { display: 'block', paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' };
    const slot = { position: 'static', float: 'none' };
    const pr = { left: 0, right: 700 };
    const sr = { left: 0, top: 100, right: 640, bottom: 240, height: 140 };
    // A float overlapping only the box's lower-right corner (its top-left is outside the box).
    assert.equal(A.overlayFits(block, slot, pr, sr, [ { left: 600, top: 200, right: 700, bottom: 400 } ]), false);
    // A float beside the box, touching but not overlapping: still fine.
    assert.equal(A.overlayFits(block, slot, pr, sr, [ { left: 640, top: 100, right: 700, bottom: 240 } ]), true);
    assert.equal(A.overlayFits(block, slot, pr, sr, []), true);
});

test('review C1 (round 3): only a definite answer clears the unresolved send', () => {
    for ( const r of [ { ok: true, kind: 'tip' }, { ok: true, kind: 'tip', replayed: true }, { ok: false, error: 'insufficient' },
                       { ok: false, error: 'velocity' }, { ok: false, error: 'none' }, { ok: false, error: 'unknown_retry' } ] ) {
        assert.equal(A.settlesUnresolved(r), true, JSON.stringify(r));
    }
    for ( const r of [ { ok: false, error: 'uncertain' }, { ok: false, error: 'pending', mode: 'tip', cents: 50 },
                       { ok: false, error: 'unavailable' }, { ok: false, error: 'gone' }, undefined, null ] ) {
        assert.equal(A.settlesUnresolved(r), false, JSON.stringify(r));
    }
});
