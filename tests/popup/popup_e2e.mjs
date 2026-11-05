// W-P6 popup check, run by tests/popup/run.sh inside the pinned Playwright image (never in CI: it needs docker).
// Loads a REAL built extension into Chromium and drives its real popup: every D2 state, light and dark, and every
// upstream control, to prove the ThankMu frames leave upstream's popup whole and working. What is staged:
//   * the page behind the popup is a local sample article (a fictional .example site) that requests three ad/tracker
//     scripts, which the blocker's real rules block; the popup is a normal tab, so chrome.tabs.query is pointed at
//     the article tab (what a toolbar popup gets from Chrome);
//   * ONLY the app is stubbed: the worker's calls to its origin (GET /api/client/me, POST /api/access/handoff) answer
//     fixed fake data, tabs it opens on the app get a blank page, and a fake token is put in chrome.storage.local
//     for the signed-in states. No real account, and no request reaches a real app server.
// Usage: node popup_e2e.mjs <unpacked extension dir> <output dir>. Exit 0 only if every check passed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [extDir, outDir] = process.argv.slice(2);
if (!extDir || !outDir) { console.error("usage: popup_e2e.mjs <extension dir> <output dir>"); process.exit(2); }
const SITE = "harbordaily.example", PORT = 8080;
const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Harbor Daily</title></head><body>
<h1>Ferry timetable returns to winter hours</h1><p>The harbour authority said the dredging is complete.</p>
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
<script src="https://www.google-analytics.com/analytics.js"></script></body></html>`;
const UPSTREAM = ["#hostname", ".filteringModeSlider", "#filteringModeText", "#gotoZapper", "#gotoPicker", "#gotoReport", "#gotoDashboard"];
const CODE = "C".repeat(43);

const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`); };

