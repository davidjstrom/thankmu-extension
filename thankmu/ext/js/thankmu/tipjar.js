/*******************************************************************************

    ThankMu tip jar (W-T1 part A): the service-worker side of the ad-slot
    prompt. Decides whether a page may show the card, and turns the reader's
    like, tip or pledge into the app call the contract names
    (tracking repo: exec-phase-4/contract-plugin-api.md, as merged).

    Pure logic: storage, fetch, apiFetch (pairing.js, which carries the token
    and does compare-and-clear on 401) and the SHA-256 digest are injected, so
    node tests (tipjar.test.mjs) cover it without a browser.

    Privacy (contract §Conventions). The page URL arrives from the browser
    (the message sender's url), never from the page, and never leaves the
    browser: the app gets the normalised domain and a SHA-256 path hash, plus
    the page's own title and byline on an action only.

    By state (ADR-013 "In-page surfaces", founder 2026-11-02). Signed out,
    nothing here makes a request: gate() answers from storage, the page gets
    the static corner pill, and check(), like(), give() and balance() stop at
    "not paired" before any fetch, the partner list included. The tip jar is
    on when the browser is paired and the popup's switch is not off (pairing
    turns it on: pairing.js). Then a page with an emptied slot fetches the
    public partner list (no parameters), and only the reader's tap sends
    anything about the page.

******************************************************************************/

import { KEYS, withTimeout } from './pairing.js';

export const TIPJAR_KEYS = Object.freeze({
    promptsOff: KEYS.tipJarOff,                 // true: the tip jar is switched off (the popup's switch)
    dismissed: 'thankmu.prompts.dismissed',     // { <domain>: <until, ms epoch> }: the cards, hidden for the day
    // The signed-out pill's own dismissals, same shape. Apart from the cards', so hiding the pill and then pairing
    // still shows the cards on that site the same day.
    pillDismissed: 'thankmu.pill.dismissed',
    partners: 'thankmu.partners',               // { etag, entries, fetchedAt }
});

// The amounts the card offers, in cents, for tips and pledges alike. Canonical source: the app's
// PLEDGE_AMOUNTS_CENTS (majorrepo .env). The app does not publish it yet: GET /api/publishers/partners has no
// amounts_cents (Q-20261030-1906-W-T1a). A pledge outside the app's set is refused with 422 fields [amount_cents];
// the card then says the plugin is out of date.
export const AMOUNTS_CENTS = Object.freeze([ 25, 50, 100 ]);

// "Dismiss remembers for that domain for a day" (w-t1.md).
export const DISMISS_MS = 24 * 60 * 60 * 1000;
// The contract: revalidate the partner list hourly and on 409 publisher_blocked.
export const PARTNERS_REFRESH_MS = 60 * 60 * 1000;
// Past this age with every refresh failing, the list no longer proves a domain isn't blocked: no prompt (ADR-014).
export const PARTNERS_STALE_MAX_MS = 24 * 60 * 60 * 1000;
export const PARTNERS_PATH = '/api/publishers/partners';

// The app's limits on page metadata (majorrepo pledges/policy.py TITLE_MAX, AUTHOR_MAX).
export const TITLE_MAX = 300;
export const AUTHOR_MAX = 200;

// A tip or pledge whose result was uncertain (timeout, network, 5xx) keeps its idempotency key in
// chrome.storage.session, per page, until a definite answer, so no retry, reload or worker restart can charge twice.
// The app keeps keys per user indefinitely (unique per user); this TTL only bounds how long the card insists.
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
// One entry per account, page and kind (tip or pledge), each under its own key, so two tabs never overwrite each
// other's, an unresolved pledge never blocks a tip after the publisher joins, and an entry is only ever resent or
// answered for the account that made it (review of MR !19; kept through sign-out, refused for another account):
// 'thankmu.pending|<account>|<mode>|<domain>|<path hash>'. <account> is the paired reader's user id (pairing.js
// accountId: stored at pairing, or learnt from GET /api/client/me for a pairing made by an older build). Without
// one nothing is written or sent, so there is no shared bucket an entry could be orphaned in.
const PENDING_PREFIX = 'thankmu.pending|';
// The whole of give(), partner-list refresh and POST together, answers within this. It must stay below the card's
// own wait (adslot.js SEND_TIMEOUT_MS, 15 s): the card must never give up on a send the worker can still settle
// without knowing. Past the deadline the answer is 'uncertain' if the POST went out, 'unavailable' if it did not
// (and then it never goes out).
export const GIVE_DEADLINE_MS = 12000;
// Only 'uncertain' keeps the key: no answer at all (network error, timeout) or a 5xx, where the app may have recorded
// the tip. Every other answer is definite (the app recorded it, or refused it before recording), so the key is spent
// or free and the card may offer a new tip. 429 is definite too: refused before recording (the contract).
const UNCERTAIN = 'uncertain';

