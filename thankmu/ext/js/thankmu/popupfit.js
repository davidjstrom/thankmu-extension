/*******************************************************************************

    ThankMu popup frame sizing (W-T1 part A follow-up). The switch page is framed
    into upstream's popup by the patch step with a starting height. Its text wraps
    at the popup's width and the dismissed-state line comes and goes, so no fixed
    height fits every state. The page sizes its own frame instead: it and the
    popup are the same extension origin, so it can reach its <iframe> element
    (window.frameElement) directly. Upstream's popup scripts and HTML stay as
    they are, and nothing new runs in the parent.

******************************************************************************/

export const MIN_HEIGHT = 24;
export const MAX_HEIGHT = 600;   // Chrome's own cap on a toolbar popup's height

// A usable frame height in whole px for a measured content height, or undefined for a non-number.
export function fitHeight(h) {
    if ( typeof h !== 'number' || Number.isNaN(h) ) { return undefined; }
    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h)));
}

export function fitFrame(frame, h) {
    const px = fitHeight(h);
    if ( !frame || px === undefined ) { return false; }
    frame.style.height = `${px}px`;
    return true;
}

// Size now, then on every change of the body's box (state changes, text wrapping, font load).
export function startFitting({ frame, body, Observer }) {
    if ( !frame ) { return; }
    const fit = ( ) => { fitFrame(frame, body.getBoundingClientRect().height); };
    fit();
    if ( typeof Observer === 'function' ) { new Observer(fit).observe(body); }
}

// Upstream's hostname row (#hostname, min-height 3 lines' worth) shows the whole host, wrapping as needed. One or two
// lines fit its min-height; a host long enough for three (about 140 characters at the popup's 520 px) would push the
// popup past Chrome's 600 px. The head frame caps it at two lines with an ellipsis, only then, and puts the whole host
// in the row's title. Inline style on that one element at run time: upstream's popup.html and CSS files are unchanged.
export const HOST_CLAMP = Object.freeze({
    'display': '-webkit-box',
    '-webkit-box-orient': 'vertical',
    '-webkit-box-pack': 'center',
    '-webkit-line-clamp': '2',
    'overflow': 'hidden',
});

export function capHostname(el, getStyle, Observer) {
    if ( !el || typeof getStyle !== 'function' ) { return; }
    let capped = false;
    const check = ( ) => {
        if ( capped ) { return; }
        const min = parseFloat(getStyle(el).minHeight);
        if ( Number.isFinite(min) === false || el.getBoundingClientRect().height <= min + 0.5 ) { return; }
        capped = true;
        el.title = el.textContent.replace(/\u00ad/g, '');
        for ( const [ k, v ] of Object.entries(HOST_CLAMP) ) { el.style.setProperty(k, v); }
    };
    check();
    if ( typeof Observer === 'function' ) { new Observer(check).observe(el); }
}

// The frame element when this page is framed by a same-origin page, else null.
export function ownFrame(win) {
    try { return win.frameElement ?? null; } catch { return null; }
}