const server = http.createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(ARTICLE); });
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
fs.mkdirSync(outDir, { recursive: true });
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--host-resolver-rules=MAP ${SITE} 127.0.0.1`],
});
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  // The worker can be replaced once while upstream registers its rulesets (a first run once got a worker without
  // chrome.tabs): wait, then take the newest.
  await new Promise(r => setTimeout(r, 4000));
  sw = ctx.serviceWorkers().at(-1);
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  const cfg = await ctx.newPage();
  await cfg.goto(`${base}/js/thankmu/config.js`);
  const appOrigin = /APP_ORIGIN = "([^"]+)"/.exec(await cfg.locator("body").innerText())[1];
  await cfg.close();
  // A tab the extension opens on the app is recorded and opened as about:blank instead (Playwright cannot route a
  // navigation the extension starts): nothing here ever reaches a real app server. Other tabs open as usual.
  await sw.evaluate(origin => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    globalThis.__appTabs = [];
    chrome.tabs.create = props => {
      if (typeof props?.url === "string" && props.url.startsWith(origin)) { globalThis.__appTabs.push(props.url); return create({ ...props, url: "about:blank" }); }
      return create(props);
    };
  }, appOrigin);
  const appTab = async () => { for (let i = 0; i < 50; i++) { const t = await sw.evaluate(() => globalThis.__appTabs.shift()); if (t) return t; await new Promise(r => setTimeout(r, 100)); } return null; };
  await new Promise(r => setTimeout(r, 3000));   // let upstream's worker register its rulesets
  const article = await ctx.newPage();
  const loadArticle = async () => { await article.goto(`http://${SITE}:${PORT}/`); await article.waitForTimeout(1500); };
  await loadArticle();
  const tab = await sw.evaluate(async p => (await chrome.tabs.query({ url: p }))[0], `http://${SITE}/*`);
  const badge = () => sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tab.id);

  // The app stub: me is the /api/client/me answer for this state; every app call is recorded.
  // handoff429: the handoff answers 429 with Retry-After 3600 (the longest wait the popup names, "60 minutes").
  const stub = (me, { handoff429 = false } = {}) => sw.evaluate(({ origin, me, code, handoff429 }) => {
    globalThis.__real ??= globalThis.fetch.bind(globalThis);
    globalThis.__seen = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = async (input, init = {}) => {
      const u = new URL(typeof input === "string" ? input : input.url);
      if (u.origin !== origin) return globalThis.__real(input, init);
      const m = (init.method || "GET").toUpperCase();
      globalThis.__seen.push(`${m} ${u.pathname}`);
      if (m === "GET" && u.pathname === "/api/client/me") return me.status === 200 ? reply(200, me.body) : reply(me.status, {});
      if (m === "POST" && u.pathname === "/api/access/handoff") {
        if (handoff429) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "3600" } });
        return reply(201, { code, expires_in: 60 });
      }
      if (u.pathname === "/api/publishers/partners") return reply(200, { entries: [], truncated: false });
      return reply(404, { error: "not_stubbed" });
    };
  }, { origin: appOrigin, me, code: CODE, handoff429 });
  const meBody = (balance, promo, likes) => ({ client_id: "c", kind: "plugin", external_id: "x", household_id: "h", user_id: "u",
    wallet: { balance_cents: balance, promotional_cents: promo, currency: "usd", sandbox: true },
    counts: { tips_30d: 2, likes_30d: 1, likes_total: likes }, limits: { spend_24h_remaining_cents: 4800 } });
  const setStore = (set, remove) => sw.evaluate(async ({ set, remove }) => {
    await chrome.storage.local.remove(remove); await chrome.storage.local.set(set);
  }, { set, remove });
  const TOKEN = { "thankmu.token": "tmc_" + "f".repeat(43), "thankmu.clientId": "fake-client" };
  const ACCOUNT_KEYS = ["thankmu.token", "thankmu.clientId", "thankmu.revoked", "thankmu.pairingStartedAt"];

  const STATES = {
    "signed-out": { me: { status: 200, body: {} }, set: {} },
    "pairing": { me: { status: 200, body: {} }, set: { "thankmu.pairingStartedAt": "NOW" } },
    "signed-in": { me: { status: 200, body: meBody(2675, 675, 14) }, set: TOKEN },
    "welcome-credit-used": { me: { status: 200, body: meBody(10, 10, 3) }, set: TOKEN },
    // E2E-02 step 7: a small but non-empty wallet ($5.00, all promotional) keeps Add money; no Reload.
    "small-wallet": { me: { status: 200, body: meBody(500, 500, 1) }, set: TOKEN },
    "unreachable": { me: { status: 500 }, set: TOKEN },
  };

  // opts (the height matrix below): url shows the popup for another page of the same tab (upstream's hostname and
  // the hidden-on line follow it); noBadge = what a store build's popup gets from Chrome (no count, so no "ads
  // blocked here" chip); badge = the count Chrome hands back instead of the real one; noAnswer = the worker's ThankMu
  // part never answers (the "could not reach the app" body); unpicker = upstream shows its "Remove a custom filter"
  // row, as it does on a site with custom filters (the tallest upstream block); failPair = the worker never takes the
  // Sign in / Open the tab again message (the popup's own "Could not open the connect page.").
  // The popup's content height: the bottom of upstream's <main> (which holds both ThankMu frames) plus the body's own
  // bottom margin and padding. Not scrollHeight, which never drops below the viewport it was measured in.
  const contentHeight = () => {
    const b = getComputedStyle(document.body);
    return Math.ceil(document.querySelector("main").getBoundingClientRect().bottom + window.scrollY +
      parseFloat(b.marginBottom) + parseFloat(b.paddingBottom));
  };
  async function openPopup(scheme = "light", opts = {}) {
    const popup = await ctx.newPage();
    await popup.emulateMedia({ colorScheme: scheme });
    await popup.addInitScript(({ t, o }) => {   // runs in the popup and in both ThankMu frames
      const shown = o.url ? { ...t, url: o.url } : t;
      chrome.tabs.query = async () => [shown];
      if (o.noBadge) chrome.action.getBadgeText = async () => "";
      if (o.badge) chrome.action.getBadgeText = async () => o.badge;
      if (o.noAnswer) {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = msg => (msg?.what === "thankmu:popup-state" ? Promise.resolve(undefined) : send(msg));
      }
      if (o.failPair) {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = msg => (msg?.what === "thankmu:pair" ? Promise.reject(new Error("no answer")) : send(msg));
      }
    }, { t: tab, o: opts });
    await popup.setViewportSize({ width: 200, height: 300 });
    await popup.goto(`${base}/popup.html`);
    await popup.waitForSelector("#thankmuPrompts", { timeout: 15000 });
    await popup.waitForTimeout(1500);
    if (opts.unpicker) await popup.evaluate(() => document.getElementById("gotoUnpicker").classList.add("enabled"));
    // Like Chrome: as wide as the content's minimum, then as tall as the content at that width (measured from a short
    // viewport, so the first narrow measurement never inflates the height).
    const w = await popup.evaluate(() => Math.ceil(document.documentElement.scrollWidth));
    await popup.setViewportSize({ width: w, height: 100 });
    await popup.waitForTimeout(400);
    const size = { w, h: await popup.evaluate(contentHeight) };
    await popup.setViewportSize({ width: size.w, height: size.h });
    await popup.waitForTimeout(400);
    return { popup, size };
  }
  const frame = (popup, part) => popup.frames().find(f => f.url().includes("thankmu-popup.html") && (part === "head") === f.url().includes("part=head"));

  // Upstream's controls: present, visible, and the topmost element at their centre (no frame on top of them).
  const uncovered = popup => popup.evaluate(sels => sels.map(s => {
    const el = document.querySelector(s); if (!el) return [s, "missing"];
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return [s, "no box"];
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return [s, el.contains(hit) ? "ok" : `covered by ${hit?.tagName}#${hit?.id}`];
  }), UPSTREAM);

  // Height: Chrome caps a toolbar popup at 600 px and scrolls the rest; the founder's rule is no scroll, ever. Every
  // state must fit whole, in its smallest and its largest form. "max": upstream's "Remove a custom filter" row (shown
  // on a site with the reader's own custom filters, upstream's tallest block); a 150-character host, long enough to
  // wrap upstream's hostname row to three lines (one or two lines fit the row's 3-line min-height and cost nothing; a
  // third would, so the head frame caps it at two, popupfit.js capHostname, and the run checks it did); the hidden-on
  // line for that host; the promotional line; a $99,999.99 balance; and both chips at the longest count the popup
  // accepts (7 digits). "error" is "max" after a real failed click (popup.js showError): the handoff answers 429 with
  // a 60-minute wait (the longest message, waitText caps longer waits at "later") or, before sign-in, the pairing
  // message is refused; the state "could not reach the app" has no control that can fail, so it has no error case.
  // "min" has none of them. Neither frame may scroll inside or overflow sideways, and the floors hold (text 16 px,
  // buttons 44 px, inline links and the switch row 24 px).
  const LONG_HOST = "news.online-edition.riverside-county-evening-ledger-and-gazette-weekly-advertiser." +
    "northern-harbour-coast-and-islands-regional-newspapers-group.example";
  const ERRORS = { rate: "Too many attempts to open your account. Try again in 60 minutes.", pair: "Could not open the connect page." };
  const POPUP_MAX_H = 600;
  const HEIGHT_STATES = {
    "signed-out": { me: { status: 200, body: {} }, set: {}, fail: ["#signIn", "pair"] },
    "revoked": { me: { status: 200, body: {} }, set: { "thankmu.revoked": true }, fail: ["#signIn", "pair"] },
    "pairing": { me: { status: 200, body: {} }, set: { "thankmu.pairingStartedAt": "NOW" }, fail: ["#pairAgain", "pair"] },
    "signed-in": { me: { status: 200, body: meBody(9999999, 999999, 9999999) }, meMin: { status: 200, body: meBody(2675, 0, undefined) }, set: TOKEN, fail: ["#feed", "rate"] },
    "used-up": { me: { status: 200, body: meBody(10, 10, 9999999) }, meMin: { status: 200, body: meBody(10, 0, undefined) }, set: TOKEN, fail: ["#feed", "rate"] },
    "unreachable": { me: { status: 500 }, set: TOKEN, fail: ["#feed", "rate"] },
    "unavailable": { me: { status: 200, body: {} }, set: TOKEN, noAnswer: true },
  };
  const geometry = async popup => ({ total: await popup.evaluate(contentHeight), ...await popup.evaluate(() => {
    const h = document.getElementById("thankmuHead").getBoundingClientRect();
    const b = document.getElementById("thankmuPrompts").getBoundingClientRect();
    const inner = id => {
      const d = document.getElementById(id).contentDocument.documentElement;
      return { sh: d.scrollHeight, ch: d.clientHeight, sw: d.scrollWidth, cw: d.clientWidth };
    };
    const host = document.getElementById("hostname");
    return { width: Math.ceil(document.documentElement.scrollWidth), hostTitle: host.title,
      head: Math.round(h.height), upstream: Math.round(b.top - h.bottom), body: Math.round(b.height),
      frames: { head: inner("thankmuHead"), body: inner("thankmuPrompts") } };
  }) });
  // The floors, in one frame: every visible text at 16 px or more, buttons and the close button 44 px, inline links and
  // the switch row 24 px (the switch is the one relaxed target, docs/rebrand.md "Popup"); and the hidden-on line on
  // one line, its full sentence in the title.
  const floors = f => f.evaluate(() => {
    const bad = [];
    const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    for (const el of document.querySelectorAll("body *")) {
      if (!shown(el)) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() !== "");
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (own && fs < 16) bad.push(`${el.id || el.className || el.tagName} text ${fs}px`);
      const r = el.getBoundingClientRect();
      if (el.matches(".tm-btn, .pp-x") && r.height < 44) bad.push(`${el.id || el.className} ${r.height}px tall`);
      if (el.matches(".tm-link, .pp-switch") && r.height < 24) bad.push(`${el.id || el.className} ${r.height}px tall`);
    }
    // Room for the focus ring (3 px outline, 2 px offset) of every focusable inside its frame (the x draws it inside).
    const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
    for (const el of document.querySelectorAll("button, input, a[href]")) {
      if (!shown(el) || el.matches(".pp-x")) continue;
      const r = el.getBoundingClientRect();
      if (r.left - 5 < 0 || r.top - 5 < 0 || r.right + 5 > W || r.bottom + 5 > H) bad.push(`${el.id}'s focus ring is cut by the frame`);
    }
    const x = document.getElementById("close");   // the head frame: the close button ends the band, stats or not
    if (x && shown(x) && Math.abs(x.getBoundingClientRect().right - document.documentElement.clientWidth) > 1) bad.push("× is not at the band's right end");
    const hidden = document.getElementById("hidden");
    if (hidden && shown(hidden)) {
      const lh = parseFloat(getComputedStyle(hidden).lineHeight);
      if (hidden.getBoundingClientRect().height >= 2 * Math.max(lh, 24)) bad.push(`#hidden wraps (${hidden.getBoundingClientRect().height}px)`);
      if (hidden.title !== `Hidden on ${document.getElementById("hiddenDomain").textContent} for today.`) bad.push(`#hidden title is "${hidden.title}"`);
    }
    return bad;
  });
  const heights = [];
  for (const [name, st] of Object.entries(HEIGHT_STATES)) {
    for (const size of st.fail ? ["min", "max", "error"] : ["min", "max"]) {
      const big = size !== "min";
      await stub(!big && st.meMin ? st.meMin : st.me, { handoff429: size === "error" });
      const set = Object.fromEntries(Object.entries(st.set).map(([k, v]) => [k, v === "NOW" ? Date.now() : v]));
      if (big) set["thankmu.prompts.dismissed"] = { [LONG_HOST]: Date.now() + 3600e3 };
      await setStore(set, [...ACCOUNT_KEYS, "thankmu.prompts.dismissed", "thankmu.prompts.off"]);
      const opts = big ? { url: `https://${LONG_HOST}/2026/10/31/ferry-timetable`, badge: "9999999", unpicker: true, noAnswer: st.noAnswer, failPair: size === "error" }
        : { noBadge: true, noAnswer: st.noAnswer };
      for (const scheme of ["light", "dark"]) {
        const { popup } = await openPopup(scheme, opts);
        if (size === "error") {   // a real failed click: popup.js shows the message (showError)
          const [sel] = st.fail;
          await frame(popup, "body").click(sel);
          await frame(popup, "body").locator("#error").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
          await popup.waitForTimeout(400);
        }
        const g = await geometry(popup);
        heights.push({ name, size, scheme, ...g });
        await popup.screenshot({ path: path.join(outDir, `height-${name}-${size}-${scheme}.png`), fullPage: true });
        const f = g.frames;
        const what = `${g.total}px (head ${g.head} + upstream ${g.upstream} + account ${g.body}, ${g.width}px wide)`;
        check(`height ${name} ${size} ${scheme}: ${what} <= ${POPUP_MAX_H}px`,
          g.total <= POPUP_MAX_H && f.head.sh <= f.head.ch && f.body.sh <= f.body.ch && f.head.sw <= f.head.cw && f.body.sw <= f.body.cw,
          JSON.stringify(f));
        const below = [...await floors(frame(popup, "head")), ...await floors(frame(popup, "body"))];
        check(`floors ${name} ${size} ${scheme}: 16 px text, 44 px buttons, 24 px links and switch, one-line hidden-on, × at the end, focus rings inside`, below.length === 0, below.join("; "));
        if (size === "error" && scheme === "light") {
          const shown = await frame(popup, "body").evaluate(() => ({ error: document.getElementById("error").getClientRects().length > 0,
            yields: [...document.querySelectorAll(".pp-yield")].filter(e => e.getClientRects().length > 0).map(e => e.id || e.className) }));
          const text = await frame(popup, "body").locator("#error").textContent();
          check(`height ${name} error: "${text}" shows in place of the yielding lines`,
            shown.error && text === ERRORS[st.fail[1]] && shown.yields.length === 0, JSON.stringify(shown));
        }
        if (size === "max" && scheme === "light") {
          const body = frame(popup, "body"), head = frame(popup, "head");
          const want = { "signed-in": ["#wallet", "#promo", "#hidden"], "used-up": ["#wallet", "#promo", "#reload", "#hidden"],
            "unreachable": ["#unverified", "#hidden"], "revoked": ["#revoked"], "unavailable": ["#unavailable", "#hidden"],
            // Signed out the tip jar is off: no switch and no hidden-on line (W-T1, founder 2026-11-02).
            "signed-out": [], "pairing": [] }[name] ?? ["#hidden"];
          const missing = [];
          for (const sel of want) if (!(await body.locator(sel).isVisible())) missing.push(sel);
          if (["signed-in", "used-up"].includes(name) && !(await head.locator("#stat-likes").isVisible())) missing.push("#stat-likes");
          if (!(await head.locator("#stat-here").isVisible())) missing.push("#stat-here");
          if (g.hostTitle !== LONG_HOST) missing.push(`#hostname not capped at two lines (title "${g.hostTitle}")`);
          check(`height ${name} max: the worst case really shows its optional lines`, missing.length === 0, missing.join(" "));
        }
        await popup.close();
      }
    }
  }
  console.log("    heights (px, light/dark): " + heights.filter(h => h.scheme === "light").map(h => {
    const d = heights.find(x => x.name === h.name && x.size === h.size && x.scheme === "dark");
    return `${h.name} ${h.size} ${h.total}/${d.total} (head ${h.head}, upstream ${h.upstream}, account ${h.body})`;
  }).join("; "));
  await setStore({}, [...ACCOUNT_KEYS, "thankmu.prompts.dismissed"]);

  // POPUP_HEIGHTS_ONLY=1 (tests/popup/run.sh --heights): only the height matrix above, for fast layout work.
  if (process.env.POPUP_HEIGHTS_ONLY !== "1") {
    for (const [name, st] of Object.entries(STATES)) {
      await stub(st.me);
      const set = Object.fromEntries(Object.entries(st.set).map(([k, v]) => [k, v === "NOW" ? Date.now() : v]));
      await setStore(set, ACCOUNT_KEYS);
      for (const scheme of ["light", "dark"]) {
        const { popup, size } = await openPopup(scheme);
        const file = path.join(outDir, `popup-${name}-${scheme}.png`);
        await popup.screenshot({ path: file, fullPage: true });
        const bad = (await uncovered(popup)).filter(([, v]) => v !== "ok");
        check(`${name} ${scheme}: upstream controls visible and uncovered`, bad.length === 0, JSON.stringify(bad));
        const body = frame(popup, "body"), head = frame(popup, "head");
        const vis = async (f, id) => f.locator(`#${id}`).isVisible();
        if (scheme === "light") {
          const text = await body.locator("body").innerText();
          const htext = await head.locator("body").innerText();
          console.log(`    ${name}: ${size.w}x${size.h}px; head: ${JSON.stringify(htext)}; body: ${JSON.stringify(text)}`);
          if (name === "signed-out") check("signed out: pitch, Sign in, Join free; no wallet; no tip-jar switch", await vis(body, "signedOut") && !(await vis(body, "wallet")) && !(await vis(body, "switches")) && text.includes("Sign in to turn on your tip jar."));
          if (name === "signed-in") check("signed in: the Tip jar switch", await vis(body, "switches") && text.includes("Tip jar"));
          if (name === "pairing") check("pairing: Finish in the ThankMu tab + Open the tab again", await vis(body, "pairing") && text.includes("Open the tab again"));
          if (name === "signed-in") check("signed in: $26.75, includes $6.75 promotional credit, 14 likes, no reload nudge",
            text.includes("$26.75") && text.includes("includes $6.75 promotional credit") && htext.includes("14") && htext.includes("likes") && !(await vis(body, "reload")));
          if (name === "welcome-credit-used") check("welcome credit used up: the reload nudge", await vis(body, "reload") && text.includes("Your balance is too low to tip."));
          if (name === "welcome-credit-used") check("used up: Reload to keep tipping replaces Add money", await vis(body, "reloadLink") && !(await vis(body, "addMoney")));
          if (name === "signed-in" || name === "small-wallet") check(`${name}: a non-empty wallet keeps Add money and shows no Reload`,
            await vis(body, "addMoney") && !(await vis(body, "reloadLink")) && !(await vis(body, "reload")) && !text.includes("Reload"));
          if (name === "signed-in" || name === "small-wallet" || name === "welcome-credit-used") {
            // The footer's links are separate controls: on one line each pair has a visible rule between them, and
            // no wallet link shares the footer's line.
            const geo = await body.evaluate(() => {
              const ids = ["feed", "settings", "signOut"].map(id => document.getElementById(id));
              const r = ids.map(e => e.getBoundingClientRect());
              const ruled = ids.slice(1).map(e => parseFloat(getComputedStyle(e).borderLeftWidth) >= 1 && getComputedStyle(e).borderLeftStyle !== "none");
              const gaps = r.slice(1).map((b, i) => (Math.abs(b.top - r[i].top) < 2 ? b.left - r[i].right : 99));
              const foot = document.querySelector(".pp-foot").getBoundingClientRect();
              const wl = ["addMoney", "reloadLink"].map(id => document.getElementById(id)).filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect());
              return { ruled, gaps, walletInFoot: wl.some(w => w.top >= foot.top - 1) };
            });
            check(`${name}: footer links visibly separate (a rule between each, gap >= 8 px), wallet link not in the footer`,
              geo.ruled.every(Boolean) && geo.gaps.every(g => g >= 8) && !geo.walletInFoot, JSON.stringify(geo));
          }
          if (name === "unreachable") check("unreachable: no wallet, no likes, connection kept", !(await vis(body, "wallet")) && !(await vis(head, "stat-likes")) && await vis(body, "unverified"));
          check(`${name}: ads blocked here = the badge (${await badge()})`, (await vis(head, "stat-here")) === /^[1-9][0-9]*$/.test(await badge()));
        }
        await popup.close();
      }
    }

    // ThankMu buttons (signed in): each opens the app through the handoff with its own next.
    await stub(STATES["signed-in"].me); await setStore(TOKEN, ACCOUNT_KEYS);
    for (const [id, next] of [["feed", "/feed"], ["addMoney", "/wallet/topup"], ["settings", "/settings"]]) {
      const { popup } = await openPopup();
      await frame(popup, "body").click(`#${id}`);
      const u = await appTab();
      check(`${id} opens /open with next=${next}`, u === `${appOrigin}/open?code=${CODE}&next=${next}`, u);
      await popup.close();
    }
    { // Sign out -> signed-out body; Sign in -> pairing tab + pairing body
      const { popup } = await openPopup();
      const body = frame(popup, "body");
      await body.click("#signOut");
      await body.locator("#signedOut").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      check("Sign out returns the popup to Sign in / Join free", await body.locator("#signedOut").isVisible());
      await body.click("#signIn");
      const u = await appTab();
      check("Sign in opens the pairing page", u?.startsWith(`${appOrigin}/pair#install=`), u);
      await body.locator("#pairing").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      check("after Sign in the popup says Finish in the ThankMu tab", await body.locator("#pairing").isVisible());
      await popup.close();
    }
    { // Join free opens the reader sign-up, which returns to this install's pairing page (W-T10 carries next)
      await setStore({}, ACCOUNT_KEYS);
      const { popup } = await openPopup();
      await frame(popup, "body").click("#join");
      const u = await appTab();
      const next = u ? new URLSearchParams(new URL(u).hash.slice(1)).get("next") : null;
      check("Join free opens the reader sign-up with next=/pair#install=…&ext=…", u?.startsWith(`${appOrigin}/signup/reader#next=`) && /^\/pair#install=[A-Za-z0-9_-]+&ext=[a-p]{32}$/.test(next ?? ""), u);
      await popup.close();
    }

    // Upstream's controls still work through the ThankMu popup.
    {
      const before = await badge();
      const { popup } = await openPopup();
      await popup.click('.filteringModeSlider span[data-level="0"]');
      await popup.waitForTimeout(1500);
      const mode0 = await popup.locator("#filteringModeText span").first().innerText();
      await popup.close();
      await loadArticle();
      const off = await badge();
      const { popup: p2 } = await openPopup();
      await p2.click('.filteringModeSlider span[data-level="2"]');
      await p2.waitForTimeout(1500);
      const mode2 = await p2.locator("#filteringModeText span").first().innerText();
      await p2.close();
      await loadArticle();
      const on = await badge();
      check(`filtering mode applies: blocked ${before} -> "${mode0}" ${JSON.stringify(off)} -> "${mode2}" ${on}`,
        /^[1-9]/.test(before) && !/^[1-9]/.test(off) && /^[1-9]/.test(on));
    }
    for (const [sel, want] of [["#gotoReport", "/report.html"], ["#gotoDashboard", "/dashboard.html"]]) {
      const { popup } = await openPopup();
      const opened = ctx.waitForEvent("page", { timeout: 10000 });
      await popup.click(sel);
      const p = await opened;
      check(`${sel} opens ${want}`, new URL(p.url()).pathname === want, p.url());
      await p.close(); await popup.close().catch(() => {});
    }
    { // Remove an element: upstream injects its zapper into the article, then closes the popup.
      const { popup } = await openPopup();
      const n0 = await article.evaluate(() => document.querySelectorAll("*").length);
      await popup.click("#gotoZapper");
      await article.waitForTimeout(1500);
      const n1 = await article.evaluate(() => document.querySelectorAll("*").length);
      check("#gotoZapper injects the element zapper into the page", n1 > n0, `${n0} -> ${n1} elements`);
      await popup.close().catch(() => {});
      await loadArticle();
    }
    // Where focus lands after each of n Tabs: an upstream id, or <frame id>><element id> inside a ThankMu frame.
    const tabOrder = async (popup, n = 16) => {
      const order = [];
      for (let i = 0; i < n; i++) {
        await popup.keyboard.press("Tab");
        order.push(await popup.evaluate(() => {
          const a = document.activeElement;
          if (a?.tagName === "IFRAME") {
            const f = a.contentDocument?.activeElement; return `${a.id}>${f?.id || f?.tagName}`;
          }
          return a?.id || a?.className || a?.tagName;
        }));
      }
      return order;
    };
    { // Keyboard, signed in with the hidden-on line (W-P6 compact: Open your feed moved to the footer): the order runs
      // head x, upstream's tools, then the wallet, the switch, Show again and the footer links. The last link's focus
      // ring is photographed (keyboard-signed-in-signOut.png) to show it is not cut by the frame's bottom edge.
      await stub(STATES["signed-in"].me);
      await setStore({ ...TOKEN, "thankmu.prompts.dismissed": { [SITE]: Date.now() + 3600e3 } }, [...ACCOUNT_KEYS, "thankmu.prompts.dismissed"]);
      const { popup } = await openPopup();
      const want = ["thankmuHead>close", "gotoZapper", "gotoPicker", "gotoReport", "gotoDashboard", "thankmuPrompts>addMoney",
        "thankmuPrompts>showAgain", "thankmuPrompts>prompts", "thankmuPrompts>feed", "thankmuPrompts>settings", "thankmuPrompts>signOut"];
      const order = await tabOrder(popup, want.length);   // focus stays on Sign out for the photo
      console.log(`    keyboard tab order, signed in: ${order.join(" | ")}`);
      check("keyboard, signed in: x, upstream's tools, Add money, Show again, the switch, Open your feed, Settings, Sign out",
        JSON.stringify(order) === JSON.stringify(want), order.join(" | "));
      await popup.screenshot({ path: path.join(outDir, "keyboard-signed-in-signOut.png") });
      await popup.close();
      await setStore({}, [...ACCOUNT_KEYS, "thankmu.prompts.dismissed"]);
    }
    { // Keyboard: the tab order through the frames and upstream's controls, and what Enter does on a focused tool.
      const { popup } = await openPopup();
      const order = await tabOrder(popup);
      console.log(`    keyboard tab order: ${order.join(" | ")}`);
      check("keyboard reaches upstream's tools and the ThankMu buttons", order.includes("gotoReport") && order.some(o => o.startsWith("thankmuPrompts>")) && order.some(o => o.startsWith("thankmuHead>")));
      await popup.focus("#gotoReport");
      const opened = ctx.waitForEvent("page", { timeout: 3000 }).catch(() => null);
      await popup.keyboard.press("Enter");
      const p = await opened;
      console.log(`    Enter on a focused upstream tool (#gotoReport): ${p ? "opens " + p.url() : "does nothing (upstream: click only)"}`);
      if (p) await p.close();
      await popup.close();
    }
  }
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter(r => !r.ok);
console.log(`popup e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
