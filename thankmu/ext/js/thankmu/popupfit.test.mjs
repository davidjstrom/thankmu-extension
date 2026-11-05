// Tests for the popup frame's self-sizing (W-T1 part A follow-up). Pure: the frame element and the observer are injected.
// Run: node --test thankmu/ext/js/thankmu/popupfit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitHeight, fitFrame, startFitting, capHostname, HOST_CLAMP, MIN_HEIGHT, MAX_HEIGHT } from './popupfit.js';

test('fitHeight rounds fractional content up so the last line is never clipped', () => {
    assert.equal(fitHeight(83.2), 84);
    assert.equal(fitHeight(100), 100);
});

test('fitHeight clamps absurd or invalid sizes', () => {
    assert.equal(fitHeight(0), MIN_HEIGHT);
    assert.equal(fitHeight(-5), MIN_HEIGHT);
    assert.equal(fitHeight(99999), MAX_HEIGHT);
    assert.equal(MAX_HEIGHT, 600, 'Chrome caps a toolbar popup at 600 px: a frame never needs more');
    assert.equal(fitHeight(NaN), undefined);
    assert.equal(fitHeight(undefined), undefined);
    assert.equal(fitHeight('40'), undefined);
});

test('fitFrame sets the parent iframe height in px, and reports whether it did', () => {
    const frame = { style: { height: '84px' } };
    assert.equal(fitFrame(frame, 120.4), true);
    assert.equal(frame.style.height, '121px');
});

test('fitFrame does nothing without a frame (page opened on its own) or with a bad height', () => {
    assert.equal(fitFrame(null, 100), false);
    const frame = { style: { height: '84px' } };
    assert.equal(fitFrame(frame, NaN), false);
    assert.equal(frame.style.height, '84px');
});

test('startFitting sizes now and on every observed change, from the body box', () => {
    const frame = { style: { height: '84px' } };
    let h = 60; let cb;
    const body = { getBoundingClientRect: () => ({ height: h }) };
    class FakeObserver { constructor(f) { cb = f; } observe(el) { this.el = el; } }
    startFitting({ frame, body, Observer: FakeObserver });
    assert.equal(frame.style.height, '60px');
    h = 97.5; cb();
    assert.equal(frame.style.height, '98px');
});

test('startFitting with no frame is a no-op and never throws', () => {
    assert.doesNotThrow(() => startFitting({ frame: null, body: {}, Observer: class {} }));
});

// A fake upstream #hostname: its height grows with the text, its min-height is 42 px.
function fakeHost(height, text = 'news.example') {
    const props = {};
    return { textContent: text, title: '', height, props,
        getBoundingClientRect() { return { height: this.height }; },
        style: { setProperty: (k, v) => { props[k] = v; } } };
}
const style = ( ) => ({ minHeight: '42px' });

test('capHostname leaves a host that fits upstream\'s row (one or two lines) alone', () => {
    const el = fakeHost(42);
    capHostname(el, style);
    assert.deepEqual(el.props, {});
    assert.equal(el.title, '');
});

test('capHostname caps a three-line host at two lines, with the whole host (no soft hyphen) as the title', () => {
    const el = fakeHost(51, 'news.\u00adlong.example');
    capHostname(el, style);
    assert.deepEqual(el.props, { ...HOST_CLAMP });
    assert.equal(el.title, 'news.long.example');
});

test('capHostname caps once the host arrives later (upstream fills the row after load), and only once', () => {
    const el = fakeHost(42); let cb;
    class FakeObserver { constructor(f) { cb = f; } observe() {} }
    capHostname(el, style, FakeObserver);
    assert.deepEqual(el.props, {});
    el.height = 60; cb();
    assert.equal(el.props['-webkit-line-clamp'], '2');
    el.props['-webkit-line-clamp'] = 'x'; el.height = 42; cb();
    assert.equal(el.props['-webkit-line-clamp'], 'x', 'applied once, never re-run on its own resize');
});

test('capHostname without the row or a style reader is a no-op', () => {
    assert.doesNotThrow(() => capHostname(null, style));
    assert.doesNotThrow(() => capHostname(fakeHost(99), undefined));
});
