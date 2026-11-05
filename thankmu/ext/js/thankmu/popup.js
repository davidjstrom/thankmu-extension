/*******************************************************************************

    ThankMu popup (W-P6, the approved D2 design; the card switch is W-T1 part A).
    Framed twice into upstream's popup by the patch step, so upstream's popup
    HTML gains no <script> and its controls stay exactly as they are, between
    the two frames:

      thankmu-popup.html?part=head   header, stats           (above upstream)
      thankmu-popup.html             account, switch, footer (below upstream)

    State lives in the service worker (sw.js: popupstate.js, pairing.js,
    tipjar.js); this page only shows it and sends 'thankmu:<action>' messages.
    It never sees the token or a handoff code.

******************************************************************************/

import { capHostname, startFitting, ownFrame } from './popupfit.js';
import { followSystemTheme } from './theme.js';
import { AMOUNTS_CENTS } from './tipjar.js';
import { accountErrorText, badgeCount, bodyOf, dollars, needsReload, statsOf } from './popupview.js';

const $ = id => document.getElementById(id);
const part = new URLSearchParams(location.search).get('part') === 'head' ? 'head' : 'body';

// The worker bounds its own app calls (pairing.js API_TIMEOUT_MS); this is a backstop so the popup never waits forever.
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

async function activeTab() {
    try {
        const [ tab ] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab;
    } catch {
        return undefined;
    }
}

const isWebPage = url => typeof url === 'string' && /^https?:/.test(url);

// "ads blocked here": the toolbar badge's count for the active tab, when Chrome hands back a number (popupview.js).
async function blockedHere(tab) {
    if ( typeof tab?.id !== 'number' || isWebPage(tab.url) === false ) { return null; }
    try {
        return badgeCount(await chrome.action.getBadgeText({ tabId: tab.id }));
    } catch {
        return null;
    }
}

function showError(text) {
    $('error').textContent = text || '';
    $('error').hidden = !text;
    // While it shows, the message takes the place of the state's paragraph or the wallet's sub-lines (.pp-yield).
    $('body').classList.toggle('has-error', Boolean(text));
}

// --- head: the header and the stats ----------------------------------------------------------------------

function paintStats(st, badge) {
    const tiles = statsOf(st, badge);
    for ( const id of [ 'here', 'likes' ] ) {
        const tile = tiles.find(t => t.id === id);
        $(`stat-${id}`).hidden = tile === undefined;
        $(`stat-${id}`).querySelector('b').textContent = tile?.value ?? '';
    }
    $('stats').hidden = tiles.length === 0;
}

// --- body: the account, the switch and the footer --------------------------------------------------------

function paintBody(st) {
    const which = bodyOf(st);
    for ( const id of [ 'signedOut', 'pairing', 'signedIn', 'unavailable' ] ) { $(id).hidden = id !== which; }
    // Revoked: the notice takes the pitch's place (both end in Sign in); with both, no layout fits the 600 px popup.
    const revoked = which === 'signedOut' && st?.revoked === true;
    $('revoked').hidden = !revoked;
    $('pitch').hidden = revoked;
    $('footOut').hidden = which === 'signedIn';
    $('footIn').hidden = which !== 'signedIn';
    // The tip jar's switch and the cards' hidden-on line belong to the tip jar, which is on only when signed in
    // (W-T1, founder 2026-11-02). 'unavailable' is a paired reader whose worker did not answer: the switch stays.
    tipJarRows = which === 'signedIn' || which === 'unavailable';
    $('switches').hidden = !tipJarRows;
    paintHidden();
    if ( which !== 'signedIn' ) { return; }
    $('unverified').hidden = st.verified !== false;
    const w = st.wallet;
    $('wallet').hidden = w === undefined;
    $('balance').textContent = w ? dollars(w.balance_cents) : '';
    $('promo').hidden = !(w && w.promotional_cents > 0);
    $('promo').textContent = w && w.promotional_cents > 0 ? `includes ${dollars(w.promotional_cents)} promotional credit` : '';
    // Used up: the wallet's link becomes "Reload to keep tipping" (the same /wallet/topup as Add money) and the
    // used-up line sits under the balance, so the nudge costs one line, not a paragraph of its own.
    const reload = needsReload(st, AMOUNTS_CENTS);
    $('reload').hidden = !reload;
    $('reloadLink').hidden = !reload;
    $('addMoney').hidden = reload;
}

