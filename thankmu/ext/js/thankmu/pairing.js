/*******************************************************************************

    ThankMu pairing (W-P3 part B): the plugin side of the pairing contract in
    the tracking repo's exec-phase-1/w-a10.md, "Pairing contract".

    Pure logic. chrome.storage.local, fetch and getRandomValues are injected,
    so node tests (pairing.test.mjs) cover it without a browser. The token is
    never logged and never returned to a caller.

******************************************************************************/

export const KEYS = Object.freeze({
    installId: 'thankmu.installId',
    token: 'thankmu.token',
    clientId: 'thankmu.clientId',
    revoked: 'thankmu.revoked',   // set when the app answered 401; the pairing screen says why
    pairingStarted: 'thankmu.pairingStartedAt',   // ms epoch: the popup opened the pairing tab (W-P6 "pairing in progress")
    // true: the reader turned the tip jar off with the popup's switch (tipjar.js TIPJAR_KEYS.promptsOff). Pairing
    // turns the tip jar on (founder, 2026-11-02), so a successful pairing removes it.
    tipJarOff: 'thankmu.prompts.off',
    // The paired reader's account (GET /api/client/me user_id, stored with the token). tipjar.js keeps each unresolved
    // tip under it, so a tip of one account is never resent, or answered for, under another (review of MR !19).
    account: 'thankmu.account',
});

// W-P6: how long the popup keeps saying "Finish in the ThankMu tab." after it opened the pairing tab. Long enough
// for a login link to arrive by email; after that, an abandoned pairing goes back to Sign in / Join free.
export const PAIRING_TTL_MS = 15 * 60 * 1000;

// Reply codes for {ok: false, error}. Documented in docs/rebrand.md "Pairing".
export const ERRORS = Object.freeze({
    badOrigin: 'bad_origin',            // sender.origin is not the build's APP_ORIGIN
    badMessage: 'bad_message',          // not an object, wrong type, or malformed client_id
    badVersion: 'bad_version',          // v is not 1
    notReady: 'not_ready',              // this install has no install id yet (should not happen)
    installMismatch: 'install_mismatch',// external_id is not this install's id
    badToken: 'bad_token',              // token fails ^tmc_[A-Za-z0-9_-]{43}$
    tokenRejected: 'token_rejected',    // GET /api/client/me answered 401
    meMismatch: 'me_mismatch',          // /me answered for another install, client or kind
    confirmFailed: 'confirm_failed',    // /me unreachable, non-2xx (not 401) or not JSON
    internal: 'internal',               // storing the token failed
});

export const PAIR_TYPE = 'thankmu.pair';
export const PAIR_VERSION = 1;
export const TOKEN_RE = /^tmc_[A-Za-z0-9_-]{43}$/;
export const INSTALL_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;
const INSTALL_ID_BYTES = 32;   // 256 bits; the contract asks for at least 128
const ME_PATH = '/api/client/me';
// The /pair page gives the whole exchange 20 s (W-A10); answer well inside that, even when /me hangs.
// The limit covers headers AND body: a server that sends headers then stalls is still cut off.
export const CONFIRM_TIMEOUT_MS = 10000;
// Every other app call (status at browser start and on each account-page render) has the same bound.
export const API_TIMEOUT_MS = 10000;

