/*******************************************************************************

    ThankMu account page (W-P3 part B): the pairing screen. All state lives in
    the service worker (sw.js); this page only shows it and sends
    'thankmu:<action>' messages. It never sees the token.

******************************************************************************/

import { followSystemTheme } from './theme.js';
import { accountErrorText } from './popupview.js';

followSystemTheme();

const $ = id => document.getElementById(id);

function show(id) {
    for ( const s of [ 'loading', 'unpaired', 'paired' ] ) { $(s).hidden = s !== id; }
}

function showError(text) {
    $('error').textContent = text || '';
    $('error').hidden = !text;
}

// The worker bounds its own app calls (pairing.js API_TIMEOUT_MS); this is a backstop so the page never waits forever.
const SEND_TIMEOUT_MS = 15000;

async function ask(what, extra = {}) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(( ) => reject(new Error('timed out')), SEND_TIMEOUT_MS); });
    try {
        return await Promise.race([ chrome.runtime.sendMessage({ ...extra, what }), timeout ]);
    } finally {
        clearTimeout(timer);
    }
}

async function send(what) {
    const reply = await ask(what);
    if ( reply && reply.ok === false ) { throw new Error(reply.error || 'failed'); }
    return reply;
}

// Latest wins: renders run concurrently and only the newest one paints, so one slow status call can
// never hold back the ones after it.
let generation = 0;
async function render() {
    const mine = ++generation;
    try {
        const st = await send('thankmu:status');
        if ( mine !== generation ) { return; }
        $('revoked').hidden = !(st.paired === false && st.revoked === true);
        $('unverified').hidden = !(st.paired && st.verified === false);
        show(st.paired ? 'paired' : 'unpaired');
        $('myAccount').hidden = false;
        if ( accountBusy === false ) { showError(''); }
    } catch (e) {
        if ( mine !== generation ) { return; }
        showError(`Could not read the connection state: ${e.message}`);
    }
}

// "Settings" (W-A12 handoff, D2 naming; E2E-02): the worker mints a one-time code and opens the app signed in, or opens the app's
// login when this browser is not connected. The page never sees the code. Each click spends from the install's
// handoff budget (30 per hour), so the button is disabled while a request is in flight.
// The reply texts live in popupview.js (shared with the popup, W-P6).

let accountBusy = false;
async function openAccount(inPlace) {
    if ( accountBusy ) { return; }
    accountBusy = true;
    $('myAccount').disabled = true;
    // The popup landing: only "Opening your account…", not also "Checking your connection…" (render() runs after).
    if ( inPlace ) { $('loading').hidden = true; }
    $('opening').hidden = false;
    showError('');
    try {
        const reply = await ask('thankmu:open-account', { inPlace });
        if ( reply?.ok === true ) {
            // 'pairing': the app answered 401 and the connection was dropped; storage.onChanged re-renders
            // into the "connect again" screen.
            if ( reply.opened === 'pairing' ) { render(); }
        } else {
            showError(accountErrorText(reply));
        }
    } catch {
        showError('Could not open your account.');
    } finally {
        accountBusy = false;
        $('myAccount').disabled = false;
        $('opening').hidden = true;
    }
}

$('myAccount').addEventListener('click', ( ) => { openAccount(false); });

$('pair').addEventListener('click', ( ) => {
    send('thankmu:pair').catch(e => showError(`Could not open the connect page: ${e.message}`));
});

$('unpair').addEventListener('click', ( ) => {
    send('thankmu:unpair').then(render, e => showError(`Could not disconnect: ${e.message}`));
});

chrome.storage.onChanged.addListener((changes, area) => {
    if ( area !== 'local' ) { return; }
    if ( Object.keys(changes).some(k => k.startsWith('thankmu.')) ) { render(); }
});

// The old popup link (before W-P6) landed here with #my-account: run the handoff once and reuse this tab. The handoff
// runs BEFORE the first status check, so a revoked token gets one 401 (from the handoff, which then shows pairing)
// instead of two racing ones (where /me could clear the token first and send the handoff to /login).
if ( location.hash === '#my-account' ) {
    history.replaceState(null, '', location.pathname + location.search);
    openAccount(true).finally(render);
} else {
    render();
}