let tipJarRows = false;
let prompts;   // the worker's last answer about the switch

function paintHidden() {
    const ps = prompts;
    const hidden = tipJarRows && ps?.on === true && typeof ps.hidden === 'string';
    $('hidden').hidden = !hidden;
    // One line: a long domain is cut with an ellipsis on screen, and the whole sentence is the line's title.
    $('hiddenDomain').textContent = hidden ? ps.hidden : '';
    $('hidden').title = hidden ? `Hidden on ${ps.hidden} for today.` : '';
}

function paintPrompts(ps) {
    if ( ps === undefined || typeof ps.on !== 'boolean' ) { return; }
    prompts = ps;
    $('prompts').checked = ps.on;
    $('prompts').disabled = false;
    paintHidden();
}

// Latest wins: renders can overlap (storage changes), and only the newest one paints.
let generation = 0;
async function render(tab) {
    const mine = ++generation;
    let st;
    try {
        st = await ask('thankmu:popup-state');
    } catch {
        st = undefined;
    }
    if ( mine !== generation ) { return; }
    if ( part === 'head' ) {
        paintStats(st, await blockedHere(tab));
        return;
    }
    // No answer at all (the worker's ThankMu part is down or timed out): the neutral "could not reach" state, never
    // Sign in, which would mislead a paired reader. Ad blocking is unaffected.
    paintBody(st);
}

// Each app button: one handoff request at a time (each spends from the install's budget, 30 per hour).
let busy = false;
async function openApp(page) {
    if ( busy ) { return; }
    busy = true;
    showError('');
    try {
        const reply = await ask('thankmu:open-app', { page });
        if ( reply?.ok !== true ) { showError(accountErrorText(reply)); }
    } catch {
        showError(accountErrorText(undefined));
    } finally {
        busy = false;
    }
}

function wireBody(tab) {
    const tabUrl = tab?.url;
    const askPrompts = msg => ask(msg.what, { ...msg, tabUrl }).then(paintPrompts, ( ) => {});
    $('prompts').addEventListener('change', ev => { askPrompts({ what: 'thankmu:prompts-set', on: ev.target.checked }); });
    $('showAgain').addEventListener('click', ( ) => { askPrompts({ what: 'thankmu:prompts-undismiss' }); });
    const pair = ( ) => ask('thankmu:pair').catch(( ) => showError('Could not open the connect page.'));
    $('signIn').addEventListener('click', pair);
    $('pairAgain').addEventListener('click', pair);
    $('join').addEventListener('click', ( ) => { ask('thankmu:open-signup').catch(( ) => showError(accountErrorText({ error: 'open_failed' }))); });
    $('feed').addEventListener('click', ( ) => { openApp('feed'); });
    $('reloadLink').addEventListener('click', ( ) => { openApp('reload'); });
    $('addMoney').addEventListener('click', ( ) => { openApp('wallet'); });
    $('settings').addEventListener('click', ( ) => { openApp('settings'); });
    $('signOut').addEventListener('click', ( ) => { ask('thankmu:unpair').catch(( ) => showError('Could not sign out.')); });
    askPrompts({ what: 'thankmu:prompts-state' });
}

async function main() {
    followSystemTheme();
    $(part).hidden = false;
    startFitting({ frame: ownFrame(window), body: document.body, Observer: window.ResizeObserver });
    const tab = await activeTab();
    if ( part === 'head' ) {
        // The popup is a same-origin extension page: close it the way the toolbar's own popup would close.
        // A host long enough to wrap upstream's hostname row to three lines is capped at two (popupfit.js).
        const host = ownFrame(window)?.ownerDocument?.getElementById('hostname');
        const view = host?.ownerDocument?.defaultView;
        capHostname(host, el => view.getComputedStyle(el), view?.ResizeObserver);
        $('close').addEventListener('click', ( ) => { (window.top ?? window).close(); });
    } else {
        wireBody(tab);
    }
    // Sign in, sign out, a revoked token or a finished pairing: both frames follow the worker's storage.
    chrome.storage.onChanged.addListener((changes, area) => {
        if ( area !== 'local' ) { return; }
        if ( Object.keys(changes).some(k => k.startsWith('thankmu.') && k.startsWith('thankmu.partners') === false) ) { render(tab); }
    });
    await render(tab);
}

main();
