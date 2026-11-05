/*******************************************************************************

    ThankMu popup view (W-P6): pure helpers for the D2 popup (thankmu-popup.html),
    shared with the account page. No chrome.* here, so popupview.test.mjs
    covers it in node.

******************************************************************************/

// The balance, as the design handoff's Balance: always dollars and cents ("$26.75", "$0.50"), never points.
export function dollars(cents) {
    if ( Number.isSafeInteger(cents) === false ) { throw new Error('ThankMu dollars: cents must be an integer'); }
    return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The toolbar badge text as a blocked-request count, or null. Chrome hands back its own placeholder instead of the
// number unless the extension holds declarativeNetRequestFeedback (dev builds only), and an empty badge means none
// shown: only plain digits count, and 0 is not shown.
export function badgeCount(text) {
    if ( typeof text !== 'string' || /^[0-9]{1,7}$/.test(text) === false ) { return null; }
    const n = Number(text);
    return n > 0 ? n : null;
}

// Which body the popup shows: 'signedIn', 'pairing', 'signedOut', or 'unavailable' when the worker gave no usable
// answer (a paired reader must never be offered Sign in just because the worker did not reply).
export function bodyOf(st) {
    if ( st === null || typeof st !== 'object' || typeof st.paired !== 'boolean' ) { return 'unavailable'; }
    if ( st.paired === true ) { return 'signedIn'; }
    return st?.pairing === true ? 'pairing' : 'signedOut';
}

// The stat tiles that have real data, in the mockup's order. Missing data hides its tile (never a made-up 0).
export function statsOf(st, badge) {
    const out = [];
    if ( badge !== null && badge !== undefined ) { out.push({ id: 'here', value: String(badge), label: 'ads blocked here' }); }
    if ( st?.paired === true && Number.isSafeInteger(st.likes) ) {
        out.push({ id: 'likes', value: String(st.likes), label: 'likes' });
    }
    return out;
}

// "Your balance is too low to tip" (C5; was "Your welcome credit is used up"): the balance can no longer pay the smallest tip the card offers.
export function needsReload(st, amounts) {
    if ( st?.paired !== true || st.wallet === undefined ) { return false; }
    return st.wallet.balance_cents < Math.min(...amounts);
}

// Replies of the worker's handoff ('thankmu:open-account', 'thankmu:open-app') as reader text. Shared with the
// account page (account.js), which showed them first.
export const ACCOUNT_MESSAGES = Object.freeze({
    unavailable: 'Could not reach the app just now. Try again in a moment.',
    open_failed: 'Could not open a new tab.',
});

// Over an hour (the handoff budget is 30 per hour) says "later": the popup's longest message stays the one its height
// is tested with ("... Try again in 60 minutes.", tests/popup).
export const WAIT_MAX_MINUTES = 60;

export function waitText(seconds) {
    const minutes = typeof seconds === 'number' && seconds > 0 ? Math.ceil(seconds / 60) : undefined;
    if ( minutes === undefined || minutes > WAIT_MAX_MINUTES ) { return 'Too many attempts to open your account. Try again later.'; }
    return `Too many attempts to open your account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

export function accountErrorText(reply) {
    if ( reply?.error === 'rate_limited' ) { return waitText(reply.retryAfter); }
    return ACCOUNT_MESSAGES[reply?.error] || 'Could not open your account.';
}
