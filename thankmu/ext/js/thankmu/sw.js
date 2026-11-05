/*******************************************************************************

    ThankMu service-worker module (W-P3 part B): wires the pure pairing logic
    (pairing.js) to the chrome.* APIs. APP_ORIGIN comes from config.js, which
    the patch step generates from thankmu/targets.json; nothing here names a
    host.

    A ThankMu failure must never stop blocking. This module is imported before
    upstream's worker (thankmu-sw.js), and a throw at its top level would fail
    the whole module graph, so every statement with side effects runs inside
    setup() under try/catch. The static imports above it only define values
    (config.js, pairing.js); thankmu-sw.test.mjs proves upstream still loads
    when setup throws. (Service workers do not allow dynamic import().)

    Internal messages use what: 'thankmu:<action>'. Upstream's onMessage
    handler returns early on any 'what' containing ':'.

******************************************************************************/

import { APP_ORIGIN } from './config.js';
import { createPairing, externalListener } from './pairing.js';
import { createTipJar, contentListener } from './tipjar.js';
import { createPopupState } from './popupstate.js';

// W-T1 part A: the ad-slot card (tipjar.js). Set up after pairing, in its own try: a tip-jar failure leaves pairing
// and blocking alone, and the popup's switch then gets no answer.
let tipjar = null;

function setupTipJar(pairing, openSignup) {
    const jar = createTipJar({
        appOrigin: APP_ORIGIN,
        storage: chrome.storage.local,
        // Pending tip keys: worker-only storage (session is not exposed to content scripts by default).
        session: chrome.storage.session,
        fetch: (...args) => globalThis.fetch(...args),
        apiFetch: pairing.apiFetch,
        accountId: pairing.accountId,
        randomKey: ( ) => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''),
        digest: (alg, data) => crypto.subtle.digest(alg, data),
        log: (...args) => console.info(...args),
    });
    // The card's only hop into the app: its reload offer, on the reader's click (W-T1, E2E-02).
    const openReload = ( ) => pairing.openAccount(url => chrome.tabs.create({ url }), 'reload')
        .catch(( ) => ({ ok: false, error: 'internal' }));
    // A second onMessage listener, after the extension-page one; each ignores the other's messages.
    chrome.runtime.onMessage.addListener(contentListener({
        tipjar: jar, extensionId: chrome.runtime.id, openSignup, openReload,
    }));
    tipjar = jar;
}

function setup() {
    const pairing = createPairing({
        appOrigin: APP_ORIGIN,
        extensionId: chrome.runtime.id,
        storage: chrome.storage.local,
        fetch: (...args) => globalThis.fetch(...args),
        getRandomValues: a => crypto.getRandomValues(a),
        log: (...args) => console.info(...args),
    });

    const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;

    // Opening the pairing tab also starts the popup's "pairing in progress" state (W-P6), once the tab is open.
    const openPairing = ( ) => pairing.pairUrl()
        .then(url => chrome.tabs.create({ url }))
        .then(( ) => pairing.markPairingStarted());

    // "Join free" in the popup and the signed-out pill's one action (W-T1): the reader sign-up, returning to /pair.
    // Storage (the install id) and a new tab only: signed out, nothing here calls the app.
    const openSignup = async ( ) => {
        await chrome.tabs.create({ url: await pairing.signupUrl() });
        return { ok: true };
    };

    // The popup's frames (W-P6): what the reader sees, from GET /api/client/me. Created here, outside the tip jar,
    // so a tip-jar failure leaves the popup's account part working.
    const popupState = createPopupState({ pairing, storage: chrome.storage.local });

    chrome.runtime.onMessageExternal.addListener(externalListener(pairing));

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        const what = msg?.what;
        if ( typeof what !== 'string' || what.startsWith('thankmu:') === false ) { return; }
        // Only ThankMu's own extension pages, never a content script running in a web page.
        if ( typeof sender?.url !== 'string' || new URL(sender.url).origin !== extensionOrigin ) { return; }
        let job;
        switch ( what ) {
        case 'thankmu:status':
            job = pairing.status();
            break;
        case 'thankmu:pair':
            job = openPairing().then(( ) => ({ ok: true }));
            break;
        // The popup's switch for the ad-slot card (thankmu-popup.html). tabUrl: the active tab, to say "hidden here".
        case 'thankmu:prompts-state':
            if ( tipjar === null ) { return; }
            job = tipjar.promptsState(msg.tabUrl);
            break;
        case 'thankmu:prompts-set':
            if ( tipjar === null ) { return; }
            if ( typeof msg.on !== 'boolean' ) { return; }
            job = tipjar.setPromptsOn(msg.on).then(( ) => tipjar.promptsState(msg.tabUrl));
            break;
        case 'thankmu:prompts-undismiss':
            if ( tipjar === null ) { return; }
            job = tipjar.undismiss(msg.tabUrl).then(( ) => tipjar.promptsState(msg.tabUrl));
            break;
        case 'thankmu:unpair':
            job = pairing.unpair().then(( ) => ({ ok: true }));
            break;
        case 'thankmu:popup-state':
            job = popupState.state();
            break;
        // The popup's buttons (W-P6): page is a pairing.js HANDOFF_PAGES key; anything else is refused there.
        case 'thankmu:open-app':
            // No default page here: a message without a page key is a bug, refused like an unknown key.
            job = (typeof msg.page === 'string'
                ? pairing.openAccount(url => chrome.tabs.create({ url }), msg.page)
                : Promise.reject(new Error('no page')))
                .catch(( ) => ({ ok: false, error: 'internal' }));
            break;
        case 'thankmu:open-signup':
            job = openSignup();
            break;
        case 'thankmu:open-account': {
            // The account page's "Settings" button (pairing.js default page). inPlace: #my-account opened the page only to run this; reuse its tab.
            const tabId = msg.inPlace === true ? sender.tab?.id : undefined;
            const openTab = typeof tabId === 'number'
                ? url => chrome.tabs.update(tabId, { url })
                : url => chrome.tabs.create({ url });
            // The reply never carries the URL (it holds the one-time code) nor a browser error that could echo it.
            job = pairing.openAccount(openTab).catch(( ) => ({ ok: false, error: 'internal' }));
            break;
        }
        default:
            return;
        }
        job.then(sendResponse, err => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
    });

    chrome.runtime.onInstalled.addListener(( ) => { pairing.ensureInstallId(); });

    // A password reset revokes the token server-side; notice it at browser start, not only when the user opens the page.
    chrome.runtime.onStartup.addListener(( ) => { pairing.status(); });

    try {
        setupTipJar(pairing, openSignup);
    } catch (e) {
        console.error(`thankmu: ad-slot card disabled, pairing and ad blocking unaffected: ${e?.message || e}`);
    }
}

try {
    setup();
} catch (e) {
    console.error(`thankmu: pairing disabled, ad blocking unaffected: ${e?.message || e}`);
}
