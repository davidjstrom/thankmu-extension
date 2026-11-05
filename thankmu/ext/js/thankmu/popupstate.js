/*******************************************************************************

    ThankMu popup state (W-P6): what the toolbar popup shows about the reader,
    read by the service worker for the popup's two frames (thankmu-popup.html).

    Pure logic: the pairing object (pairing.js: storage reads, apiFetch with
    compare-and-clear on 401) and the clock are injected, so node tests
    (popupstate.test.mjs) cover it without a browser.

    One app call: GET /api/client/me (contract-plugin-api.md §Wallet), which
    the popup is already declared to make. The reply to the page carries only
    what the popup shows: never the token, the user, household or client id.
    Data that is missing or malformed is left out, never replaced by a zero:
    the popup hides what it does not have.

******************************************************************************/

import { KEYS } from './pairing.js';

const ME_PATH = '/api/client/me';
// The popup's two frames ask at nearly the same time; both get one /me answer for this long (same token only).
export const SHARE_MS = 2000;

const isCount = v => Number.isSafeInteger(v) && v >= 0;

// The parts of a /me body the popup may show, each only when well-formed.
export function popupFields(body) {
    const out = {};
    const w = body?.wallet;
    if ( w && isCount(w.balance_cents) && isCount(w.promotional_cents) && w.promotional_cents <= w.balance_cents &&
         w.currency === 'usd' ) {
        out.wallet = { balance_cents: w.balance_cents, promotional_cents: w.promotional_cents };
    }
    // "likes" is the all-time count (Q-20261031-0927-W-P6e, answer C: counts.likes_total, W-T10). The 30-day count
    // is never shown under that label: until the app sends likes_total, the tile is hidden.
    if ( isCount(body?.counts?.likes_total) ) { out.likes = body.counts.likes_total; }
    return out;
}

export function createPopupState({ pairing, storage, now = Date.now, shareMs = SHARE_MS }) {
    for ( const [ k, v ] of Object.entries({ pairing, storage }) ) {
        if ( !v ) { throw new Error(`ThankMu popup state: ${k} is required`); }
    }

    async function read(key) {
        const bin = await storage.get(key);
        return bin?.[key];
    }

    async function signedOut() {
        return {
            paired: false,
            revoked: await read(KEYS.revoked) === true,
            pairing: await pairing.pairingInProgress(),
        };
    }

    async function fetchState(token) {
        let r;
        try {
            r = await pairing.apiFetch(ME_PATH, { method: 'GET', cache: 'no-store' });
        } catch {
            return { paired: true, verified: false };
        }
        if ( r.status === 401 ) {
            // apiFetch cleared the token if it was still this one; otherwise a new pairing landed: report on that.
            return typeof await read(KEYS.token) === 'string' && await read(KEYS.token) !== token
                ? { paired: true, verified: false }
                : signedOut();
        }
        if ( r.ok !== true ) { return { paired: true, verified: false }; }
        return { paired: true, verified: true, ...popupFields(r.body) };
    }

    let shared;   // { token, at, promise }
    async function state() {
        const token = await read(KEYS.token);
        if ( typeof token !== 'string' ) { return signedOut(); }
        if ( shared && shared.token === token && (shared.at === undefined || now() - shared.at < shareMs) ) {
            return shared.promise;
        }
        const entry = { token, at: undefined };
        entry.promise = fetchState(token).finally(( ) => { entry.at = now(); });
        shared = entry;
        return entry.promise;
    }

    return { state };
}
