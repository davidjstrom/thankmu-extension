/*******************************************************************************

    ThankMu ad-slot prompt (W-T1 part A): the content script, the whole
    in-page surface of ThankMu (ADR-013; upstream injects no UI). Two states
    (ADR-013 "In-page surfaces, by state", founder 2026-11-02):

    - Signed in with the tip jar on: where the blocker removed an ad, a soft,
      dismissable card in each emptied slot, sized to that slot: like first,
      then tip (founder-approved design D2, mockups src/plugin/AdSlot.tsx; one
      card per slot since E2E-02, founder 2026-11-01). All cards on a page
      share one state: a like, a tip or a dismiss in one shows in all.
    - Signed out: no card. Once the page has an emptied slot, one static
      corner pill, fixed to the viewport, outside any ad space; its one action
      opens the sign-up that returns to pairing. It makes no request to
      ThankMu, and neither does the worker on its behalf (tipjar.js gate).

    A classic script (manifest content scripts cannot be modules), top frame
    only, at document_idle. It adds one element per emptied slot (a
    <thankmu-card> host), or the one <thankmu-pill>, each with a closed
    shadow root, so the page's CSS cannot restyle it and its CSS cannot leak
    out. It never hides,
    moves or changes page content. It never opens the app on its own: the
    one hop is the reload offer, on the reader's click.

    It holds no token and makes no network request. Every decision and every
    app call happens in the service worker (tipjar.js), which takes the page
    address from the browser (the message sender), not from this script. This
    script sends the worker only the page's own title and byline, and only
    when the reader acts.

    Tests (adslot.test.mjs) run this file in a vm with __THANKMU_ADSLOT_TEST__
    set; it then exports its pure parts as ThankMuAdSlot instead of starting.

******************************************************************************/

