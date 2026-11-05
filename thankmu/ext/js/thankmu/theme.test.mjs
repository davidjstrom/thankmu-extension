// Tests for the extension pages' dark opt-in (W-P4 design handoff): .theme-dark follows the system, live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followSystemTheme } from './theme.js';

function fakeWin(dark) {
    const classes = new Set();
    const listeners = [];
    const mq = { matches: dark, addEventListener: (_, fn) => { listeners.push(fn); } };
    const win = {
        matchMedia: q => { assert.equal(q, '(prefers-color-scheme: dark)'); return mq; },
        document: { documentElement: { classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); } } } },
    };
    return { win, classes, flip: v => { mq.matches = v; listeners.forEach(fn => fn()); } };
}

test('a dark system opts the page into .theme-dark, and a light one does not', () => {
    const d = fakeWin(true); followSystemTheme(d.win);
    assert.deepEqual([ ...d.classes ], [ 'theme-dark' ]);
    const l = fakeWin(false); followSystemTheme(l.win);
    assert.deepEqual([ ...l.classes ], []);
});

test('it follows the system when it changes', () => {
    const t = fakeWin(false); followSystemTheme(t.win);
    t.flip(true); assert.ok(t.classes.has('theme-dark'));
    t.flip(false); assert.ok(!t.classes.has('theme-dark'));
});

test('no matchMedia: the page stays light and nothing throws', () => {
    followSystemTheme({ document: {} });
});