const LIKES_PATH = '/api/likes';
const PLEDGES_PATH = '/api/pledges';
const SPENDS_PATH = '/api/ledger/spends';
const BALANCE_PATH = '/api/ledger/balance';
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;   // the app's idempotency key rule
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const MAX_HOST = 253;

// The app's normalize_domain (majorrepo publishers/domains.py): ASCII host, lowercase, no trailing dot,
// leading "www." stripped while more than two labels remain; IPs, single labels and an all-digit last label refused.
export function normalizeDomain(raw) {
    if ( typeof raw !== 'string' ) { return null; }
    const host = raw.trim().replace(/\.+$/, '');
    if ( host === '' || /[^\x21-\x7e]/.test(host) || /[/?#@:[\]\\]/.test(host) ) { return null; }
    let labels = host.toLowerCase().split('.');
    while ( labels[0] === 'www' && labels.length > 2 ) { labels = labels.slice(1); }
    if ( labels.length < 2 ) { return null; }
    if ( labels.some(l => LABEL_RE.test(l) === false) ) { return null; }
    if ( /^[0-9]+$/.test(labels.at(-1)) ) { return null; }
    const out = labels.join('.');
    return out.length <= MAX_HOST ? out : null;
}

// The canonical host and each parent with at least two labels, most specific first (publishers/domains.py).
export function candidateDomains(raw) {
    const d = normalizeDomain(raw);
    if ( d === null ) { return []; }
    const labels = d.split('.');
    const out = [];
    for ( let i = 0; i < labels.length - 1; i++ ) { out.push(labels.slice(i).join('.')); }
    return out;
}

// 'partner' | 'blocked' | 'unknown' for a host, by the longest registered match (the app's lookup order).
export function propertyStatus(entries, host) {
    const byDomain = new Map(entries.map(e => [ e.domain, e.status ]));
    for ( const d of candidateDomains(host) ) {
        const s = byDomain.get(d);
        if ( s === 'partner' || s === 'blocked' ) { return s; }
    }
    return 'unknown';
}

// The page as the app may know it. hashInput is what path_hash digests: scheme + "//" + host + path, with the host
// as the browser has it (lowercase, punycode, "www." kept), no port, no query, no fragment. W-T1 part B and any
// other client must hash the same bytes (docs/rebrand.md "Ad-slot prompt").
export function pageOf(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if ( u.protocol !== 'https:' && u.protocol !== 'http:' ) { return null; }
    const domain = normalizeDomain(u.hostname);
    if ( domain === null ) { return null; }
    return { domain, hashInput: `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}` };
}

export async function pathHash(hashInput, digest) {
    const buf = await digest('SHA-256', new TextEncoder().encode(hashInput));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Display text from the page: control characters out (the app refuses them), whitespace collapsed, capped.
export function cleanText(v, max, { noUrl = false } = {}) {
    if ( typeof v !== 'string' ) { return undefined; }
    // By code point, as the app counts (Python str length), so an emoji at the boundary is never split.
    const s = Array.from(v.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
    if ( s === '' ) { return undefined; }
    if ( noUrl && /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ) { return undefined; }
    return s;
}

function cleanMeta(meta) {
    const out = {};
    const title = cleanText(meta?.title, TITLE_MAX);
    const author = cleanText(meta?.author, AUTHOR_MAX, { noUrl: true });
    if ( title !== undefined ) { out.title = title; }
    if ( author !== undefined ) { out.author = author; }
    return out;
}

function validEntries(body) {
    if ( body === null || typeof body !== 'object' || Array.isArray(body.entries) === false ) { return null; }
    const out = [];
    for ( const e of body.entries ) {
        if ( e === null || typeof e !== 'object' || typeof e.domain !== 'string' ) { return null; }
        if ( e.status !== 'partner' && e.status !== 'blocked' ) { return null; }
        out.push({ domain: e.domain, status: e.status });
    }
    return out;
}

export function createTipJar({ appOrigin, storage, session, fetch, apiFetch, accountId, digest, randomKey, now = Date.now, log,
                               timeoutMs = 10000, giveDeadlineMs = GIVE_DEADLINE_MS }) {
    for ( const [ k, v ] of Object.entries({ appOrigin, storage, session, fetch, apiFetch, accountId, digest, randomKey, log }) ) {
        if ( !v ) { throw new Error(`ThankMu tip jar: ${k} is required`); }
    }
    const appHost = new URL(appOrigin).hostname;

    async function read(key) {
        const bin = await storage.get(key);
        return bin?.[key];
    }

    // --- the partner list (public, cached, revalidated) ----------------------------------------------

    let inflight;
    async function fetchPartners(cached) {
        const headers = {};
        if ( typeof cached?.etag === 'string' ) { headers['If-None-Match'] = cached.etag; }
        const r = await withTimeout(timeoutMs, async signal => {
            const response = await fetch(appOrigin + PARTNERS_PATH, {
                method: 'GET', headers, credentials: 'omit', redirect: 'error', cache: 'no-cache', signal,
            });
            if ( response.status === 304 ) { return { status: 304, etag: response.headers?.get?.('ETag') }; }
            if ( response.ok !== true ) { return { status: response.status }; }
            let body;
            try { body = await response.json(); } catch { body = undefined; }
            return { status: response.status, etag: response.headers?.get?.('ETag'), body };
        });
        if ( r.status === 304 && cached ) {
            return { etag: r.etag ?? cached.etag, entries: cached.entries, fetchedAt: now() };
        }
        const entries = r.status === 200 ? validEntries(r.body) : null;
        if ( entries === null ) { throw new Error(`partner list: unusable answer (status ${r.status})`); }
        if ( r.body.truncated === true ) { log('thankmu: partner list truncated by the app'); }
        return { etag: typeof r.etag === 'string' ? r.etag : undefined, entries, fetchedAt: now() };
    }

    // The entries, or null when no list recent enough is available (callers then show nothing: fail closed).
    async function partners(force = false) {
        const cached = await read(TIPJAR_KEYS.partners);
        const fresh = cached && Array.isArray(cached.entries) && now() - cached.fetchedAt < PARTNERS_REFRESH_MS;
        if ( fresh && force === false ) { return cached.entries; }
        if ( inflight === undefined ) {
            inflight = fetchPartners(cached)
                .then(async next => { await storage.set({ [TIPJAR_KEYS.partners]: next }); return next; })
                .finally(( ) => { inflight = undefined; });
        }
        try {
            return (await inflight).entries;
        } catch (e) {
            log(`thankmu: partner list refresh failed: ${e?.message || e}`);
            const usable = cached && Array.isArray(cached.entries) && now() - cached.fetchedAt < PARTNERS_STALE_MAX_MS;
            return usable ? cached.entries : null;
        }
    }

    async function statusOf(domain, force = false) {
        const entries = await partners(force);
        return entries === null ? null : propertyStatus(entries, domain);
    }

    // --- dismissals and the switch -------------------------------------------------------------------

    async function dismissals(key = TIPJAR_KEYS.dismissed) {
        const d = await read(key);
        const out = {};
        if ( d && typeof d === 'object' ) {
            for ( const [ k, until ] of Object.entries(d) ) { if ( typeof until === 'number' && until > now() ) { out[k] = until; } }
        }
        return out;
    }

    async function dismiss(url) {
        const page = pageOf(url);
        if ( page === null ) { return null; }
        const d = await dismissals();
        d[page.domain] = now() + DISMISS_MS;
        await storage.set({ [TIPJAR_KEYS.dismissed]: d });
        return page.domain;
    }

    // The signed-out pill's "not today on this site". Storage only.
    async function dismissPill(url) {
        const page = pageOf(url);
        if ( page === null ) { return null; }
        const d = await dismissals(TIPJAR_KEYS.pillDismissed);
        d[page.domain] = now() + DISMISS_MS;
        await storage.set({ [TIPJAR_KEYS.pillDismissed]: d });
        return page.domain;
    }

    async function undismiss(url) {
        const page = pageOf(url);
        if ( page === null ) { return; }
        const d = await dismissals();
        delete d[page.domain];
        await storage.set({ [TIPJAR_KEYS.dismissed]: d });
    }

    async function promptsOn() {
        return await read(TIPJAR_KEYS.promptsOff) !== true;
    }

    async function setPromptsOn(on) {
        if ( on === true ) { await storage.remove(TIPJAR_KEYS.promptsOff); } else { await storage.set({ [TIPJAR_KEYS.promptsOff]: true }); }
    }

    async function promptsState(tabUrl) {
        const on = await promptsOn();
        const page = pageOf(tabUrl);
        const hidden = page !== null && (await dismissals())[page.domain] !== undefined ? page.domain : null;
        return { on, hidden };
    }

    async function paired() {
        return typeof await read(KEYS.token) === 'string';
    }

    // --- may this page show the card? ------------------------------------------------------------------

    async function check(url) {
        // Signed out: no card, and so no partner list either (ADR-013: the signed-out state makes no request).
        if ( await paired() === false ) { return { show: false, reason: 'signed_out' }; }
        if ( await promptsOn() === false ) { return { show: false, reason: 'off' }; }
        const page = pageOf(url);
        if ( page === null ) { return { show: false, reason: 'not_a_page' }; }
        if ( normalizeDomain(appHost) === page.domain ) { return { show: false, reason: 'app' }; }
        if ( (await dismissals())[page.domain] !== undefined ) { return { show: false, reason: 'dismissed' }; }
        const status = await statusOf(page.domain);
        if ( status === null ) { return { show: false, reason: 'no_partner_list' }; }
        if ( status === 'blocked' ) { return { show: false, reason: 'blocked' }; }
        return { show: true, domain: page.domain, mode: status === 'partner' ? 'tip' : 'pledge', paired: true };
    }

    // --- actions ---------------------------------------------------------------------------------------

    async function post(path, body) {
        try {
            return await apiFetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                cache: 'no-store',
            });
        } catch {
            return { status: 0 };
        }
    }

    // App answer -> card outcome. `mode` is what the reader confirmed; a 409 that says the publisher's status
    // changed refreshes the list and hands the card the new mode, so it re-renders instead of doing the other action.
    // Each answer the contract defines maps to one definite outcome the card shows in place; only no answer or a 5xx
    // is 'uncertain' (give: the key is kept and the same tip offered again; like: just "could not reach").
    async function outcome(r, domain, mode, kind) {
        if ( r.status === 200 || r.status === 201 ) {
            const out = kind ? { ok: true, kind } : { ok: true };
            if ( r.body?.replayed === true ) { out.replayed = true; }
            return out;
        }
        const code = r.body?.error;
        if ( r.status === 0 || r.status >= 500 ) {
            log(`thankmu: ${kind ?? 'like'} got no definite answer (status ${r.status})`);
            return { ok: false, error: kind ? UNCERTAIN : 'unavailable' };
        }
        if ( r.status === 401 ) { return { ok: false, error: 'unpaired' }; }
        if ( r.status === 402 ) { return { ok: false, error: 'insufficient' }; }
        if ( r.status === 409 && code === 'idempotency_conflict' ) {
            // The key was used before: the earlier tip or pledge landed. Definite; the card says so.
            return { ok: false, error: 'already_sent' };
        }
        if ( r.status === 409 && code === 'publisher_blocked' ) {
            await statusOf(domain, true);
            return { ok: false, error: 'blocked' };
        }
        if ( r.status === 409 && (code === 'publisher_not_payable' || code === 'not_partner' || code === 'use_tip') ) {
            const current = await statusOf(domain, true);
            if ( current === 'blocked' ) { return { ok: false, error: 'blocked' }; }
            const next = code === 'use_tip' ? 'tip' : 'pledge';
            if ( current !== null && (current === 'partner' ? 'tip' : 'pledge') === next && next !== mode ) {
                return { ok: false, error: 'changed', mode: next };
            }
            // The app refused it (definite): nothing was recorded. The list disagrees, so say so in place rather than
            // switch the card to the other action.
            log(`thankmu: ${code} but the partner list still says ${current}`);
            return { ok: false, error: next === 'pledge' ? 'not_partner' : 'invalid' };
        }
        if ( r.status === 422 && Array.isArray(r.body?.fields) && r.body.fields.includes('amount_cents') ) {
            log('thankmu: the app refused a pledge amount; AMOUNTS_CENTS no longer matches PLEDGE_AMOUNTS_CENTS');
            return { ok: false, error: 'amounts_changed' };
        }
        if ( r.status === 422 ) {
            log(`thankmu: the app refused a ${kind ?? 'like'} as invalid`);
            return { ok: false, error: 'invalid' };
        }
        if ( r.status === 429 ) { return { ok: false, error: code === 'velocity_limited' ? 'velocity' : 'rate_limited' }; }
        // Any other answer is a refusal the contract does not name: definite, nothing recorded.
        log(`thankmu: ${kind ?? 'like'} refused (status ${r.status}${code ? `, ${code}` : ''})`);
        return { ok: false, error: 'invalid' };
    }

    // Shared preconditions for an action. Resolves { page, status } or an outcome to return as is.
    async function prepare(url) {
        const page = pageOf(url);
        if ( page === null ) { return { fail: { ok: false, error: 'invalid' } }; }
        // Paired first: signed out, nothing is fetched, the partner list included.
        if ( await paired() === false ) { return { fail: { ok: false, error: 'unpaired' } }; }
        // Switched off: no fetch either, even from a card drawn before the switch moved (it then removes itself).
        if ( await promptsOn() === false ) { return { fail: { ok: false, error: 'off' } }; }
        const status = await statusOf(page.domain);
        if ( status === null ) { return { fail: { ok: false, error: 'unavailable' } }; }
        if ( status === 'blocked' ) { return { fail: { ok: false, error: 'blocked' } }; }
        return { page, status };
    }

    async function like(url, meta, key) {
        if ( typeof key !== 'string' || KEY_RE.test(key) === false ) { return { ok: false, error: 'invalid' }; }
        const p = await prepare(url);
        if ( p.fail ) { return p.fail; }
        const body = {
            idempotency_key: key,
            domain: p.page.domain,
            path_hash: await pathHash(p.page.hashInput, digest),
            ...cleanMeta(meta),
        };
        return outcome(await post(LIKES_PATH, body), p.page.domain, p.status === 'partner' ? 'tip' : 'pledge');
    }

    // An entry: { key, cents, mode, body, at, account, settled? }. settled is the definite outcome once known ({ ok, kind } or
    // { ok: false, error }); without it the send is unresolved (in flight, or no definite answer yet).
    async function readEntry(slot) {
        const k = PENDING_PREFIX + slot;
        const v = (await session.get(k))?.[k];
        if ( !v || typeof v.key !== 'string' || typeof v.at !== 'number' || now() - v.at >= PENDING_TTL_MS ) { return undefined; }
        return v;
    }

    async function writeEntry(slot, entry) {
        await session.set({ [PENDING_PREFIX + slot]: entry });
    }

    // The key is the worker's, never the page's. One unresolved tip (and separately one unresolved pledge) per page:
    // another amount is refused ('pending') until that one has a definite answer; the same amount resends the same
    // body with the same key. retry: the card's "Try again" on an uncertain send. It never mints a key: it resends
    // the unresolved one, or answers the outcome the worker learnt since, or says it can't tell ('unknown_retry').
    // peek: report without sending: the settled outcome (as a replay), the open entry ('pending'), or 'none'.
    async function give(url, { mode, cents, meta, retry = false, peek = false } = {}) {
        if ( (mode !== 'tip' && mode !== 'pledge') || AMOUNTS_CENTS.includes(cents) === false ) {
            return { ok: false, error: 'invalid' };
        }
        const run = { late: false, sent: false };
        let timer;
        const deadline = new Promise(resolve => { timer = setTimeout(( ) => { run.late = true; resolve(null); }, giveDeadlineMs); });
        try {
            const out = await Promise.race([ giveWork(url, { mode, cents, meta, retry, peek }, run), deadline ]);
            if ( out !== null ) { return out; }
            log(`thankmu: ${mode} past its deadline (${run.sent ? 'sent, no answer yet' : 'not sent'})`);
            return { ok: false, error: run.sent ? UNCERTAIN : 'unavailable' };
        } finally {
            clearTimeout(timer);
        }
    }

    async function giveWork(url, { mode, cents, meta, retry, peek }, run) {
        const p = await prepare(url);
        if ( p.fail ) { return p.fail; }
        const hash = await pathHash(p.page.hashInput, digest);
        const account = await accountId();
        // No account known and /me could not say: nothing is written and nothing is sent (definite).
        if ( account === null ) { return { ok: false, error: 'unavailable' }; }
        const slot = `${account}|${mode}|${p.page.domain}|${hash}`;
        const raw = await readEntry(slot);
        // Belt and braces: an entry is only ever this account's (the key already says so).
        const entry = raw !== undefined && (raw.account ?? account) === account ? raw : undefined;
        if ( peek ) {
            if ( entry?.settled ) { return entry.settled.ok ? { ok: true, kind: mode, replayed: true } : { ...entry.settled }; }
            return entry ? { ok: false, error: 'pending', mode, cents: entry.cents } : { ok: false, error: 'none' };
        }
        if ( retry ) {
            if ( entry?.settled ) { return entry.settled.ok ? { ok: true, kind: mode, replayed: true } : { ...entry.settled }; }
            if ( entry === undefined ) { return { ok: false, error: 'unknown_retry' }; }
        }
        const open = entry !== undefined && entry.settled === undefined ? entry : undefined;
        if ( open && open.cents !== cents ) { return { ok: false, error: 'pending', mode, cents: open.cents }; }
        const actual = p.status === 'partner' ? 'tip' : 'pledge';
        if ( actual !== mode ) { return { ok: false, error: 'changed', mode: actual }; }
        if ( run.late ) { return null; }   // the card was told nothing went out: keep it so
        // A retry resends the stored body byte for byte: the app replays a key only when the body matches (its
        // fingerprint covers domain, amount, kind and the story), so the page's title changing meanwhile can't
        // turn a retry into a conflict.
        let current = open;
        if ( current === undefined ) {
            const key = randomKey();
            // W-T7 part B (merged): a spend carries kind, context and the story, like a pledge, so the reader's
            // Activity and feed show what the tip was for.
            const body = mode === 'tip'
                ? { idempotency_key: key, kind: 'tip', domain: p.page.domain, path_hash: hash, amount_cents: cents,
                    context: 'ad_slot', ...cleanMeta(meta) }
                : { idempotency_key: key, domain: p.page.domain, path_hash: hash, amount_cents: cents,
                    context: 'ad_slot', ...cleanMeta(meta) };
            current = { key, cents, mode, body, at: now(), account };
            await writeEntry(slot, current);
            if ( run.late ) {
                // Review C2: the card was told nothing went out. Take the unsent entry back, so that is the truth and
                // a later different amount is not refused as pending.
                await session.remove(PENDING_PREFIX + slot);
                return null;
            }
        }
        if ( run.late ) { return null; }
        run.sent = true;
        const out = await outcome(await post(mode === 'tip' ? SPENDS_PATH : PLEDGES_PATH, current.body), p.page.domain, mode, mode);
        // Settled either way but 'uncertain' and 'unpaired': kept for PENDING_TTL_MS, so a late retry learns the outcome
        // instead of sending again. A new tip (not a retry) after a settled one is a new tip, with a new key.
        // A 401 settles nothing (review of MR !19): an earlier send of this key may have landed, so after re-pairing the
        // same account resends the same key and the app replays it. Only a first send that got 401 is taken back:
        // the app refused it before recording anything, so no send of that key ever landed.
        if ( out.error === 'unpaired' ) {
            if ( open === undefined ) { await session.remove(PENDING_PREFIX + slot); }
            return out;
        }
        if ( out.error !== UNCERTAIN ) {
            const { ok, kind, error } = out;
            await writeEntry(slot, { ...current, at: now(), settled: ok ? { ok, kind } : { ok, error } });
        }
        return out;
    }

    // What may this page show? Storage reads only, never the network, in every state:
    //   go:   the tip jar is on (paired, switch on) and the cards are not dismissed here today: look for emptied slots
    //         and show a card in each (check() then fetches the partner list, once a slot is found);
    //   pill: signed out, switch on, the pill not dismissed here today, and no partner list cached from an earlier
    //         session says the property blocked ThankMu (a cached list is read, never fetched or refreshed): the
    //         static corner pill, once the page has an emptied slot.
    // Switched off means neither, signed in or out (decision recorded in docs/rebrand.md "Signed out: the pill").
    async function gate(url) {
        const none = { go: false, pill: false };
        const page = pageOf(url);
        if ( page === null || normalizeDomain(appHost) === page.domain ) { return none; }
        if ( await promptsOn() === false ) { return none; }
        if ( await paired() ) { return { go: (await dismissals())[page.domain] === undefined, pill: false }; }
        if ( (await dismissals(TIPJAR_KEYS.pillDismissed))[page.domain] !== undefined ) { return none; }
        const cached = await read(TIPJAR_KEYS.partners);
        if ( Array.isArray(cached?.entries) && propertyStatus(cached.entries, page.domain) === 'blocked' ) { return none; }
        return { go: false, pill: true };
    }

    // The tip jar's state for a hop the card offers (the reload handoff): 'on', 'off' or 'unpaired'. Storage only.
    async function jarState() {
        if ( await paired() === false ) { return 'unpaired'; }
        return await promptsOn() ? 'on' : 'off';
    }

    async function balance() {
        if ( await paired() === false ) { return { ok: false, error: 'unpaired' }; }
        if ( await promptsOn() === false ) { return { ok: false, error: 'off' }; }
        let r;
        try {
            r = await apiFetch(BALANCE_PATH, { method: 'GET', cache: 'no-store' });
        } catch {
            return { ok: false, error: 'unavailable' };
        }
        if ( r.status === 401 ) { return { ok: false, error: 'unpaired' }; }
        const cents = r.body?.balance_cents;
        if ( r.status !== 200 || Number.isInteger(cents) === false ) { return { ok: false, error: 'unavailable' }; }
        return { ok: true, balance_cents: cents };
    }

    return { check, gate, like, give, balance, jarState, dismiss, dismissPill, undismiss, promptsState, setPromptsOn, refreshPartners: partners };
}

// The chrome.runtime.onMessage listener for the ad-slot content script ('thankmu:slot-*'). sw.js's other listener
// refuses every sender that is not an extension page; this one accepts only this extension's content script in the
// top frame of an http(s) tab, and takes the page address from sender.url (set by the browser), never from the
// message. Replies are the tip jar's outcomes; never a token, a handoff code or an error text.
export function contentListener({ tipjar, extensionId, openSignup, openReload, amounts = AMOUNTS_CENTS }) {
    return (msg, sender, sendResponse) => {
        const what = msg?.what;
        if ( typeof what !== 'string' || what.startsWith('thankmu:slot-') === false ) { return; }
        if ( sender?.id !== extensionId || typeof sender?.tab?.id !== 'number' || sender.frameId !== 0 ) { return; }
        const url = sender.url;
        if ( pageOf(url) === null ) { return; }
        let job;
        switch ( what ) {
        case 'thankmu:slot-gate':
            job = tipjar.gate(url);
            break;
        case 'thankmu:slot-check':
            job = tipjar.check(url).then(r => (r.show ? { ...r, amounts: [ ...amounts ] } : r));
            break;
        case 'thankmu:slot-like':
            job = tipjar.like(url, msg.meta, msg.key);
            break;
        case 'thankmu:slot-give':
            job = tipjar.give(url, { mode: msg.mode, cents: msg.cents, meta: msg.meta, retry: msg.retry === true, peek: msg.peek === true });
            break;
        case 'thankmu:slot-balance':
            job = tipjar.balance();
            break;
        case 'thankmu:slot-dismiss':
            job = tipjar.dismiss(url).then(d => (d ? { ok: true } : { ok: false, error: 'invalid' }));
            break;
        case 'thankmu:slot-undismiss':
            job = tipjar.undismiss(url).then(( ) => ({ ok: true }));
            break;
        // The signed-out pill: its × (not today on this site), and its one action, the reader sign-up that returns to
        // pairing (pairing.js signupUrl; storage and a new tab, no request).
        case 'thankmu:slot-pill-dismiss':
            job = tipjar.dismissPill(url).then(d => (d ? { ok: true } : { ok: false, error: 'invalid' }));
            break;
        case 'thankmu:slot-signup':
            job = openSignup().then(( ) => ({ ok: true }));
            break;
        // The card's one hop into the app: the reload offer, on the reader's click, to /wallet/topup (pairing.js
        // HANDOFF_PAGES.reload). The card never opens the app otherwise (W-T1, E2E-02).
        // Only with the tip jar on: a card left on a page after Sign out or the switch never opens a handoff.
        case 'thankmu:slot-reload':
            job = tipjar.jarState().then(s => (s === 'on' ? openReload() : { ok: false, error: s }));
            break;
        default:
            return;
        }
        job.then(sendResponse, ( ) => sendResponse({ ok: false, error: 'unavailable' }));
        return true;
    };
}