// Plugin -> app handoff (W-A12; contract in the app repo README, "Plugin -> app handoff"): POST mints a one-time
// code (60 s, single use) and the plugin opens /open?code=...&next=... with it. The code is a bearer credential for
// a web session: it is never logged, never stored and never put in a reply to a page.
const HANDOFF_PATH = '/api/access/handoff';
const OPEN_PATH = '/open';
const LOGIN_PATH = '/login';
// "Join free" (W-P6) and the signed-out corner pill (W-T1): the reader sign-up, returning to this install's pairing
// page. The app keeps next through "check your email" and activation (W-T10; its safeNext allows /pair with a fragment).
const SIGNUP_PATH = '/signup/reader';
const PAIR_PATH = '/pair';
// W-P6: where each popup button lands, as a page key -> a fixed app path (the app's SPA_ROUTES; /open refuses any
// other). Callers pass a key, never a path, and an unknown key fails loudly. /wallet/topup is the app's Add money
// block, focused (also the card's reload target). E2E-02: no hop lands on /dashboard any more ("Open your feed" is
// /feed since W-T10; the account page's button is "Settings", D2).
export const HANDOFF_PAGES = Object.freeze({
    feed: '/feed',
    wallet: '/wallet/topup',
    reload: '/wallet/topup',
    settings: '/settings',
});
export const HANDOFF_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

// Reply codes for openAccount() {ok: false, error}. Documented in docs/rebrand.md "App handoff".
export const ACCOUNT_ERRORS = Object.freeze({
    rateLimited: 'rate_limited',        // 429: the install spent its handoff budget (30 per hour)
    unavailable: 'unavailable',         // unreachable, timed out, non-2xx (other than 401/429) or a malformed answer
    openFailed: 'open_failed',          // the browser refused to open the tab
});

// Run work(signal) with a hard deadline over everything it awaits; on expiry, abort and reject.
export function withTimeout(ms, work) {
    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(( ) => { ctl.abort(); reject(new Error('timeout')); }, ms);
    });
    return Promise.race([ work(ctl.signal), timeout ]).finally(( ) => clearTimeout(timer));
}

// Retry-After as whole seconds, or undefined when absent or not delta-seconds (the app sends seconds).
function retryAfterSeconds(response) {
    const v = response.headers?.get?.('Retry-After');
    return typeof v === 'string' && /^[0-9]{1,9}$/.test(v.trim()) ? Number(v.trim()) : undefined;
}

async function readJson(response) {
    try { return await response.json(); } catch { return undefined; }
}

export function assertAppOrigin(origin) {
    if ( typeof origin !== 'string' || ORIGIN_RE.test(origin) === false ) {
        throw new Error(`ThankMu APP_ORIGIN must be a bare https origin, got ${JSON.stringify(origin)}`);
    }
    return origin;
}