(( ) => {
'use strict';

// The strategy doc's canonical strings, character for character (phase-4-thank-you-tip-jar.md §Working shape).
const PARTNER_LINE = 'Would you like to tip the publisher?';
const PLEDGE_LINE = 'Pledge a tip; they get it when they join ThankMu.';
const FROM = 'ThankMu · in place of an ad';

// Where ad slots live. A slot counts as blocked when the blocker hid it (cosmetic filtering: no layout box), or when
// it stayed empty (no child element) across two looks (its ad request was blocked). A slot showing an ad never counts.
const SLOT_SELECTORS = [
    'ins.adsbygoogle',
    '[id^="div-gpt-ad"]',
    '[id^="google_ads_iframe"]',
    '[data-google-query-id]',
    '[data-ad-slot]',
    '[data-ad-unit]',
    '[data-ad-unit-path]',
    '.ad-slot',
    '.adslot',
    '.ad-unit',
    '.ad-container',
    '[id^="ad-slot"]',
    '[id^="adslot"]',
];

// When to look for emptied slots, in ms after document_idle. Pages add slots as the reader scrolls, so the looks go
// on for a minute. An empty slot must be empty on two looks in a row (an ad that was only slow has arrived by then).
const LOOKS_MS = [ 1500, 5000, 10000, 15000, 20000, 30000, 40000, 50000, 60000 ];
const SEND_TIMEOUT_MS = 15000;
// How long the cards say "We can't tell whether that went through…" before they go, when the tip jar stops being on
// (switched off, signed out) with a send unresolved (review of MR !19).
const LEAVE_NOTICE_MS = 8000;
// Card sizes (deviation for the Designer, E2E-02): a slot narrower than MIN_CARD_WIDTH gets no card (unreadable);
// narrower than FULL_MIN_WIDTH, or shorter than FULL_MIN_HEIGHT (a banner), gets the compact card: no "from" line
// and no explanatory sub-line on the first ask, the rest unchanged. A card never gets shorter than its text.
const MIN_CARD_WIDTH = 160;
const FULL_MIN_WIDTH = 250;
const FULL_MIN_HEIGHT = 180;
const MAX_CARD_HEIGHT = 600;
// At most this many measure-and-correct steps to land a card on its box (two suffice; see place()).
const NUDGES = 4;

// --- strings ---------------------------------------------------------------------------------------

function money(cents) {
    if ( cents < 100 ) { return `${cents}¢`; }
    return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function balanceText(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}

const NOTICE_TEXT = {
    not_visible: ( ) => 'Scroll the card fully into view, then send.',
    // The app refused a tip because the publisher is not a partner (409 publisher_not_payable): nothing moved.
    not_partner: ctx => `${ctx.domain} isn't a ThankMu partner yet, so nothing was charged.`,
    now_partner: ctx => `${ctx.domain} just joined ThankMu, so this is a tip now.`,
};

// On a pledge (no money moves) some refusals read differently (C5, the Orchestrator under the founder's grant).
const PLEDGE_ERROR_TEXT = {
    amounts_changed: 'The amounts changed. Pick one again.',
    velocity: 'That\'s today\'s limit. Try again tomorrow.',
};

const ERROR_TEXT = {
    // A "Try again" after a send the worker has no record of (its 24 h record expired, or the browser restarted):
    // it never sends a new one blind.
    unknown_retry: 'We can\'t tell whether that went through. Check your wallet before you try again.',
    velocity: 'That\'s your spending limit for today. Nothing was charged.',
    rate_limited: 'Too many at once. Nothing was sent. Try again in a minute.',
    unavailable: 'Could not reach ThankMu just now. Try again in a moment.',
    amounts_changed: 'This version of ThankMu is out of date. Update it to tip.',
    invalid: 'Something went wrong. Try again.',
    copy_failed: 'Could not copy the link.',
};

// --- the card's states (a pure view model; render() turns it into DOM) ------------------------------
// ctx: { domain, mode: 'tip' | 'pledge', amounts, balance (cents or null when unknown), amount, liked, error,
//        notice, already, short (402), refusal ('blocked' | 'not_partner'), compact (this card is the small one) }

function view(state, ctx) {
    const v = fullView(state, ctx);
    if ( ctx.compact === true ) {
        v.from = undefined;
        if ( state === 'ask' || state === 'shared' ) { v.sub = undefined; }
        v.actions = v.actions.filter(a => a.id !== 'share');
    }
    return v;
}

function fullView(state, ctx) {
    const tip = ctx.mode === 'tip';
    const amounts = ctx.amounts ?? [];
    const v = { from: FROM, line: undefined, heartLine: false, sub: undefined, actions: [], dismiss: true };
    const noticeText = ( ) => (ctx.notice && NOTICE_TEXT[ctx.notice] ? NOTICE_TEXT[ctx.notice](ctx) : undefined);
    const like = { id: 'like', label: 'Like', kind: 'primary', heart: true };
    const give = { id: 'tip', label: tip ? 'Tip' : 'Pledge a tip', kind: 'btn' };
    const notNow = { id: 'dismiss', label: 'Not now', kind: 'link' };
    const known = typeof ctx.balance === 'number';
    const amountButtons = ( ) => amounts.map(c => ({
        id: 'amount', label: money(c), kind: 'amount', cents: c, pressed: ctx.amount === c,
        disabled: tip && known && c > ctx.balance,
    }));
    const lowNote = ( ) => {
        if ( tip && known && amounts.length && ctx.balance < amounts[amounts.length - 1] ) {
            v.note = `Your wallet has ${balanceText(ctx.balance)}.`;
            v.noteAction = { id: 'reload', label: 'Reload', kind: 'link' };
        }
    };
    const shown = ctx.amount ?? amounts[0];
    switch ( state ) {
    case 'ask':
        v.line = tip ? PARTNER_LINE : PLEDGE_LINE;
        v.sub = `${ctx.domain}. A like is free; your ad blocker keeps working either way.`;
        v.actions = [ like, give, { id: 'share', label: 'Share', kind: 'link' } ];
        break;
    case 'shared':
        v.line = 'Link copied.';
        v.sub = `Sharing helps ${ctx.domain} too.`;
        v.actions = [ like, give ];
        break;
    case 'liked':
        v.line = 'Liked.';
        v.heartLine = true;
        v.sub = tip ? 'Add a tip?' : PLEDGE_LINE;
        v.actions = [ ...amountButtons(), notNow ];
        lowNote();
        break;
    case 'amounts':
        v.line = tip ? `Tip ${ctx.domain}` : PLEDGE_LINE;
        if ( tip ) { v.sub = 'Choose an amount.'; }
        v.actions = [ ...amountButtons(), notNow ];
        lowNote();
        if ( ctx.notice ) { v.note = noticeText(); v.noteAction = undefined; }
        break;
    case 'confirm':
        if ( tip ) {
            v.line = `Tip ${ctx.domain} ${money(shown)}?`;
            v.sub = 'From your ThankMu wallet.';
            v.actions = [ { id: 'send', label: `Send ${money(shown)} tip`, kind: 'primary', money: true } ];
        } else {
            v.line = `Pledge a ${money(shown)} tip to ${ctx.domain}?`;
            v.sub = 'Nothing is charged now. When they join ThankMu, we\'ll ask you once before it\'s sent. If they haven\'t joined in 12 months, it lapses.';
            v.actions = [ { id: 'send', label: `Pledge ${money(shown)}`, kind: 'primary', money: true } ];
        }
        v.actions.push({ id: 'back', label: 'Back', kind: 'link' });
        if ( ctx.notice ) { v.note = noticeText(); }
        break;
    case 'pending':
        // An earlier send of this tip had no definite answer. Only that same tip can be retried (the worker resends
        // its key, so the app replays it if it landed); no other amount until it is settled.
        v.line = `Your ${money(shown)} ${tip ? 'tip' : 'pledge'} may not have gone through.`;
        v.sub = `Try again. If it did go through, ${tip ? 'you won\'t be charged twice' : 'it won\'t be pledged twice'}.`;
        v.actions = [ { id: 'send', label: 'Try again', kind: 'primary', money: true }, { id: 'cancel', label: 'Cancel', kind: 'link' } ];
        if ( ctx.notice ) { v.note = noticeText(); }
        break;
    case 'done':
        // The outcome, in place. A pledge is called a pledge: no money moved (E2E-02: a pledge read as a tip). No
        // link into the app: the card never opens it except for the reload offer.
        v.heartLine = true;
        if ( ctx.already ) {
            v.line = tip ? 'Tip sent.' : 'Pledged.';
            v.sub = `Your earlier ${tip ? 'tip' : 'pledge'} went through.`;
        } else if ( tip ) {
            v.line = 'Tip sent.';
            v.sub = `${money(shown)} to ${ctx.domain}, from your wallet.`;
        } else {
            v.line = 'Pledged.';
            v.sub = `${money(shown)} for ${ctx.domain}. Nothing was charged; we'll ask you once when they join ThankMu.`;
        }
        break;
    case 'reload':
        v.heartLine = ctx.liked === true;
        if ( ctx.short ) {
            // The app refused the tip: 402, the wallet can't cover it.
            v.line = `${ctx.liked ? 'Liked. ' : ''}Not enough in your wallet for this tip.`;
            v.sub = 'Nothing was charged. Reload your wallet to keep tipping.';
        } else {
            // C5: never "welcome credit" (an account may never have had one).
            v.line = `${ctx.liked ? 'Liked. ' : ''}Your balance is too low to tip.`;
            v.sub = 'Reload your wallet to keep tipping. Your first reload comes with a bonus.';
        }
        v.actions = [ { id: 'reload', label: 'Reload', kind: 'primary' }, notNow ];
        break;
    case 'refused':
        // A definite refusal shown in place (E2E-02): the publisher blocked ThankMu, or can't take tips.
        if ( ctx.refusal === 'blocked' ) {
            v.line = `${ctx.domain} isn't taking likes or tips through ThankMu.`;
            v.sub = 'Nothing was sent.';
        } else {
            v.line = `${ctx.domain} can't take tips through ThankMu yet.`;
            v.sub = 'Nothing was charged.';
        }
        break;
    case 'dismissed':
        v.from = undefined;
        v.dismiss = false;
        v.sub = `Hidden on ${ctx.domain} for today.`;
        v.actions = [ { id: 'undo', label: 'Undo', kind: 'link' } ];
        break;
    case 'error':
        v.sub = (tip ? undefined : PLEDGE_ERROR_TEXT[ctx.error]) ?? ERROR_TEXT[ctx.error] ?? ERROR_TEXT.invalid;
        v.actions = [ { id: 'back', label: 'Back', kind: 'link' } ];
        break;
    default:
        throw new Error(`ThankMu card: unknown state ${state}`);
    }
    return v;
}

// --- finding the emptied slots ----------------------------------------------------------------------

function hasBox(el) {
    return el.getClientRects().length !== 0;
}

function tagOf(el) {
    return String(el.tagName ?? '').toLowerCase();
}

function within(outer, el) {
    for ( let n = el; n; n = n.parentElement ) { if ( n === outer ) { return true; } }
    return false;
}

// What an ad leaves in its slot when it renders. A slot holding none of these and no text is empty, however many
// wrapper elements it has (E2E-02: thestreet.com's slots are an empty <div> inside the slot <div>).
const CONTENT_TAGS = new Set([ 'iframe', 'img', 'video', 'embed', 'object', 'canvas', 'picture', 'svg', 'a', 'ins' ]);

// Not content: the ad tag's own <script> (the standard GPT slot is <div id="div-gpt-ad-…"><script>…</script></div>).
const INERT_TAGS = new Set([ 'script', 'style', 'noscript', 'template' ]);

// The text a reader could see in el: text nodes outside INERT_TAGS.
function shownText(el) {
    if ( el.childNodes === undefined ) { return String(el.textContent ?? ''); }
    let out = '';
    for ( const n of el.childNodes ) {
        if ( n.nodeType === 3 ) { out += n.data ?? n.textContent ?? ''; } else if ( n.nodeType === 1 && INERT_TAGS.has(tagOf(n)) === false ) { out += shownText(n); }
    }
    return out;
}

function isEmptySlot(el) {
    if ( shownText(el).trim() !== '' ) { return false; }
    const stack = [ ...(el.children ?? []) ];
    while ( stack.length ) {
        const c = stack.pop();
        if ( INERT_TAGS.has(tagOf(c)) ) { continue; }
        if ( CONTENT_TAGS.has(tagOf(c)) ) { return false; }
        stack.push(...(c.children ?? []));
    }
    return true;
}

// Every emptied slot on the page, in document order: [{ anchor, el, kind }]. The card goes right after `anchor`: for
// a hidden slot, its outermost hidden wrapper below <body> (so the card shows where the ad's box was); for an empty
// one, the slot. Nested matches are one slot (the outermost). Not a slot:
//   - a slot the page hides itself: pageHides(el) true for it or a hidden wrapper (its own CSS or the hidden
//     attribute; responsive variants of one ad, E2E-02: thestreet.com hides two of every three in-content slots with
//     its own breakpoint CSS). The blocker's cosmetic CSS may hide a wrapper as well as the slot (thestreet.com's
//     header: `.header-ad-slot`), so a hidden wrapper counts as the page's only when the page's CSS explains it;
//   - a slot under an ancestor the page made invisible (concealed(el): computed visibility hidden; the blocker hides
//     with display:none, never with visibility);
//   - when some of the page's stylesheets can't be read (unreadable() true; another origin), a hidden slot next to a
//     shown or already-taken slot under the same parent: likely a responsive variant, so fewer cards rather than
//     duplicates (at most one card per such sibling group);
//   - a slot inside a fixed-position container (interstitials, sticky footers: the card would float over the page);
//   - an empty slot with no box size at all (0 x 0: out-of-page slots);
//   - a slot showing an ad.
function findSlots(doc, { pageHides = ( ) => false, isFixed = ( ) => false, concealed = ( ) => false,
                          unreadable = ( ) => false } = {}) {
    const out = [];
    const all = doc.querySelectorAll(SLOT_SELECTORS.join(','));
    const matched = new Set(all);
    const taken = el => out.some(s => within(s.anchor, el) || within(el, s.anchor));
    // A hidden candidate's sibling group: another slot element directly under the same parent that is shown with a
    // real size (a responsive variant the page shows), or already has a card. Only slot elements themselves count:
    // on thestreet.com the blocker-hidden header wrapper sits beside <main>, which merely contains slots, and beside a
    // 0 x 0 out-of-page slot.
    const groupHasOther = a => {
        for ( const sib of a.parentElement?.children ?? [] ) {
            if ( sib === a ) { continue; }
            if ( out.some(s => s.anchor === sib) ) { return true; }
            if ( matched.has(sib) && hasBox(sib) ) {
                const r = sib.getBoundingClientRect();
                if ( r.width > 0 && r.height > 0 ) { return true; }
            }
        }
        return false;
    };
    for ( const el of all ) {
        if ( taken(el) ) { continue; }
        if ( hasBox(el) === false ) {
            let a = el;
            while ( a.parentElement && a.parentElement !== doc.body && a.parentElement !== doc.documentElement &&
                    hasBox(a.parentElement) === false ) {
                a = a.parentElement;
            }
            if ( a === doc.body || a === doc.documentElement || a.parentElement === null ) { continue; }
            if ( hasBox(a.parentElement) === false ) { continue; }   // the page itself is hidden
            let own = false;
            for ( let n = el; n && own === false; n = n === a ? null : n.parentElement ) { own = pageHides(n) === true; }
            if ( own || isFixed(a) || taken(a) || concealed(a.parentElement) ) { continue; }
            if ( unreadable() && groupHasOther(a) ) { continue; }
            out.push({ anchor: a, el, kind: 'hidden' });
            continue;
        }
        // Empty: nothing an ad would leave. Publishers often reserve the slot's size in CSS, so a sized empty box
        // counts too; start() requires it to be still empty on the next look, after a slow ad would have arrived.
        const r = el.getBoundingClientRect();
        if ( isEmptySlot(el) && (r.width > 0 || r.height > 0) && isFixed(el) === false && concealed(el) === false ) {
            out.push({ anchor: el, el, kind: 'empty' });
        }
    }
    return out;
}

// The first emptied slot, or null (kept for the tests of the single-slot rules).
function findSlot(doc, opts) {
    return findSlots(doc, opts)[0] ?? null;
}

// px from a computed length ("300px"), else null ("auto", "100%", "").
function px(v) {
    const m = /^([0-9]+(?:\.[0-9]+)?)px$/.exec(String(v ?? '').trim());
    return m ? Number(m[1]) : null;
}

// The size of the card for a slot: { width, minHeight, compact } or null for none. slot: what the page reserved
// ({ width, height } in px or null: the box for an empty slot, the computed CSS for a hidden one); room: the width
// the card's parent offers. Width: the slot's, never wider than the room; unknown, the room up to the D2 card's
// 300 px. Height: a hidden slot's reserved height is filled (an empty slot still takes its own space on the page, so
// its card adds none). Compact below FULL_MIN_WIDTH wide or FULL_MIN_HEIGHT tall; none below MIN_CARD_WIDTH.
function cardSize(slot, room, kind) {
    const roomW = typeof room === 'number' && room > 0 ? room : null;
    let width = typeof slot?.width === 'number' && slot.width > 0 ? slot.width : null;
    if ( width === null ) { width = roomW === null ? null : Math.min(roomW, 300); }
    if ( width !== null && roomW !== null ) { width = Math.min(width, roomW); }
    if ( width === null || width < MIN_CARD_WIDTH ) { return null; }
    const height = typeof slot?.height === 'number' && slot.height > 0 ? slot.height : null;
    const compact = width < FULL_MIN_WIDTH || (height !== null && height < FULL_MIN_HEIGHT);
    const minHeight = kind === 'hidden' && height !== null ? Math.min(height, MAX_CARD_HEIGHT) : null;
    return { width: Math.floor(width), minHeight: minHeight === null ? null : Math.floor(minHeight), compact };
}

// --- page metadata (sent only with an action) -------------------------------------------------------

function metaContent(doc, attr, name) {
    const v = doc.querySelector(`meta[${attr}="${name}"]`)?.getAttribute('content');
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function looksLikeUrl(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

function ldAuthor(node, depth = 0) {
    if ( node === null || typeof node !== 'object' || depth > 4 ) { return undefined; }
    if ( Array.isArray(node) ) {
        for ( const n of node ) { const a = ldAuthor(n, depth + 1); if ( a ) { return a; } }
        return undefined;
    }
    const author = node.author;
    if ( typeof author === 'string' && looksLikeUrl(author) === false ) { return author; }
    const first = Array.isArray(author) ? author[0] : author;
    if ( first && typeof first.name === 'string' ) { return first.name; }
    return ldAuthor(node['@graph'], depth + 1);
}

function readMeta(doc) {
    const out = {};
    const title = metaContent(doc, 'property', 'og:title') ?? metaContent(doc, 'name', 'twitter:title') ??
        (typeof doc.title === 'string' && doc.title.trim() !== '' ? doc.title.trim() : undefined);
    if ( title !== undefined ) { out.title = title; }
    let author = metaContent(doc, 'name', 'author') ?? metaContent(doc, 'property', 'article:author');
    if ( author !== undefined && looksLikeUrl(author) ) { author = undefined; }
    if ( author === undefined ) {
        for ( const s of doc.querySelectorAll('script[type="application/ld+json"]') ) {
            let data;
            try { data = JSON.parse(s.textContent); } catch { continue; }
            author = ldAuthor(data);
            if ( author ) { break; }
        }
    }
    if ( typeof author === 'string' && author.trim() !== '' ) { out.author = author.trim(); }
    return out;
}

// Send moves money. It is armed only once the card in its current state has been visible, without a break, for
// ARM_MS, and never by the 2nd or 3rd click of a multi-click: Send appears where the amount button was, so a
// double-click on an amount must not become a tip. 'not_visible': the card says why instead of doing nothing.
const ARM_MS = 500;

function sendAllowed({ now, shownAt, visibleSince, detail }) {
    if ( detail > 1 ) { return 'ignore'; }
    if ( visibleSince === null ) { return 'not_visible'; }
    return now - Math.max(shownAt, visibleSince) >= ARM_MS ? 'ok' : 'ignore';
}

// Amount buttons lead to the confirm state; the extra clicks of a double-click on them count for nothing.
function clickCounts(a, detail) {
    return !(a.id === 'amount' && detail > 1);
}

// Can the card be laid over an empty slot's box (placement B)? parent / slot: computed styles; rects: their boxes;
// floats: the boxes of the slot's floated siblings.
// No when the parent lays its children out side by side (a flex row, a grid: a negative margin would not move the
// card onto the box), when the slot floats or is positioned (it is not in the flow the card follows), when the box is
// wider than the parent's content (the card could not cover it), or when it has no height or is taller than the
// tallest card.
function overlayFits(parent, slot, parentRect, slotRect, floats = []) {
    const d = String(parent.display ?? '');
    if ( /grid/.test(d) ) { return false; }
    if ( /flex/.test(d) && /^column/.test(String(parent.flexDirection ?? 'row')) === false ) { return false; }
    if ( (slot.float ?? 'none') !== 'none' || /^(absolute|fixed|sticky)$/.test(String(slot.position ?? 'static')) ) { return false; }
    const left = parentRect.left + (px(parent.borderLeftWidth) ?? 0) + (px(parent.paddingLeft) ?? 0);
    const right = parentRect.right - (px(parent.borderRightWidth) ?? 0) - (px(parent.paddingRight) ?? 0);
    if ( slotRect.left < left - 1 || slotRect.right > right + 1 ) { return false; }
    // A floated sibling over any part of the box: the card would cover it (review C3; a whole-rect check).
    if ( floats.some(f => intersects(f, slotRect)) ) { return false; }
    return slotRect.height >= 1 && slotRect.height <= MAX_CARD_HEIGHT;
}

function intersects(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// Does this worker answer settle the cards' unresolved send (review C1, round 3)? Only a definite one: success, a
// refusal, or the worker's word that it has no record ('none', 'unknown_retry'). Not 'uncertain' or 'pending' (still
// open), nor 'unavailable' or 'gone' (no answer at all: the earlier send may still land, and the next tap must ask).
const INDEFINITE = new Set([ 'uncertain', 'pending', 'unavailable', 'gone' ]);

function settlesUnresolved(r) {
    if ( r === null || typeof r !== 'object' ) { return false; }
    return r.ok === true || (r.ok === false && typeof r.error === 'string' && INDEFINITE.has(r.error) === false);
}

// --- the signed-out corner pill: its words and where it may sit -------------------------------------

// At most four words, beside the D1 glyph (round 13). Its labels carry the attribution and say what it opens.
const PILL_TEXT = 'Turn on tip jar';
const PILL_LABEL = 'ThankMu: turn on your tip jar. Opens sign-in and sign-up in a new tab.';
const PILL_HIDE_LABEL = 'Hide ThankMu on this site for today';
const PILL_MARGIN = 16;
// Below this viewport width the pill shows only where nothing at all is under it (round 13).
const PILL_NARROW = 320;

// The D1 mark (thankmu/icon.svg: plate, mark, coin; adslot.test.mjs checks the geometry), coloured by classes the
// pill's CSS paints with tokens, never a literal colour.
// Built with createElementNS in the page (no markup parsing); GLYPH_SVG is the same as text, for the tests.
const GLYPH_ROOT = { class: 'tm-glyph', viewBox: '0 0 128 128', 'aria-hidden': 'true', focusable: 'false' };
const GLYPH_PARTS = [
    [ 'rect', { class: 'tm-g-bg', x: '0', y: '0', width: '128', height: '128', rx: '28', ry: '28' } ],
    [ 'path', { class: 'tm-g-fg', d: 'M37 50 V110 M37 66 A22 22 0 0 0 81 66 M81 50 V84 Q81 94 91 94', fill: 'none',
        'stroke-width': '15', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } ],
    [ 'circle', { class: 'tm-g-coin', cx: '59', cy: '29', r: '11' } ],
];
const attrText = a => Object.entries(a).map(([ k, v ]) => `${k}="${v}"`).join(' ');
const GLYPH_SVG = `<svg ${attrText(GLYPH_ROOT)}>${GLYPH_PARTS.map(([ t, a ]) => `<${t} ${attrText(a)}/>`).join('')}</svg>`;

const CONTROL_TAGS = new Set([ 'a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'details', 'video', 'audio', 'iframe', 'embed', 'object' ]);
const CONTROL_ROLES = new Set([ 'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'textbox', 'combobox', 'slider', 'searchbox', 'dialog' ]);

// Is el (or what it sits in) something the reader uses: a link, a form control, a button, anything in the tab order
// or clickable by attribute, or part of a fixed or sticky widget (a chat bubble, a cookie bar, a toolbar)?
// positionOf(el): its computed position (injected so tests run without a DOM).
function isPageControl(el, positionOf) {
    for ( let n = el; n && n.nodeType === 1; n = n.parentElement ) {
        const tag = tagOf(n);
        if ( tag === 'body' || tag === 'html' ) { break; }
        if ( CONTROL_TAGS.has(tag) ) { return true; }
        const role = n.getAttribute('role');
        if ( role && CONTROL_ROLES.has(role.trim().toLowerCase()) ) { return true; }
        if ( n.hasAttribute('tabindex') && Number(n.getAttribute('tabindex')) >= 0 ) { return true; }
        if ( n.hasAttribute('onclick') ) { return true; }
        if ( n.hasAttribute('contenteditable') && n.getAttribute('contenteditable') !== 'false' ) { return true; }
        const pos = positionOf(n);
        if ( pos === 'fixed' || pos === 'sticky' ) { return true; }
    }
    return false;
}

// Where the pill goes: bottom-right, else bottom-left, never over a page control; under PILL_NARROW px wide, only
// where it covers nothing at all. covers(rect) answers 'none' | 'content' | 'control'. null: not shown.
// prefer: the corner it is in now, probed first, so a re-check on a page where it is fine costs one corner.
function pillPlacement(viewport, size, covers, prefer = 'right') {
    const top = viewport.height - PILL_MARGIN - size.height;
    const narrow = viewport.width < PILL_NARROW;
    const corners = [ [ 'right', viewport.width - PILL_MARGIN - size.width ], [ 'left', PILL_MARGIN ] ];
    if ( prefer === 'left' ) { corners.reverse(); }
    for ( const [ corner, left ] of corners ) {
        const rect = { left, top, width: size.width, height: size.height, right: left + size.width, bottom: top + size.height };
        if ( left < 0 || top < 0 ) { continue; }
        const c = covers(rect);
        if ( narrow ? c === 'none' : c !== 'control' ) { return { corner, left, top }; }
    }
    return null;
}

// Which of this look's slots get a card now: a hidden slot at once, an empty one only when the previous look saw the
// same element empty too; never one that already has a card. Returns { ready, empties } (empties: for the next look).
function readyToShow(found, prevEmpties, shownAnchors) {
    const ready = [];
    for ( const s of found ) {
        if ( shownAnchors.has(s.anchor) ) { continue; }
        if ( s.kind === 'hidden' || prevEmpties.has(s.el) ) { ready.push(s); }
    }
    return { ready, empties: new Set(found.filter(s => s.kind === 'empty').map(s => s.el)) };
}

const api = { PARTNER_LINE, ARM_MS, sendAllowed, clickCounts, PLEDGE_LINE, SLOT_SELECTORS, view, findSlot, findSlots, isEmptySlot,
    cardSize, px, readyToShow, overlayFits, settlesUnresolved, LOOKS_MS, SEND_TIMEOUT_MS, MIN_CARD_WIDTH, readMeta, money, balanceText,
    PILL_TEXT, PILL_LABEL, PILL_HIDE_LABEL, GLYPH_SVG, pillPlacement, isPageControl };

if ( globalThis.__THANKMU_ADSLOT_TEST__ === true ) {
    globalThis.ThankMuAdSlot = api;
    return;
}
if ( typeof chrome !== 'object' || typeof chrome?.runtime?.id !== 'string' ) { return; }
if ( typeof window === 'undefined' || window.top !== window ) { return; }
if ( location.protocol !== 'https:' && location.protocol !== 'http:' ) { return; }

// --- in the page ------------------------------------------------------------------------------------

// The design tokens (css/thankmu-tokens.css, the handoff's file unchanged) arrive as a string from the generated
// js/thankmu/tokens-css.js, loaded just before this script: the patch step scopes their :root to .tm-slot, so the
// values sit on the card's own element inside the closed shadow root, out of reach of the page's CSS and of its
// custom properties. Nothing here names a literal colour: var(--name) only (tests/run.sh checks that).
const CARD_CSS = `
:host { all: initial; }
.tm-slot {
  font-family: var(--font-sans);
  color: var(--text); background: var(--white); border: 2px solid var(--brand-plate); border-radius: 0.9rem;
  padding: 0.75rem 0.9rem; display: flex; flex-direction: column; gap: 0.6rem; font-size: 16px; line-height: 1.4;
  text-align: left; position: relative; box-sizing: border-box; width: 300px; max-width: 100%;
}
.tm-slot * { box-sizing: border-box; }
.tm-slot.dismissed { border-style: dashed; border-color: var(--line); }
.tm-slot.compact { padding: 0.5rem 0.75rem; gap: 0.4rem; justify-content: center; }
.tm-from { display: flex; align-items: center; gap: 0.4em; font-size: 0.8em; color: var(--muted); padding-right: 2.6em; }
.tm-line { margin: 0; font-weight: 700; font-size: 1.05em; padding-right: 2.2em; }
.tm-sub { margin: 0; color: var(--muted); font-size: 0.9em; }
.tm-actions { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; }
.tm-btn { font: inherit; font-weight: 700; min-height: 44px; padding: 0.35em 1em; border-radius: 999px; cursor: pointer;
  border: 2px solid var(--brand-plate); background: var(--white); color: var(--brand-plate);
  display: inline-flex; align-items: center; gap: 0.35em; }
.tm-btn.primary, .tm-btn.amount[aria-pressed="true"] { background: var(--brand-plate); color: var(--brand-glyph); }
.tm-btn:focus-visible, .tm-x:focus-visible, .tm-link:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.tm-link { font: inherit; background: none; border: 0; padding: 0.35em 0.2em; min-height: 44px; color: var(--brand-plate);
  text-decoration: underline; cursor: pointer; }
.tm-link.inline { min-height: 0; padding: 0; }
.tm-x { position: absolute; top: 0.3rem; right: 0.3rem; width: 44px; height: 44px; border: 0; background: none;
  border-radius: 999px; font: inherit; font-size: 1.4em; line-height: 1; color: var(--muted); cursor: pointer; }
.tm-heart { color: var(--heart); }
.tm-btn.primary .tm-heart { color: var(--brand-glyph); }
.tm-btn:disabled, .tm-link:disabled { opacity: 0.45; cursor: not-allowed; }
`;

// A card without its tokens would be unstyled, so it is not shown at all.
const TOKENS_CSS = globalThis.ThankMuTokensCss;
if ( typeof TOKENS_CSS !== 'string' || TOKENS_CSS === '' ) {
    console.error('ThankMu: design tokens missing; the card is not shown');
    return;
}
const CSS = `${TOKENS_CSS}\n${CARD_CSS}`;

const HOST_STYLE = [
    [ 'all', 'initial' ], [ 'display', 'block' ], [ 'margin', '12px auto' ], [ 'width', 'fit-content' ],
    [ 'max-width', '100%' ], [ 'position', 'static' ], [ 'opacity', '1' ], [ 'visibility', 'visible' ],
    [ 'transform', 'none' ], [ 'filter', 'none' ], [ 'clip-path', 'none' ], [ 'pointer-events', 'auto' ],
];

function newKey() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}

// onTimeout: what no answer means. For a tip or pledge it is 'uncertain' (the worker may have sent it).
async function send(what, extra = {}, onTimeout = 'unavailable') {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(( ) => resolve({ ok: false, error: onTimeout }), SEND_TIMEOUT_MS); });
    try {
        return await Promise.race([ chrome.runtime.sendMessage({ ...extra, what }), timeout ]) ?? { ok: false, error: onTimeout };
    } catch {
        // The extension was reloaded or updated under this page: its card is dead.
        return { ok: false, error: 'gone' };
    } finally {
        clearTimeout(timer);
    }
}

// Is the card what the reader sees? A page can restyle our host element (it lives in the page's DOM) or cover it.
// Chrome's IntersectionObserver v2 reports occlusion and effects; elsewhere fall back to opacity and visibility.
// Returns a function giving the time since which the card has been continuously visible, or null when it isn't.
function makeVisibilityGuard(host) {
    let visibleSince = null;
    let v2 = false;
    try {
        const io = new IntersectionObserver(entries => {
            for ( const e of entries ) {
                if ( typeof e.isVisible !== 'boolean' ) { continue; }
                v2 = true;
                if ( e.isVisible === false ) { visibleSince = null; } else if ( visibleSince === null ) { visibleSince = performance.now(); }
            }
        }, { trackVisibility: true, delay: 100 });
        io.observe(host);
    } catch { /* no v2: fall back below */ }
    return ( ) => {
        if ( host.isConnected === false ) { return null; }
        if ( v2 ) { return visibleSince; }
        for ( let n = host; n && n.nodeType === 1; n = n.parentElement ) {
            const cs = getComputedStyle(n);
            if ( Number(cs.opacity) < 0.9 || cs.visibility !== 'visible' ) { return null; }
        }
        return 0;   // no occlusion signal: visible as far as we can tell; the state's own ARM_MS still applies
    };
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if ( cls ) { e.className = cls; }
    if ( text !== undefined ) { e.textContent = text; }
    return e;
}

function heart() {
    const h = el('span', 'tm-heart', '♥');
    h.setAttribute('aria-hidden', 'true');
    return h;
}

// The page's own CSS hides an element: the hidden attribute, an inline display:none, or a display:none rule in a
// stylesheet the page can read (document.styleSheets and document.adoptedStyleSheets). The blocker's cosmetic filters
// are injected by the browser and are in neither, so a slot hidden by them is never explained here. Cross-origin
// sheets can't be read: unreadable() then says so, and findSlots shows fewer cards (its sibling-group rule).
// Built lazily, on the first slot that needs it, and once per look.
function pageHidesFn() {
    let selectors = null;
    let unreadable = 0;
    const build = ( ) => {
        selectors = [];
        const walk = rules => {
            for ( const r of rules ) {
                if ( r.media && r.cssRules ) { if ( matchMedia(r.media.mediaText).matches ) { walk(r.cssRules); } continue; }
                if ( r.cssRules && typeof r.selectorText !== 'string' ) { walk(r.cssRules); continue; }
                if ( typeof r.selectorText === 'string' && r.style?.getPropertyValue('display') === 'none' ) { selectors.push(r.selectorText); }
            }
        };
        for ( const ss of [ ...document.styleSheets, ...(document.adoptedStyleSheets ?? []) ] ) {
            if ( ss.disabled ) { continue; }
            if ( ss.media?.mediaText && matchMedia(ss.media.mediaText).matches === false ) { continue; }
            try { walk(ss.cssRules); } catch { unreadable++; }
        }
    };
    const hides = el => {
        if ( el.hasAttribute?.('hidden') || el.style?.display === 'none' ) { return true; }
        if ( selectors === null ) { build(); }
        for ( const sel of selectors ) {
            try { if ( el.matches(sel) ) { return true; } } catch { /* a selector this engine rejects */ }
        }
        return false;
    };
    hides.unreadable = ( ) => { if ( selectors === null ) { build(); } return unreadable > 0; };
    return hides;
}

// The page made the element invisible without removing its box (visibility is inherited, so this covers ancestors).
function concealed(el) {
    return el instanceof Element && getComputedStyle(el).visibility !== 'visible';
}

function isFixed(el) {
    for ( let n = el; n && n !== document.documentElement; n = n.parentElement ) {
        if ( getComputedStyle(n).position === 'fixed' ) { return true; }
    }
    return false;
}

// What the page reserved for a slot: an empty slot's box; a hidden slot's computed CSS size (the browser still
// computes a hidden element's declared lengths) on the slot or its hidden wrappers, the first in px.
function slotBox(found) {
    if ( found.kind === 'empty' ) {
        const r = found.el.getBoundingClientRect();
        return { width: r.width, height: r.height };
    }
    let width = null;
    let height = null;
    for ( let n = found.el; n; n = n === found.anchor ? null : n.parentElement ) {
        const cs = getComputedStyle(n);
        width ??= px(cs.width);
        height ??= px(cs.height) ?? px(cs.minHeight);
    }
    return { width, height };
}

// The shared state of every card on the page, and one view per card. Acting in any card changes the state, and
// every card shows it (founder, E2E-02: "once per ad block", one state).
function createCards(initial, { onSignedOut }) {
    const views = [];
    const ctx = { ...initial, balance: null, amount: null, liked: false, error: null, notice: null, already: false,
        short: false, refusal: null, unresolved: null };
    // ctx.unresolved: { mode, cents } of the last send with no definite answer (review C1). While set, any send on
    // this page goes as a retry (the same key, or the outcome learnt since), and offering a tip first asks the worker
    // what became of it, so Cancel never leads to a second, fresh tip.
    let state = 'ask';
    let busy = false;
    let likeKey = newKey();
    let shownAt = 0;

    function add(found) {
        const host = document.createElement('thankmu-card');
        for ( const [ k, v ] of HOST_STYLE ) { host.style.setProperty(k, v, 'important'); }
        const root = host.attachShadow({ mode: 'closed' });
        const style = el('style');
        style.textContent = CSS;
        const card = el('aside', 'tm-slot');
        card.setAttribute('aria-label', 'ThankMu');
        card.setAttribute('aria-live', 'polite');
        root.append(style, card);
        found.anchor.after(host);

        const room = host.parentElement?.getBoundingClientRect().width;
        const size = cardSize(slotBox(found), room, found.kind);
        if ( size !== null ) {
            card.style.setProperty('width', `${size.width}px`);
            if ( size.minHeight !== null ) { card.style.setProperty('min-height', `${size.minHeight}px`); }
        }
        const box = host.getBoundingClientRect();
        const cs = getComputedStyle(host);
        if ( size === null || hasBox(host) === false || box.width < MIN_CARD_WIDTH || cs.display === 'none' ||
             cs.visibility !== 'visible' ) {
            host.remove();   // too small, or a filter or the page's layout hides it: show nothing rather than half a card
            return false;
        }
        const v = { host, card, found, size, compact: size.compact, visibleSince: makeVisibilityGuard(host) };
        views.push(v);
        renderOne(v);
        place(v);
        // The page restyling or moving our host is tampering: take that card down. (Our own placement changes are
        // taken out of the record before the observer could see them.)
        v.mo = new MutationObserver(( ) => { remove(v); });
        v.mo.observe(host, { attributes: true });
        return true;
    }

    // Placement (Q-20261101-1039-W-T1, answer B): an empty slot keeps the box the page reserved, so the card is laid
    // over that box: a negative top margin and a left margin on OUR host only, the card at least as tall as the box.
    // Where that cannot line up (overlayFits says no, or the card did not land on the box) the card stays after the
    // slot (A). Hidden slots have no box left: the card simply takes their place.
    function place(v) {
        const host = v.host;
        const reset = ( ) => {
            host.style.setProperty('margin', '12px auto', 'important');
            if ( v.size.minHeight === null ) { v.card.style.removeProperty('min-height'); } else { v.card.style.setProperty('min-height', `${v.size.minHeight}px`); }
            v.over = false;
            unwatch(v);
        };
        reset();
        if ( v.found.kind !== 'empty' ) { v.mo?.takeRecords(); return; }
        const slot = v.found.anchor;
        const parent = host.parentElement;
        const floats = parent ? [ ...parent.children ].filter(c => c !== slot && c !== host &&
            getComputedStyle(c).float !== 'none').map(c => c.getBoundingClientRect()) : [];
        const fits = v.noOverlay !== true && parent && overlayFits(getComputedStyle(parent), getComputedStyle(slot),
            parent.getBoundingClientRect(), slot.getBoundingClientRect(), floats);
        if ( fits ) {
            const sr = slot.getBoundingClientRect();
            v.card.style.setProperty('min-height', `${Math.min(Math.round(sr.height), MAX_CARD_HEIGHT)}px`);
            // Our top margin collapses with the slot's bottom margin (CSS 2 §8.3.1): the gap the host lands at is
            // their sum when the slot's margin is positive, the more negative of the two when it is negative, and
            // no collapse at all where the slot is not a block (an inline-block slot). Rather than model each case,
            // measure where the host landed and correct by the miss: once our margin is negative (and the more
            // negative one) the host moves 1 px per px of it, so the first step gets there or into that range and
            // the second lands it; NUDGES bounds the loop and the landing check below still decides.
            // No collapse-blocking style on the host helps: flow-root, a border or padding stop collapsing with a
            // box's children, not with its siblings, and relative offsets leave the card's flow space as a hole.
            // The slot is re-measured at every step (review of MR !18): the page can move it while we place, by
            // scroll anchoring once the reader has scrolled past it, or by a column flex parent re-centring its
            // children; a position read once would chase a stale box.
            let top = px(getComputedStyle(host).marginTop) ?? 0;
            let left = px(getComputedStyle(host).marginLeft) ?? 0;
            let after = host.getBoundingClientRect();
            let box = slot.getBoundingClientRect();
            for ( let i = 0; i < NUDGES; i++ ) {
                const dy = after.top - box.top, dx = after.left - box.left;
                if ( Math.abs(dy) <= 0.5 && Math.abs(dx) <= 0.5 ) { break; }
                top -= dy; left -= dx;
                host.style.setProperty('margin', `${top}px 0 0 ${left}px`, 'important');
                after = host.getBoundingClientRect();
                box = slot.getBoundingClientRect();
            }
            v.over = Math.abs(after.top - box.top) <= 1 && Math.abs(after.left - box.left) <= 1 &&
                Math.abs(box.width - sr.width) <= 1 && Math.abs(box.height - sr.height) <= 1 && box.height <= MAX_CARD_HEIGHT;
            if ( v.over === false ) { reset(); } else { watch(v, box); }
        }
        v.mo?.takeRecords();
    }

    // Review B2 (ADR-013): a covered box must stay empty and the same size. The moment the page puts anything in
    // it (a lazy ad, a house promo, upstream's "no filtering" mode letting an ad through) or resizes it, the card
    // leaves the box for good and sits after the slot (A).
    function watch(v, box) {
        unwatch(v);
        const slot = v.found.anchor;
        const check = ( ) => {
            if ( v.over !== true ) { return; }
            const r = slot.getBoundingClientRect();
            const same = Math.abs(r.width - box.width) <= 1 && Math.abs(r.height - box.height) <= 1;
            if ( slot.isConnected && same && isEmptySlot(slot) ) { return; }
            uncover(v);
        };
        v.watchers = [ new MutationObserver(check), new ResizeObserver(check) ];
        v.watchers[0].observe(slot, { childList: true, subtree: true, attributes: true, characterData: true });
        v.watchers[1].observe(slot);
    }

    function unwatch(v) {
        for ( const w of v.watchers ?? [] ) { w.disconnect(); }
        v.watchers = undefined;
    }

    function uncover(v) {
        v.noOverlay = true;
        unwatch(v);
        place(v);
    }

    // Re-place on resize (the slot's box can move or change size with the layout).
    let resizeTimer;
    window.addEventListener('resize', ( ) => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(( ) => { for ( const v of views ) { place(v); } }, 200);
    });

    function remove(v) {
        unwatch(v);
        v.host.remove();
        const i = views.indexOf(v);
        if ( i !== -1 ) { views.splice(i, 1); }
    }

    function removeAll() {
        for ( const v of [ ...views ] ) { remove(v); }
    }

    function renderOne(v) {
        const m = view(state, { ...ctx, compact: v.compact });
        const card = v.card;
        card.className = `tm-slot${state === 'dismissed' ? ' dismissed' : ''}${v.compact ? ' compact' : ''}`;
        card.replaceChildren();
        if ( m.from ) { card.append(el('div', 'tm-from', m.from)); }
        const text = el('div', 'tm-text');
        if ( m.line ) {
            const p = el('p', 'tm-line');
            if ( m.heartLine ) { p.append(heart(), ' '); }
            p.append(m.line);
            text.append(p);
        }
        if ( m.sub ) { text.append(el('p', 'tm-sub', m.sub)); }
        card.append(text);
        if ( m.actions.length ) {
            const row = el('div', 'tm-actions');
            if ( m.actions.some(a => a.kind === 'amount') ) {
                row.setAttribute('role', 'group');
                row.setAttribute('aria-label', ctx.mode === 'tip' ? 'Tip amount' : 'Pledged tip amount');
            }
            for ( const a of m.actions ) { row.append(button(a, v)); }
            card.append(row);
        }
        if ( m.note ) {
            const p = el('p', 'tm-sub', `${m.note} `);
            if ( m.noteAction ) { const b = button(m.noteAction, v); b.classList.add('inline'); p.append(b); }
            card.append(p);
        }
        if ( m.dismiss ) {
            const x = el('button', 'tm-x', '×');
            x.type = 'button';
            x.setAttribute('aria-label', 'Not now. Hide on this site for today');
            x.addEventListener('click', ev => act(ev, { id: 'dismiss' }, v));
            card.append(x);
        }
    }

    function render() {
        for ( const v of views ) { renderOne(v); }
    }

    function button(a, v) {
        const cls = a.kind === 'link' ? 'tm-link' : `tm-btn${a.kind === 'primary' ? ' primary' : ''}${a.kind === 'amount' ? ' amount' : ''}`;
        const b = el('button', cls);
        b.type = 'button';
        if ( a.heart ) { b.append(heart(), ' '); }
        b.append(a.label);
        if ( a.kind === 'amount' ) { b.setAttribute('aria-pressed', String(a.pressed === true)); }
        b.disabled = busy || a.disabled === true;
        b.addEventListener('click', ev => act(ev, a, v));
        return b;
    }

    function go(next) {
        if ( next !== state ) { shownAt = performance.now(); ctx.notice = null; }
        state = next;
        // Dismissed: the cards stop covering anything (and stop watching), as if each stood after its slot.
        if ( state === 'dismissed' ) { for ( const v of views ) { if ( v.over ) { uncover(v); } } }
        render();
    }

    async function withBusy(work) {
        busy = true; render();
        try { return await work(); } finally { busy = false; }
    }

    async function loadBalance() {
        const r = await send('thankmu:slot-balance');
        ctx.balance = r?.ok === true ? r.balance_cents : null;
        if ( r?.error === 'unpaired' || r?.error === 'off' ) { signedOut(); }
    }

    // The token was revoked (a 401) or the reader signed out: back to signed-out behaviour at once. The cards go and
    // nothing more is sent; start() asks the worker again, which answers the pill.
    function signedOut() {
        leave().then(onSignedOut);
    }

    // The tip jar is no longer on here (signed out, revoked, or switched off). With a send still unresolved, the
    // cards first say so for a moment (the worker keeps its key: nothing is settled); then they go. Resolves when gone.
    let leaving = null;
    function leave() {
        if ( leaving !== null ) { return leaving; }
        leaving = (async ( ) => {
            if ( ctx.unresolved !== null && views.length > 0 ) {
                ctx.error = 'unknown_retry';
                go('error');
                await sleep(LEAVE_NOTICE_MS);
            }
            removeAll();
        })();
        return leaving;
    }

    // Before offering a tip again after an unresolved one: what became of it? Landed: the card says so (tipped, or
    // pledged) instead of offering a fresh one. Still open: back to "may not have gone through". Gone (no record):
    // a fresh tip is honest. Returns true when it moved the card.
    async function settleUnresolved() {
        const u = ctx.unresolved;
        if ( u === null ) { return false; }
        const r = await withBusy(( ) => send('thankmu:slot-give', { mode: u.mode, cents: u.cents, peek: true }));
        if ( r?.ok === true ) {
            ctx.unresolved = null;
            ctx.mode = u.mode;
            ctx.amount = u.cents;
            ctx.already = true;
            go('done');
            return true;
        }
        if ( r?.error === 'pending' ) {
            ctx.mode = r.mode;
            ctx.amount = r.cents;
            go('pending');
            return true;
        }
        if ( settlesUnresolved(r) ) { ctx.unresolved = null; }
        return false;
    }

    const broke = ( ) => ctx.mode === 'tip' && typeof ctx.balance === 'number' && ctx.balance < Math.min(...ctx.amounts);

    // Every answer ends in a state shown in place; nothing here opens the app.
    function failed(r) {
        switch ( r?.error ) {
        case 'gone':
            // The extension was reloaded or updated under this page: its cards are dead.
            removeAll();
            return;
        case 'blocked':
        case 'not_partner':
            ctx.refusal = r.error;
            return go('refused');
        case 'unpaired':
        case 'off':
            // Signed out, or the tip jar switched off since the cards were drawn: they go, and nothing is sent.
            return signedOut();
        case 'changed': {
            const was = ctx.mode;
            ctx.mode = r.mode;
            ctx.amount = null;
            go('amounts');
            ctx.notice = was === 'tip' ? 'not_partner' : 'now_partner';
            return render();
        }
        case 'insufficient':
            ctx.balance = null;
            ctx.short = true;
            return go('reload');
        case 'uncertain':
            ctx.unresolved = { mode: ctx.mode, cents: ctx.amount };
            return go('pending');
        case 'pending':
            // An earlier send of another amount is unresolved: only that one may be retried.
            ctx.mode = r.mode;
            ctx.amount = r.cents;
            ctx.unresolved = { mode: r.mode, cents: r.cents };
            return go('pending');
        case 'already_sent':
            ctx.already = true;
            return go('done');
        default:
            ctx.error = ERROR_TEXT[r?.error] ? r.error : 'unavailable';
            return go('error');
        }
    }

    async function act(ev, a, v) {
        // Only the reader's own clicks: a page cannot reach into the closed shadow root, but never trust a synthetic event.
        if ( ev.isTrusted !== true || busy || clickCounts(a, ev.detail) === false ) { return; }
        if ( a.money ) {
            // Armed by the clicked card's own visibility: another card being on screen arms nothing here.
            const verdict = sendAllowed({ now: performance.now(), shownAt, visibleSince: v.visibleSince(), detail: ev.detail });
            if ( verdict === 'not_visible' ) { ctx.notice = 'not_visible'; renderOne(v); }
            if ( verdict !== 'ok' ) { return; }
        }
        switch ( a.id ) {
        case 'like': {
            const r = await withBusy(( ) => send('thankmu:slot-like', { key: likeKey, meta: readMeta(document) }));
            if ( r?.ok !== true ) { return failed(r); }
            ctx.liked = true;
            if ( await settleUnresolved() ) { return; }
            if ( ctx.mode === 'tip' ) { await withBusy(loadBalance); }
            return go(broke() ? 'reload' : 'liked');
        }
        case 'tip':
            if ( await settleUnresolved() ) { return; }
            if ( ctx.mode === 'tip' ) { await withBusy(loadBalance); }
            return go(broke() ? 'reload' : 'amounts');
        case 'share':
            try {
                await navigator.clipboard.writeText(location.href);
                return go('shared');
            } catch {
                ctx.error = 'copy_failed';
                return go('error');
            }
        case 'amount':
            ctx.amount = a.cents;
            ctx.already = false;
            ctx.short = false;
            return go('confirm');
        case 'cancel':
            // The unresolved one stays pending in the worker; trying any tip here brings this choice back.
            return go('ask');
        case 'back':
            ctx.error = null;
            return go(state === 'error' ? 'ask' : (ctx.liked ? 'liked' : 'amounts'));
        case 'send': {
            // No definite answer within SEND_TIMEOUT_MS: the worker may still send; treat it as uncertain.
            // From the pending state this is "Try again": the worker resends the unresolved one or reports what it
            // learnt since; it never mints a new key for it.
            const r = await withBusy(( ) => send('thankmu:slot-give', {
                mode: ctx.mode, cents: ctx.amount, meta: readMeta(document), retry: state === 'pending' || ctx.unresolved !== null,
            }, 'uncertain'));
            if ( settlesUnresolved(r) ) { ctx.unresolved = null; }
            if ( r?.ok !== true ) { return failed(r); }
            ctx.already = r.replayed === true;
            return go('done');
        }
        case 'reload': {
            // The card's one hop into the app, on this click: the handoff to /wallet/topup.
            const r = await send('thankmu:slot-reload');
            if ( r?.ok === true && r.opened === 'pairing' ) { return signedOut(); }
            if ( r?.ok !== true ) { return failed(r); }
            return;
        }
        case 'dismiss': {
            const r = await send('thankmu:slot-dismiss');
            if ( r?.ok !== true ) { return failed(r); }
            return go('dismissed');
        }
        case 'undo': {
            const r = await send('thankmu:slot-undismiss');
            if ( r?.ok !== true ) { return failed(r); }
            likeKey = ctx.liked ? likeKey : newKey();
            return go('ask');
        }
        }
    }

    // New slots join while the cards are still on offer; not once the reader dismissed them or ThankMu is refused.
    const open = ( ) => state !== 'dismissed' && state !== 'refused';
    return { add, open, leave, count: ( ) => views.length, dismissed: ( ) => state === 'dismissed' };
}

// --- the signed-out corner pill -------------------------------------------------------------------

// Static: drawn from this file and the tokens, nothing fetched. Fixed to the viewport, so it moves nothing on the page;
// it never sits in an ad slot and never over a page control (pillPlacement), and it is hidden while one is under it.
const PLACE_MS = 150;
// More changed elements than this in one batch: just re-check (cheaper than reading every rectangle).
const MUTATION_CHECK_MAX = 40;

const PILL_CSS = `
:host { all: initial; }
.tm-slot { font-family: var(--font-sans); font-size: medium; line-height: 1.3; color: var(--text); }
.tm-pill { display: flex; align-items: center; background: var(--white); border: 2px solid var(--brand-plate);
  border-radius: 999px; box-shadow: 0 2px 10px var(--shadow); max-width: calc(100vw - 32px); box-sizing: border-box; }
.tm-go, .tm-px { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; min-height: 44px; min-width: 44px; }
.tm-go { display: inline-flex; align-items: center; gap: 0.5em; padding: 0.3em 0.4em 0.3em 0.5em; font-weight: 700;
  border-radius: 999px; text-align: left; }
.tm-px { border-radius: 999px; font-size: 1.25em; line-height: 1; color: var(--muted); padding: 0 0.4em; }
.tm-go:focus-visible, .tm-px:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.tm-glyph { width: 1.75em; height: 1.75em; flex: none; }
.tm-g-bg { fill: var(--brand-plate); }
.tm-g-fg { stroke: var(--brand-glyph); }
.tm-g-coin { fill: var(--sun); }
`;

const PROBE_STEP = 8;

const PILL_HOST_STYLE = [
    [ 'all', 'initial' ], [ 'display', 'block' ], [ 'position', 'fixed' ], [ 'z-index', '2147483646' ], [ 'margin', '0' ],
    [ 'opacity', '1' ], [ 'visibility', 'visible' ], [ 'transform', 'none' ], [ 'filter', 'none' ], [ 'clip-path', 'none' ],
    [ 'pointer-events', 'auto' ], [ 'left', `${PILL_MARGIN}px` ], [ 'top', `${PILL_MARGIN}px` ],
];

// What a rect of the viewport would cover: 'control', 'content', or 'none' (only the page's root boxes, or our own).
// cache: element -> isPageControl, shared by every point of one place() (most points hit the same few elements).
function coversAt(rect, own, cache = new Map()) {
    // A grid every PROBE_STEP px plus the edges, so a control smaller than the pill (a 16 px icon button) is still hit.
    const grid = (a, b) => {
        const out = [];
        for ( let v = a + 1; v < b - 1; v += PROBE_STEP ) { out.push(v); }
        out.push(b - 1);
        return out;
    };
    const xs = grid(rect.left, rect.right);
    const ys = grid(rect.top, rect.bottom);
    const positionOf = n => getComputedStyle(n).position;
    let out = 'none';
    for ( const x of xs ) {
        for ( const y of ys ) {
            for ( const e of document.elementsFromPoint(x, y) ) {
                if ( e === own || e === document.documentElement || e === document.body ) { continue; }
                if ( e.tagName === 'THANKMU-CARD' || e.tagName === 'THANKMU-PILL' ) { continue; }
                let control = cache.get(e);
                if ( control === undefined ) { control = isPageControl(e, positionOf); cache.set(e, control); }
                if ( control ) { return 'control'; }
                out = 'content';
            }
        }
    }
    return out;
}

function createPill({ onRemoved }) {
    // Timings for tests/popup/signedout_e2e.mjs only: a page that carries <meta name="thankmu-perf"> gets
    // performance.measure entries for each placement and each observer batch. Off everywhere else.
    const perf = document.querySelector('meta[name="thankmu-perf"]') !== null;
    const host = document.createElement('thankmu-pill');
    for ( const [ k, v ] of PILL_HOST_STYLE ) { host.style.setProperty(k, v, 'important'); }
    host.setAttribute('title', 'ThankMu');
    const root = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = `${TOKENS_CSS}\n${PILL_CSS}`;
    const wrap = el('div', 'tm-slot tm-pill');
    wrap.setAttribute('role', 'complementary');
    wrap.setAttribute('aria-label', 'ThankMu');
    const go = el('button', 'tm-go');
    go.type = 'button';
    go.setAttribute('aria-label', PILL_LABEL);
    go.title = PILL_LABEL;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs) => {
        const e = document.createElementNS(NS, tag);
        for ( const [ k, v ] of Object.entries(attrs) ) { e.setAttribute(k, v); }
        return e;
    };
    const glyph = svg('svg', GLYPH_ROOT);
    for ( const [ tag, attrs ] of GLYPH_PARTS ) { glyph.append(svg(tag, attrs)); }
    go.append(glyph, el('span', '', PILL_TEXT));
    const x = el('button', 'tm-px', '×');
    x.type = 'button';
    x.setAttribute('aria-label', PILL_HIDE_LABEL);
    x.title = PILL_HIDE_LABEL;
    wrap.append(go, x);
    root.append(style, wrap);
    // Hidden until placed: it never shows, even for a frame, over a control.
    host.style.setProperty('visibility', 'hidden', 'important');
    document.documentElement.append(host);

    let gone = false;
    function remove() {
        if ( gone ) { return; }
        gone = true;
        clearTimeout(timer);
        host.remove();
        onRemoved();
        removeEventListener('resize', force);
        removeEventListener('scroll', force, true);
        mo?.disconnect();
        ro?.disconnect();
    }

    // Place it, or hide it while every corner would cover a page control (pages move things as they scroll).
    let corner = 'right';
    let shown = false;
    function place() {
        if ( gone ) { return; }
        const t0 = perf ? performance.now() : 0;
        const r = host.getBoundingClientRect();
        const cache = new Map();
        const spot = pillPlacement({ width: document.documentElement.clientWidth, height: innerHeight },
            { width: r.width, height: r.height }, rect => coversAt(rect, host, cache), corner);
        if ( spot === null ) {
            shown = false;
            host.style.setProperty('visibility', 'hidden', 'important');
        } else {
            shown = true;
            corner = spot.corner;
            host.style.setProperty('left', `${spot.left}px`, 'important');
            host.style.setProperty('top', `${spot.top}px`, 'important');
            host.style.setProperty('visibility', 'visible', 'important');
        }
        if ( perf ) { performance.measure('thankmu-pill-place', { start: t0, end: performance.now() }); }
    }
    // Throttled, not debounced: a page that changes all the time still gets re-checked, at most every PLACE_MS, and
    // when the browser is idle where it can say so. pending: the elements changed since the last check (null: none
    // recorded, so a scroll or resize: place at once); overflow: too many to check one by one.
    let timer = null;
    let pending = null;
    let overflow = false;
    let forced = false;        // scroll or resize: the page moved under the pill, so place it whatever changed
    const force = ( ) => { forced = true; schedule(); };
    function schedule() {
        if ( timer !== null || gone ) { return; }
        timer = setTimeout(( ) => {
            const run = ( ) => { timer = null; settle(); };
            if ( typeof requestIdleCallback === 'function' ) { requestIdleCallback(run, { timeout: PLACE_MS * 4 }); } else { run(); }
        }, PLACE_MS);
    }
    function settle() {
        const changed = pending;
        const many = overflow || forced;
        pending = null;
        overflow = false;
        forced = false;
        if ( changed === null || many || relevant(changed) ) { place(); }
    }
    // Does what the page changed matter to the pill? Only an element in the band along the bottom where its two
    // corners are (added, moved or restyled there), or anything while it is hidden (room may have opened up). A ticker
    // or a feed changing elsewhere costs one rectangle read per changed element, read when the browser is idle.
    function relevant(changed) {
        if ( shown === false ) { return true; }
        const t0 = perf ? performance.now() : 0;
        const r = host.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const band = { left: 0, right: vw, top: innerHeight - r.height - 3 * PILL_MARGIN, bottom: innerHeight };
        const w = r.width + 2 * PILL_MARGIN;
        const zones = [ { ...band, right: w }, { ...band, left: vw - w } ];
        let hit = false;
        for ( const node of changed ) {
            // Gone again already (a ticker's previous items): nothing there to cover. A widget that left only frees room,
            // and the pill stays where it is fine; when it is hidden every change re-places it (above).
            if ( node.isConnected === false ) { continue; }
            const b = node.getBoundingClientRect();
            if ( zones.some(z => intersects(b, z)) ) { hit = true; break; }
        }
        if ( perf ) { performance.measure('thankmu-pill-check', { start: t0, end: performance.now() }); }
        return hit;
    }
    // The observer itself only notes what changed (no layout read here); the check waits for schedule().
    function onMutations(records) {
        const t0 = perf ? performance.now() : 0;
        pending ??= new Set();
        for ( const rec of records ) {
            for ( const node of [ rec.target, ...rec.addedNodes ] ) {
                if ( node.nodeType !== 1 ) { continue; }
                if ( pending.size >= MUTATION_CHECK_MAX ) { overflow = true; break; }
                pending.add(node);
            }
        }
        schedule();
        if ( perf ) { performance.measure('thankmu-pill-observe', { start: t0, end: performance.now() }); }
    }
    addEventListener('resize', force);
    addEventListener('scroll', force, true);
    // Widgets the page adds or moves later (a chat bubble, a cookie bar): body-level and cheap; the pill itself lives
    // under <html>, outside what is observed, so placing it never triggers another look.
    let mo = null;
    let ro = null;
    try {
        mo = new MutationObserver(onMutations);
        mo.observe(document.body ?? document.documentElement, { childList: true, subtree: true, attributes: true,
            attributeFilter: [ 'style', 'class', 'hidden' ] });
        ro = new ResizeObserver(force);
        ro.observe(document.documentElement);
    } catch { /* no observers: scroll and resize still re-place it */ }

    go.addEventListener('click', async ev => {
        if ( ev.isTrusted !== true ) { return; }
        const r = await send('thankmu:slot-signup');
        if ( r?.error === 'gone' ) { remove(); }
    });
    x.addEventListener('click', async ev => {
        if ( ev.isTrusted !== true ) { return; }
        remove();
        await send('thankmu:slot-pill-dismiss');
    });

    place();
    return { remove };
}

// One run per state: a sign-in (pill -> cards) or a sign-out (cards -> pill) starts a new one and ends the old.
let run = 0;
let pill = null;
let cardsNow = null;

// The state changed somewhere else (the popup's switch, Sign out, a pairing, a 401 in another tab): ask the gate
// again, storage only, and follow it at once. Only the key names are looked at, never the values.
let regating = false;
let regateAgain = false;
async function regate() {
    // A change while a re-check runs is not dropped: it runs once more after (a pairing writes the token, then clears
    // the off switch, as two storage events).
    if ( regating ) { regateAgain = true; return; }
    regating = true;
    try {
        const g = await send('thankmu:slot-gate');
        if ( g?.error === 'gone' ) { return; }
        if ( pill !== null && g?.pill !== true ) { pill.remove(); }
        if ( cardsNow !== null && g?.go !== true && cardsNow.dismissed() === false ) {
            const leaving = cardsNow;
            cardsNow = null;
            run++;                     // ends the scan that owned them
            await leaving.leave();
        }
        if ( pill === null && cardsNow === null && (g?.go === true || g?.pill === true) ) { start(); }
    } finally {
        regating = false;
    }
    if ( regateAgain ) {
        regateAgain = false;
        regate();
    }
}
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if ( area === 'local' && ('thankmu.prompts.off' in changes || 'thankmu.token' in changes) ) { regate(); }
    });
} catch { /* no storage events: coming back to the tab still re-asks */ }
document.addEventListener('visibilitychange', ( ) => { if ( document.visibilityState === 'visible' ) { regate(); } });

async function start() {
    const mine = ++run;
    // Storage only, no network, in every state (tipjar.js gate); no scan at all when it says neither.
    const gate = await send('thankmu:slot-gate');
    if ( mine !== run ) { return; }
    if ( gate?.go !== true && gate?.pill !== true ) { return; }
    let cards = null;
    let prev = new Set();
    const used = new Set();   // anchors already given a card (or refused one): never a second card per slot
    let at = 0;
    for ( const t of LOOKS_MS ) {
        await sleep(t - at);
        at = t;
        if ( mine !== run ) { return; }
        if ( cards !== null && cards.open() === false ) { return; }
        const pageHides = pageHidesFn();
        const found = findSlots(document, { pageHides, isFixed, concealed, unreadable: pageHides.unreadable });
        const { ready, empties } = readyToShow(found, prev, used);
        prev = empties;
        if ( ready.length === 0 ) { continue; }
        if ( gate.pill === true ) {
            // Signed out: the page has an emptied slot, so the one pill, and nothing more on this run.
            if ( pill === null ) { pill = createPill({ onRemoved: ( ) => { pill = null; } }); }
            return;
        }
        if ( cards === null ) {
            const r = await send('thankmu:slot-check');
            if ( r?.show !== true || mine !== run ) { return; }
            cards = createCards({ domain: r.domain, mode: r.mode, amounts: r.amounts }, {
                onSignedOut: ( ) => { if ( cardsNow === cards ) { cardsNow = null; } start(); } });
            cardsNow = cards;
        }
        for ( const s of ready ) {
            used.add(s.anchor);
            if ( s.anchor.isConnected ) { cards.add(s); }
        }
    }
}

start().catch(e => { console.error(`thankmu: ad-slot card disabled on this page: ${e?.message || e}`); });

})();
