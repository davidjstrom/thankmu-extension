// Tests for the popup's view helpers (W-P6). Run: node --test thankmu/ext/js/thankmu/popupview.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dollars, badgeCount, bodyOf, statsOf, needsReload, accountErrorText, waitText, WAIT_MAX_MINUTES } from './popupview.js';
import { AMOUNTS_CENTS } from './tipjar.js';

test('dollars: always dollars and cents, en-US grouping (the handoff Balance)', () => {
    assert.equal(dollars(2675), '$26.75');
    assert.equal(dollars(675), '$6.75');
    assert.equal(dollars(50), '$0.50');
    assert.equal(dollars(0), '$0.00');
    assert.equal(dollars(100), '$1.00');
    assert.equal(dollars(123456789), '$1,234,567.89');
    assert.throws(() => dollars(1.5), /integer/);
    assert.throws(() => dollars('100'), /integer/);
});

test('badgeCount: plain digits only; Chrome\'s placeholder, empty, 0 and junk are hidden', () => {
    assert.equal(badgeCount('14'), 14);
    for (const t of [ '', '0', '<<declarativeNetRequestActionCount>>', '1k', ' 3', '-2', undefined, null, 4 ]) {
        assert.equal(badgeCount(t), null, String(t));
    }
});

test('bodyOf: signed in, pairing in progress, else signed out', () => {
    assert.equal(bodyOf({ paired: true, verified: false }), 'signedIn');
    assert.equal(bodyOf({ paired: false, pairing: true }), 'pairing');
    assert.equal(bodyOf({ paired: false, pairing: false }), 'signedOut');
    for (const st of [ undefined, null, {}, { paired: 'yes' }, 'x' ]) { assert.equal(bodyOf(st), 'unavailable', JSON.stringify(st)); }
});

test('statsOf: only tiles with real data, in the mockup order', () => {
    assert.deepEqual(statsOf({ paired: false }, null), []);
    assert.deepEqual(statsOf({ paired: false, likes: 3 }, 14), [{ id: 'here', value: '14', label: 'ads blocked here' }]);
    assert.deepEqual(statsOf({ paired: true, likes: 0 }, 14).map(t => t.id), [ 'here', 'likes' ]);
    assert.deepEqual(statsOf({ paired: true, verified: false }, null), [], 'no /me answer: no likes tile');
    assert.equal(statsOf({ paired: true, likes: 9 }, null)[0].label, 'likes');
});

test('needsReload: below the smallest tip the card offers, and only with a known balance', () => {
    const min = Math.min(...AMOUNTS_CENTS);
    assert.equal(needsReload({ paired: true, wallet: { balance_cents: min - 1, promotional_cents: 0 } }, AMOUNTS_CENTS), true);
    assert.equal(needsReload({ paired: true, wallet: { balance_cents: min, promotional_cents: 0 } }, AMOUNTS_CENTS), false);
    assert.equal(needsReload({ paired: true, verified: false }, AMOUNTS_CENTS), false);
    assert.equal(needsReload({ paired: false }, AMOUNTS_CENTS), false);
});

test('needsReload: a non-empty wallet that can pay a tip never shows Reload (E2E-02 step 7: $5, $37.50)', () => {
    for ( const cents of [ 500, 3750, 2675, 100, 25 ] ) {
        assert.equal(needsReload({ paired: true, verified: true, wallet: { balance_cents: cents, promotional_cents: cents } }, AMOUNTS_CENTS), false, String(cents));
    }
    assert.equal(needsReload({ paired: true, verified: true, wallet: { balance_cents: 0, promotional_cents: 0 } }, AMOUNTS_CENTS), true);
});

test('account error texts', () => {
    assert.equal(accountErrorText({ error: 'unavailable' }), 'Could not reach the app just now. Try again in a moment.');
    assert.equal(accountErrorText({ error: 'open_failed' }), 'Could not open a new tab.');
    assert.equal(accountErrorText({ error: 'rate_limited', retryAfter: 61 }), 'Too many attempts to open your account. Try again in 2 minutes.');
    assert.equal(accountErrorText({ error: 'rate_limited' }), waitText(undefined));
    assert.equal(accountErrorText(undefined), 'Could not open your account.');
});

test('waitText: at most "60 minutes", longer waits say later (the popup is height-tested with the 60-minute text)', () => {
    assert.equal(WAIT_MAX_MINUTES, 60);
    assert.equal(waitText(60), 'Too many attempts to open your account. Try again in 1 minute.');
    assert.equal(waitText(3600), 'Too many attempts to open your account. Try again in 60 minutes.');
    assert.equal(waitText(3601), 'Too many attempts to open your account. Try again later.');
    assert.equal(waitText(999999999), 'Too many attempts to open your account. Try again later.');
    assert.equal(waitText(0), 'Too many attempts to open your account. Try again later.');
});