export function newInstallId(getRandomValues) {
    const bytes = getRandomValues(new Uint8Array(INSTALL_ID_BYTES));
    let bin = '';
    for ( const b of bytes ) { bin += String.fromCharCode(b); }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pairUrl(appOrigin, installId, extensionId) {
    return `${appOrigin}${PAIR_PATH}#install=${installId}&ext=${extensionId}`;
}

export function createPairing({ appOrigin, extensionId, storage, fetch, getRandomValues, log, now = Date.now,
                                confirmTimeoutMs = CONFIRM_TIMEOUT_MS, apiTimeoutMs = API_TIMEOUT_MS }) {
    assertAppOrigin(appOrigin);
    for ( const [ k, v ] of Object.entries({ extensionId, storage, fetch, getRandomValues, log }) ) {
        if ( !v ) { throw new Error(`ThankMu pairing: ${k} is required`); }
    }

    let installIdPromise;

    async function read(key) {
        const bin = await storage.get(key);
        return bin?.[key];
    }

    function ensureInstallId() {
        if ( installIdPromise === undefined ) {
            installIdPromise = (async ( ) => {
                const existing = await read(KEYS.installId);
                if ( typeof existing === 'string' && INSTALL_ID_RE.test(existing) ) { return existing; }
                const id = newInstallId(getRandomValues);
                await storage.set({ [KEYS.installId]: id });
                log('thankmu: install id created');
                return id;
            })();
            installIdPromise.catch(( ) => { installIdPromise = undefined; });
        }
        return installIdPromise;
    }

    async function clearToken(why, revoked) {
        await storage.remove([ KEYS.token, KEYS.clientId, KEYS.account, KEYS.revoked, KEYS.pairingStarted ]);
        if ( revoked ) { await storage.set({ [KEYS.revoked]: true }); }
        log(`thankmu: pairing cleared (${why})`);
    }

    // GET /api/client/me with a candidate token; headers and body both inside confirmTimeoutMs.
    function confirmMe(token) {
        return withTimeout(confirmTimeoutMs, async signal => {
            const response = await fetch(appOrigin + ME_PATH, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` },
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'error',
                signal,
            });
            if ( response.ok !== true ) { return { status: response.status }; }
            return { status: response.status, body: await response.json() };
        });
    }

    // Every authenticated call to the app goes through here. Resolves {status, ok, body, cleared}; the body is
    // read inside the time limit. A 401 drops the stored token, but only if it is still the token that was
    // sent: a late 401 for an old token must not wipe one paired in the meantime.
    async function apiFetch(path, init = {}) {
        if ( typeof path !== 'string' || path.startsWith('/') === false || path.startsWith('//') ) {
            throw new Error('ThankMu apiFetch: path must be an absolute path on APP_ORIGIN');
        }
        const token = await read(KEYS.token);
        if ( typeof token !== 'string' ) { throw new Error('ThankMu apiFetch: not paired'); }
        const out = await withTimeout(apiTimeoutMs, async signal => {
            const response = await fetch(appOrigin + path, {
                ...init,
                headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
                credentials: 'omit',
                redirect: 'error',
                signal,
            });
            return {
                status: response.status,
                ok: response.ok === true,
                retryAfter: response.status === 429 ? retryAfterSeconds(response) : undefined,
                body: await readJson(response),
            };
        });
        out.cleared = false;
        if ( out.status === 401 && await read(KEYS.token) === token ) {
            await clearToken('app answered 401', true);
            out.cleared = true;
        }
        return out;
    }

    function fail(error) {
        log(`thankmu: pairing refused: ${error}`);
        return { ok: false, error };
    }

    // The /pair page mints before it sends, which rotates this install's previous token server-side
    // (W-A10). So once a message is proven to come from the app for this install, a refusal must not
    // leave the old, now dead token behind (it would later 401 and read as a password reset).
    async function refuseFromApp(error) {
        const bin = await storage.get(KEYS.token);
        if ( typeof bin?.[KEYS.token] === 'string' ) { await clearToken('superseded by a refused pairing', false); }
        return fail(error);
    }

    async function handleExternal(msg, sender) {
        if ( typeof sender?.origin !== 'string' || sender.origin !== appOrigin ) { return fail(ERRORS.badOrigin); }
        if ( msg === null || typeof msg !== 'object' || msg.type !== PAIR_TYPE ) { return fail(ERRORS.badMessage); }
        if ( msg.v !== PAIR_VERSION ) { return fail(ERRORS.badVersion); }
        const installId = await read(KEYS.installId);
        if ( typeof installId !== 'string' ) { return fail(ERRORS.notReady); }
        if ( msg.external_id !== installId ) { return fail(ERRORS.installMismatch); }
        const { token, client_id: clientId } = msg;
        if ( typeof token !== 'string' || TOKEN_RE.test(token) === false ) { return refuseFromApp(ERRORS.badToken); }
        if ( typeof clientId !== 'string' || CLIENT_ID_RE.test(clientId) === false ) { return refuseFromApp(ERRORS.badMessage); }
        // The page may resend the same token after its own timeout (W-A10): already confirmed and stored -> success.
        const stored = await storage.get([ KEYS.token, KEYS.clientId ]);
        if ( stored?.[KEYS.token] === token && stored?.[KEYS.clientId] === clientId ) {
            log('thankmu: paired (duplicate message)');
            return { ok: true };
        }

        let me;
        try {
            const r = await confirmMe(token);
            if ( r.status === 401 ) { return refuseFromApp(ERRORS.tokenRejected); }
            if ( r.body === undefined ) { return refuseFromApp(ERRORS.confirmFailed); }
            me = r.body;
        } catch {
            return refuseFromApp(ERRORS.confirmFailed);
        }
        if ( me === null || typeof me !== 'object' ||
             me.external_id !== installId || me.client_id !== clientId || me.kind !== 'plugin' ||
             typeof me.user_id !== 'string' || me.user_id === '' ) {
            // No account id, no pairing: unresolved tips are kept per account (tipjar.js), so it is required.
            return refuseFromApp(ERRORS.meMismatch);
        }
        try {
            await storage.set({ [KEYS.token]: token, [KEYS.clientId]: clientId, [KEYS.account]: me.user_id });
            // Pairing turns the tip jar on (founder, 2026-11-02): the only off is the popup's switch, afterwards.
            await storage.remove([ KEYS.revoked, KEYS.pairingStarted, KEYS.tipJarOff ]);
        } catch {
            return refuseFromApp(ERRORS.internal);
        }
        log('thankmu: paired');
        return { ok: true };
    }

    async function status(retried = false) {
        const token = await read(KEYS.token);
        if ( typeof token !== 'string' ) {
            return await read(KEYS.revoked) === true ? { paired: false, revoked: true } : { paired: false };
        }
        const clientId = await read(KEYS.clientId);
        let response;
        try {
            response = await apiFetch(ME_PATH, { method: 'GET', cache: 'no-store' });
        } catch {
            return { paired: true, verified: false, clientId };
        }
        if ( response.status === 401 ) {
            if ( response.cleared ) { return { paired: false, revoked: true }; }
            // The token changed while the call was in flight (a new pairing): report on the current one.
            return retried ? { paired: true, verified: false, clientId: await read(KEYS.clientId) } : status(true);
        }
        if ( response.ok ) { await rememberAccount(token, response.body); }
        return { paired: true, verified: response.ok, clientId };
    }

    // A browser paired by an older build has a token but no stored account. /me answers for the token, so its
    // user_id is that token's account: store it, unless another pairing landed meanwhile.
    async function rememberAccount(token, body) {
        const id = body?.user_id;
        if ( typeof id !== 'string' || id === '' ) { return null; }
        if ( await read(KEYS.token) !== token ) { return null; }
        if ( await read(KEYS.account) !== id ) { await storage.set({ [KEYS.account]: id }); }
        return id;
    }

    // The paired reader's account id: stored, or learnt from GET /api/client/me for the current token (an older
    // pairing). null when not paired or /me gives no usable answer; the caller then sends nothing.
    async function accountId() {
        const token = await read(KEYS.token);
        if ( typeof token !== 'string' ) { return null; }
        const stored = await read(KEYS.account);
        if ( typeof stored === 'string' && stored !== '' ) { return stored; }
        let r;
        try {
            r = await apiFetch(ME_PATH, { method: 'GET', cache: 'no-store' });
        } catch {
            return null;
        }
        return r.ok ? rememberAccount(token, r.body) : null;
    }

    async function unpair() {
        await clearToken('unpaired by the user', false);
    }

    // W-P6: the popup opened the pairing tab. Recorded after the tab opened, so a refused tab never shows "pairing".
    async function markPairingStarted() {
        await storage.set({ [KEYS.pairingStarted]: now() });
    }

    // True while a pairing the popup started is younger than PAIRING_TTL_MS and this browser is not paired yet.
    async function pairingInProgress() {
        if ( typeof await read(KEYS.token) === 'string' ) { return false; }
        const at = await read(KEYS.pairingStarted);
        if ( typeof at !== 'number' || Number.isFinite(at) === false ) { return false; }
        const age = now() - at;
        return age >= 0 && age < PAIRING_TTL_MS;
    }

    // The app handoff: open the app signed in. openTab(url) opens the tab (the worker passes chrome.tabs); the URL
    // with the code goes only there. Resolves {ok: true, opened: 'app' | 'login' | 'pairing'} or
    // {ok: false, error, retryAfter?}. 'pairing' means the app answered 401: the token was dropped
    // (compare-and-clear in apiFetch) and the caller shows the pairing screen.
    // page: a HANDOFF_PAGES key (W-P6), 'settings' by default (the account page's Settings button).
    async function openAccount(openTab, page = 'settings') {
        if ( typeof openTab !== 'function' ) { throw new Error('ThankMu openAccount: openTab is required'); }
        if ( typeof page !== 'string' || Object.hasOwn(HANDOFF_PAGES, page) === false ) {
            throw new Error('ThankMu openAccount: unknown page');
        }
        const next = HANDOFF_PAGES[page];
        const open = async (url, opened) => {
            try {
                await openTab(url);
            } catch {
                log('thankmu: app handoff: could not open the tab');
                return { ok: false, error: ACCOUNT_ERRORS.openFailed };
            }
            return { ok: true, opened };
        };
        if ( typeof await read(KEYS.token) !== 'string' ) {
            return open(appOrigin + LOGIN_PATH, 'login');
        }
        let r;
        try {
            r = await apiFetch(HANDOFF_PATH, { method: 'POST', cache: 'no-store' });
        } catch (e) {
            // 'not paired': the token was cleared between the check above and the call.
            if ( typeof await read(KEYS.token) !== 'string' ) { return open(appOrigin + LOGIN_PATH, 'login'); }
            log('thankmu: app handoff: handoff unreachable or timed out');
            return { ok: false, error: ACCOUNT_ERRORS.unavailable };
        }
        if ( r.status === 401 ) {
            log('thankmu: app handoff: app answered 401');
            // Cleared here, or by a concurrent call that got the same 401 first (the account page's status check):
            // show pairing. Only a NEW token stored meanwhile (a fresh pairing) means nothing to show; retry.
            if ( r.cleared || typeof await read(KEYS.token) !== 'string' ) { return { ok: true, opened: 'pairing' }; }
            return { ok: false, error: ACCOUNT_ERRORS.unavailable };
        }
        if ( r.status === 429 ) {
            log('thankmu: app handoff: handoff rate limited');
            const out = { ok: false, error: ACCOUNT_ERRORS.rateLimited };
            if ( r.retryAfter !== undefined ) { out.retryAfter = r.retryAfter; }
            return out;
        }
        const code = r.body?.code;
        if ( r.status !== 201 || typeof code !== 'string' || HANDOFF_CODE_RE.test(code) === false ) {
            log(`thankmu: app handoff: unexpected handoff answer (status ${r.status})`);
            return { ok: false, error: ACCOUNT_ERRORS.unavailable };
        }
        // The code is checked URL-safe above and next is a fixed path: the URL is exactly the contract's shape.
        return open(`${appOrigin}${OPEN_PATH}?code=${code}&next=${next}`, 'app');
    }

    return {
        ensureInstallId,
        pairUrl: async ( ) => pairUrl(appOrigin, await ensureInstallId(), extensionId),
        handleExternal,
        status,
        accountId,
        unpair,
        apiFetch,
        openAccount,
        markPairingStarted,
        pairingInProgress,
        // Storage only (the install id): building it calls nothing, so it is safe signed out.
        signupUrl: async ( ) => {
            const next = `${PAIR_PATH}#install=${await ensureInstallId()}&ext=${extensionId}`;
            return `${appOrigin}${SIGNUP_PATH}#next=${encodeURIComponent(next)}`;
        },
    };
}

// The chrome.runtime.onMessageExternal listener: returns true synchronously (keeps the channel open) and
// answers through sendResponse later with exactly {ok: true} or {ok: false, error}.
export function externalListener(pairing) {
    return (msg, sender, sendResponse) => {
        pairing.handleExternal(msg, sender).then(
            reply => sendResponse(reply),
            ( ) => sendResponse({ ok: false, error: ERRORS.internal }),
        );
        return true;
    };
}
