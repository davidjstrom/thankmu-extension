// W-T1 single purpose (founder 2026-11-02; ADR-013 "In-page surfaces, by state"), run by tests/popup/run.sh inside
// the pinned Playwright image (never in CI: it needs docker). Loads the REAL built extension, signed out, and records
// every network request it makes, two ways:
//   (1) the worker's own fetch, wrapped (every call, any URL, passed through to the real fetch);
//   (2) every request the browser context reports, the service worker's included (Playwright's service-worker
//       network events, PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1, set by run.sh).
// The app's host is mapped to 127.0.0.1 (nothing listens there on 443), so no request can reach a real ThankMu server;
// a request that is attempted still shows in both recorders. It checks:
//   signed out: pages with emptied slots and the popup make NO request (only the local test site's own page loads);
//     no card in any slot; one corner pill, bottom-right, fixed to the viewport, the D1 glyph and at most four
//     words, 44 px targets, visible at 200% text; it moves bottom-left off a fixed control, hides when both corners
//     cover one, and under 320 px shows only where it covers nothing; × hides it on that domain for the day (another
//     domain still shows it); its one action opens /signup/reader#next=/pair… and nothing else;
//   pairing turns the tip jar on: back on the tab, the pill goes and the cards come (and with them the first request,
//     the partner list);
//   a revoked token (401 on a like) takes the page back to the pill, with no request after the 401;
//   switched off (popup) while signed out: no pill, no card, no request; the popup's real switch takes cards already
//     on a page down at once, and an unresolved tip first shows "We can't tell…" and keeps its key;
//   a fixed widget added after load moves the pill; a browser restart, signed out, makes no request;
//   positive control: signed in, the same recorders DO see the partner-list request, so "nothing recorded" above
//     means nothing was sent, not that the recorders were blind.
// Usage: node signedout_e2e.mjs <unpacked extension dir> <output dir>. Exit 0 only if every check passed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const [extDir, outDir] = process.argv.slice(2);
if (!extDir || !outDir) { console.error("usage: signedout_e2e.mjs <extension dir> <output dir>"); process.exit(2); }
const SITE = "harbordaily.example", OTHER = "otherdaily.example", PORT = 8080;
const slot = id => `<div class="ad-slot" id="ad-${id}-container" style="width:300px;height:250px"><div id="ad-${id}"></div></div>`;
const para = n => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1} of the story, with <a href="#n${i}">a link</a> in it.</p>`).join("\n");
const page = (extra = "", body = para(30)) => `<!doctype html><html><head><meta charset="utf-8"><title>Harbor Daily</title>
<style>body{font:16px sans-serif;max-width:700px;margin:auto;padding:0 8px} main{display:flex;gap:24px} article{flex:1}</style></head><body>
<h1>Ferry timetable returns to winter hours</h1>
<main><article>${slot("in-content")}${body}</article><aside>${slot("sidebar")}</aside></main>${extra}</body></html>`;
const PAGES = {
  "/story": page(),
  // A fixed chat button in the bottom-right corner: the pill moves bottom-left.
  "/chat": page(`<button id="chat" style="position:fixed;right:16px;bottom:16px;width:64px;height:64px">Chat</button>`),
  // A fixed cookie bar across the whole bottom: both corners would cover it, so no pill.
  "/bar": page(`<div id="cookies" style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#eee"><button>Accept</button></div>`),
  // A short page: under 320 px wide the bottom corner covers nothing, so the pill may show.
  "/short": page("", "<p>Short.</p>"),
  // A busy page for the pill's cost (review of MR !19, retry 2): thestreet-shaped (20 slots in sidebar and article, 60
  // paragraphs with links, nav), a ticker that rewrites itself every 100 ms and a live clock row, and the meta that
  // turns on the pill's performance.measure entries.
  "/busy": page(`<div id="ticker" style="position:sticky;top:0;background:#eee">…</div>
<script>let n = 0; setInterval(() => { document.getElementById("ticker").innerHTML = Array.from({ length: 12 }, (_, i) => '<span>' + ['AAPL','MSFT','NVDA','GOOG'][i % 4] + ' ' + (100 + ((n * 7 + i * 13) % 50)).toFixed(2) + '</span> ').join(""); n++; }, 100);</script>`,
    Array.from({ length: 10 }, (_, i) => slot(`busy-a${i}`) + para(6)).join("\n")).replace("<head>", '<head><meta name="thankmu-perf" content="1">'),
};
const server = http.createServer((q, r) => {
  r.setHeader("content-type", "text/html; charset=utf-8");
  r.end(PAGES[new URL(q.url, "http://x").pathname] ?? PAGES["/story"]);
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

let ok = true;
const check = (n, c, d = "") => { if (!c) ok = false; console.log(`${c ? "  ok  " : "  FAIL"} ${n}${d ? ` -- ${d}` : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The app host comes from the build; read it before launching so it can be mapped to 127.0.0.1.
const config = fs.readFileSync(path.join(extDir, "js/thankmu/config.js"), "utf8");
const appOrigin = /APP_ORIGIN = "([^"]+)"/.exec(config)[1];
const appHost = new URL(appOrigin).host;

// A real profile directory, so the browser can be started a second time on it (the worker's start-up path, below).
const profile = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "thankmu-signedout-"));
const ctxRequests = [];
const launch = async () => {
  const c = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
      `--host-resolver-rules=MAP ${SITE} 127.0.0.1, MAP ${OTHER} 127.0.0.1, MAP ${appHost} 127.0.0.1`] });
  // Recorder (2): everything the context reports. The test site's own page loads are expected; nothing else is.
  c.on("request", r => ctxRequests.push({ url: r.url(), sw: Boolean(r.serviceWorker?.()) }));
  return c;
};
let ctx = await launch();
const foreign = list => list.filter(r => !r.url.startsWith(`http://${SITE}:${PORT}/`) && !r.url.startsWith(`http://${OTHER}:${PORT}/`) &&
  !r.url.startsWith("chrome-extension://") && !r.url.startsWith("data:") && !r.url.startsWith("about:"));
try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  await sleep(4000);   // the worker can be replaced once while upstream registers its rulesets
  sw = ctx.serviceWorkers().at(-1);
  const base = `chrome-extension://${new URL(sw.url()).host}`;

  // Recorder (1): the worker's fetch, every call, passed through. stub: answer the app's paths with fake data instead
  // (for the signed-in steps only); 401 on likes when revoke is set. Tabs the extension opens are recorded and opened
  // as about:blank (nothing reaches a real app).
  const hook = (opts = {}) => sw.evaluate(async ({ origin, opts }) => {
    globalThis.__real ??= globalThis.fetch.bind(globalThis);
    globalThis.__seen ??= [];
    globalThis.__tabs ??= [];
    const reply = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    globalThis.fetch = async (input, init = {}) => {
      const u = new URL(typeof input === "string" ? input : input.url);
      globalThis.__seen.push(`${(init.method || "GET").toUpperCase()} ${u.href}`);
      if (!opts.stub || u.origin !== origin) return globalThis.__real(input, init);
      if (u.pathname === "/api/publishers/partners") return reply(200, { entries: opts.partner ? [{ domain: "harbordaily.example", status: "partner" }] : [], truncated: false });
      if (u.pathname === "/api/ledger/balance") return reply(200, { balance_cents: 1250, promotional_cents: 1250, purchased_cents: 0, currency: "usd" });
      if (u.pathname === "/api/ledger/spends") return reply(503, {});   // landed or not: the card can't tell
      if (u.pathname === "/api/likes") return opts.revoke ? reply(401, { detail: "Unauthorized" }) : reply(201, { id: "l", property_status: "unknown" });
      return reply(404, { error: "not_stubbed" });
    };
    if (!globalThis.__tabsHooked) {
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = p => { globalThis.__tabs.push(p.url); return create({ url: "about:blank" }); };
      globalThis.__tabsHooked = true;
    }
  }, { origin: appOrigin, opts });
  const seen = () => sw.evaluate(() => globalThis.__seen.slice());
  const tabs = () => sw.evaluate(() => globalThis.__tabs.slice());
  const store = (set, remove) => sw.evaluate(async ({ set, remove }) => { await chrome.storage.local.remove(remove); await chrome.storage.local.set(set); }, { set, remove });
  const TOKEN = { "thankmu.token": "tmc_" + "f".repeat(43), "thankmu.clientId": "c", "thankmu.account": "u" };
  const KEYS = ["thankmu.token", "thankmu.clientId", "thankmu.account", "thankmu.revoked", "thankmu.prompts.off", "thankmu.prompts.dismissed",
    "thankmu.pill.dismissed", "thankmu.partners"];

  // What the page shows: the cards, and the pill's box (its shadow root is closed; the host is enough to measure).
  const shown = p => p.evaluate(() => {
    const pills = [...document.querySelectorAll("thankmu-pill")];
    const h = pills[0];
    const r = h?.getBoundingClientRect();
    const cs = h ? getComputedStyle(h) : null;
    return { cards: document.querySelectorAll("thankmu-card").length, pills: pills.length,
      pill: h ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        visible: cs.visibility === "visible", position: cs.position, inHtml: h.parentElement === document.documentElement,
        vw: document.documentElement.clientWidth, vh: innerHeight } : null };
  });
  // The pill's inner layout through the DevTools protocol (pierce), which the page itself cannot read.
  const pillInside = async p => {
    const cdp = await ctx.newCDPSession(p);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const out = { text: "", svg: false, buttons: [] };
    const walk = async n => {
      if (n.nodeName === "svg") out.svg = true;
      if (n.nodeName === "BUTTON") {
        const { model } = await cdp.send("DOM.getBoxModel", { nodeId: n.nodeId }).catch(() => ({ model: null }));
        const label = (n.attributes ?? []).reduce((a, v, i, arr) => (v === "aria-label" ? arr[i + 1] : a), "");
        out.buttons.push({ label, w: model?.width, h: model?.height });
      }
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) await walk(c);
    };
    const find = n => (n.nodeName === "THANKMU-PILL" ? n : [...(n.children ?? [])].map(find).find(Boolean));
    const host = find(root);
    if (host) {
      const text = n => (n.nodeType === 3 ? n.nodeValue : n.nodeName === "STYLE" ? "" : [...(n.shadowRoots ?? []), ...(n.children ?? [])].map(text).join(" "));
      out.text = text(host).replace(/[×\s]+/g, " ").trim();
      await walk(host);
    }
    await cdp.detach();
    return out;
  };
  const load = async (pathname, { host = SITE, width = 1200, fontPx } = {}) => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width, height: 800 });
    if (fontPx) {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Page.setFontSizes", { fontSizes: { standard: fontPx, fixed: fontPx } });
    }
    await p.goto(`http://${host}:${PORT}${pathname}`);
    await p.waitForTimeout(7000);   // an empty slot counts after two looks (1.5 s and 5 s)
    return p;
  };
  const clickPill = async (p, which) => {
    const s = (await shown(p)).pill;
    // The × is the last 44 px of the pill; the action is everything before it.
    const x = which === "hide" ? s.right - 24 : s.left + 24;
    await p.mouse.click(x, s.top + s.height / 2);
    await p.waitForTimeout(800);
  };

  // --- signed out ------------------------------------------------------------------------------------------------
  await hook();
  await store({}, KEYS);
  await sleep(500);
  const ctxBefore = ctxRequests.length;
  {
    const p = await load("/story");
    const s = await shown(p);
    check("signed out: no card in any emptied slot", s.cards === 0, JSON.stringify(s));
    check("signed out: one pill on the page, outside the page's boxes (a fixed host under <html>)", s.pills === 1 && s.pill?.position === "fixed" && s.pill.inHtml, JSON.stringify(s.pill));
    check("pill: bottom-right, 16 px from the viewport's edges, visible", s.pill?.visible && Math.abs(s.pill.vw - 16 - s.pill.right) <= 1 && Math.abs(s.pill.vh - 16 - s.pill.bottom) <= 1, JSON.stringify(s.pill));
    const inside = await pillInside(p);
    const words = inside.text.split(/\s+/).filter(Boolean);
    check("pill: the D1 glyph and at most four words", inside.svg && words.length >= 1 && words.length <= 4, JSON.stringify(inside.text));
    check("pill: every target at least 44 px", inside.buttons.length === 2 && inside.buttons.every(b => b.w >= 44 && b.h >= 44), JSON.stringify(inside.buttons));
    check("pill: its labels name ThankMu (attribution on the element)", inside.buttons[0]?.label.startsWith("ThankMu"), JSON.stringify(inside.buttons));
    await p.screenshot({ path: `${outDir}/signedout-pill.png` });
    await clickPill(p, "go");
    const t = await tabs();
    const next = t[0] ? new URLSearchParams(new URL(t[0]).hash.slice(1)).get("next") : null;
    check("pill: its one action opens /signup/reader#next=/pair#install=…&ext=…", t.length === 1 && t[0].startsWith(`${appOrigin}/signup/reader#next=`) &&
      /^\/pair#install=[A-Za-z0-9_-]+&ext=[a-p]{32}$/.test(next ?? ""), JSON.stringify(t));
    await clickPill(p, "hide");
    check("pill: × removes it", (await shown(p)).pills === 0);
    await p.close();
    const again = await load("/story");
    check("pill: hidden on that domain for the day (a reload shows none)", (await shown(again)).pills === 0);
    await again.close();
    const other = await load("/story", { host: OTHER });
    check("pill: another domain still shows it", (await shown(other)).pills === 1);
    await other.close();
    await store({}, ["thankmu.pill.dismissed"]);
  }
  {
    const p = await load("/chat");
    const s = (await shown(p)).pill;
    check("pill: a fixed control in the bottom-right corner moves it bottom-left", s?.visible && Math.abs(s.left - 16) <= 1, JSON.stringify(s));
    await p.screenshot({ path: `${outDir}/signedout-pill-chat.png` });
    await p.close();
  }
  {
    const p = await load("/story");
    check("late widget: the pill starts bottom-right", Math.abs((await shown(p)).pill.right - 1184) <= 1);
    await p.evaluate(() => document.body.insertAdjacentHTML("beforeend",
      '<button id="late" style="position:fixed;right:20px;bottom:24px;width:20px;height:20px;padding:0">?</button>'));
    await p.waitForTimeout(800);
    const s = (await shown(p)).pill;
    check("late widget: a small fixed button added after load moves the pill bottom-left at once", s?.visible && Math.abs(s.left - 16) <= 1, JSON.stringify(s));
    await p.close();
  }
  {
    // The pill's cost on a busy page: 12 s with a ticker mutating every 100 ms. Numbers go in the MR.
    const p = await load("/busy");
    await p.waitForTimeout(12000);
    const m = await p.evaluate(() => {
      const st = name => { const d = performance.getEntriesByName(name).map(e => e.duration).sort((a, b) => a - b);
        const q = f => d.length ? d[Math.min(d.length - 1, Math.floor(f * d.length))] : null;
        return { n: d.length, total: +d.reduce((a, b) => a + b, 0).toFixed(2), p50: q(0.5), p95: q(0.95), max: d.at(-1) ?? null }; };
      return { place: st("thankmu-pill-place"), observe: st("thankmu-pill-observe"), check: st("thankmu-pill-check"), elements: document.querySelectorAll("*").length };
    });
    console.log(`    pill cost on /busy over ~19 s (${m.elements} elements, ticker every 100 ms): place ${JSON.stringify(m.place)} ms; observer callback ${JSON.stringify(m.observe)} ms; idle check ${JSON.stringify(m.check)} ms`);
    check("pill cost: the ticker does not re-place the pill (it changes nothing near the corners)", m.place.n > 0 && m.place.n <= 5, JSON.stringify(m.place));
    check("pill cost: the observer callback stays under 0.5 ms at p95 (no layout read), the idle check under 2 ms, each placement under 16 ms",
      m.observe.n > 50 && m.observe.p95 < 0.5 && (m.check.n === 0 || m.check.p95 < 2) && m.place.max < 16, JSON.stringify(m));
    await p.close();
  }
  {
    const p = await load("/bar");
    const s = (await shown(p)).pill;
    check("pill: a fixed bar under both corners hides it", s && s.visible === false, JSON.stringify(s));
    await p.close();
  }
  {
    const p = await load("/story", { width: 300 });
    const s = (await shown(p)).pill;
    check("pill: under 320 px wide, over the story's text, it does not render", s && s.visible === false, JSON.stringify(s));
    await p.close();
    const q = await load("/short", { width: 300 });
    await q.evaluate(() => scrollTo(0, 0));
    await q.waitForTimeout(400);
    const t = (await shown(q)).pill;
    check("pill: under 320 px wide with nothing under the corner, it shows and fits", t?.visible && t.left >= 0 && t.right <= t.vw, JSON.stringify(t));
    await q.close();
  }
  {
    const p = await load("/short", { fontPx: 32 });
    const s = (await shown(p)).pill;
    const inside = await pillInside(p);
    check("pill: at 200% text (32 px default font) it grows, stays whole in the viewport and visible",
      s?.visible && s.height >= 60 && s.left >= 0 && s.right <= s.vw && s.bottom <= s.vh, JSON.stringify({ s, b: inside.buttons }));
    await p.screenshot({ path: `${outDir}/signedout-pill-200.png` });
    await p.close();
  }
  {
    // The popup, signed out (as a tab: the same page the toolbar shows).
    const p = await ctx.newPage();
    await p.goto(`${base}/popup.html`);
    await p.waitForTimeout(4000);
    await p.close();
  }
  {
    const s = await seen();
    check("signed out: the worker made no request at all (pages with emptied slots, the pill, its click, the popup)", s.length === 0, JSON.stringify(s));
    const f = foreign(ctxRequests.slice(ctxBefore));
    check("signed out: the browser saw no request to ThankMu or anywhere else (only the local test pages)", f.length === 0, JSON.stringify(f));
  }

  // --- switched off while signed out: nothing at all ---------------------------------------------------------------
  {
    await store({ "thankmu.prompts.off": true }, []);
    const p = await load("/story");
    const s = await shown(p);
    check("switched off, signed out: no pill and no card", s.pills === 0 && s.cards === 0, JSON.stringify(s));
    await p.close();
    check("switched off: still no request", (await seen()).length === 0, JSON.stringify(await seen()));
    await store({}, ["thankmu.prompts.off"]);
  }

  // --- signed out and switched off, then a pairing (two storage events): the cards come without leaving the tab ----
  {
    await hook({ stub: true });
    await store({ "thankmu.prompts.off": true }, KEYS);
    const p = await load("/story");
    const s0 = await shown(p);
    check("signed out and off: nothing on the page", s0.cards === 0 && s0.pills === 0, JSON.stringify(s0));
    // What pairing.js handleExternal does: the token, then the off switch cleared, back to back (two events).
    await sw.evaluate(async t => { await chrome.storage.local.set(t); await chrome.storage.local.remove(["thankmu.prompts.off"]); }, TOKEN);
    await p.waitForTimeout(7000);
    const s = await shown(p);
    check("paired with the jar off, same tab: the cards appear (no event dropped)", s.cards === 2 && s.pills === 0, JSON.stringify(s));
    await p.close();
    await store({}, KEYS);
    await sw.evaluate(() => { globalThis.__seen.length = 0; });
    await hook();
  }

  // --- pairing turns the tip jar on: the pill goes, the cards come ------------------------------------------------
  {
    const p = await load("/story");
    check("before pairing: the pill", (await shown(p)).pills === 1);
    await hook({ stub: true });
    await store(TOKEN, ["thankmu.prompts.off"]);   // what a successful pairing stores (pairing.js handleExternal)
    await p.waitForTimeout(7000);                  // no tab switch: the page follows the storage change itself
    const s = await shown(p);
    check("paired: the pill is gone and each emptied slot has its card", s.pills === 0 && s.cards === 2, JSON.stringify(s));
    const after = await seen();
    check("paired: the first request is the partner list", after.length >= 1 && after[0] === `GET ${appOrigin}/api/publishers/partners`, JSON.stringify(after));

    // --- a revoked token (401 on a like) returns the page to the pill, with no request after the 401 -------------
    await hook({ stub: true, revoke: true });
    await p.evaluate(() => { const s = document.getElementById("ad-sidebar-container"); s.tabIndex = -1; s.scrollIntoView({ block: "center" }); s.focus(); });
    await p.waitForTimeout(800);
    await p.keyboard.press("Tab"); await p.keyboard.press("Enter");   // Like
    await p.waitForTimeout(1500);
    const at401 = (await seen()).length;
    await p.waitForTimeout(7000);
    const r = await shown(p);
    const tail = (await seen()).slice(at401);
    check("revoked: the cards go and the pill comes back", r.cards === 0 && r.pills === 1, JSON.stringify(r));
    check("revoked: no request after the 401", tail.length === 0 && (await seen()).at(at401 - 1) === `POST ${appOrigin}/api/likes`, JSON.stringify(await seen()));
    const tok = await sw.evaluate(() => chrome.storage.local.get("thankmu.token"));
    check("revoked: the token is gone", tok["thankmu.token"] === undefined);
    await p.close();
  }

  // --- the popup's real switch: off takes the cards down at once, with no request -----------------------------------
  const popupSwitch = async () => {
    const pop = await ctx.newPage();
    await pop.goto(`${base}/popup.html`);
    await pop.waitForSelector("#thankmuPrompts", { timeout: 15000 });
    const f = () => pop.frames().find(x => x.url().includes("thankmu-popup.html") && !x.url().includes("part=head"));
    for (let i = 0; i < 50 && !f(); i++) await pop.waitForTimeout(100);
    await f().locator("#prompts:not([disabled])").waitFor({ timeout: 10000 });
    await f().click("#prompts");
    await pop.waitForTimeout(500);
    await pop.close();
  };
  {
    await hook({ stub: true });
    await store(TOKEN, ["thankmu.prompts.off", "thankmu.prompts.dismissed"]);
    const p = await load("/story");
    check("on: cards before the switch moves", (await shown(p)).cards === 2);
    const before = (await seen()).length;
    await popupSwitch();
    const off = await sw.evaluate(() => chrome.storage.local.get("thankmu.prompts.off"));
    await p.waitForTimeout(1000);
    const s = await shown(p);
    // Opening the popup signed in reads the reader's own account (GET /api/client/me, Q-20261102-1330-W-T1 answered A);
    // nothing else may go out.
    const fromPage = (await seen()).slice(before).filter(x => x !== `GET ${appOrigin}/api/client/me`);
    check("popup switch off: the cards go at once (no reload, no tab switch), no pill (signed in), no request but the popup's own /me",
      off["thankmu.prompts.off"] === true && s.cards === 0 && s.pills === 0 && fromPage.length === 0, JSON.stringify({ off, s, seen: (await seen()).slice(before) }));
    await popupSwitch();   // on again
    await p.waitForTimeout(7000);
    check("popup switch on again: the cards come back on the same page", (await shown(p)).cards === 2);
    await p.close();
  }

  // --- off with a tip unresolved: the cards say so first; the entry stays open ------------------------------------
  {
    await hook({ stub: true, partner: true });
    await store(TOKEN, ["thankmu.prompts.off", "thankmu.prompts.dismissed", "thankmu.partners"]);
    const p = await load("/story");
    const press = async n => {
      await p.evaluate(() => { const s = document.getElementById("ad-sidebar-container"); s.tabIndex = -1; s.scrollIntoView({ block: "center" }); s.focus(); });
      await p.waitForTimeout(700);
      for (let i = 0; i < n; i++) await p.keyboard.press("Tab");
      await p.keyboard.press("Enter");
      await p.waitForTimeout(1500);
    };
    await press(2);   // Tip
    await press(2);   // 50¢
    await press(1);   // Send: the stub answers 503, so the tip is unresolved
    const pending = await sw.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).filter(([k, v]) => k.startsWith("thankmu.pending|") && !v.settled).length);
    check("a tip with no definite answer is held open by the worker", pending === 1, String(pending));
    await popupSwitch();   // off
    await p.waitForTimeout(1200);
    const cdp = await ctx.newCDPSession(p);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    await cdp.detach();
    const text = n => (n.nodeType === 3 ? n.nodeValue : n.nodeName === "STYLE" ? "" : [...(n.shadowRoots ?? []), ...(n.children ?? [])].map(text).join(" "));
    const page = text(root);
    check("off with a tip unresolved: the cards first say \"We can't tell whether that went through. Check your wallet…\"",
      page.includes("We can't tell whether that went through. Check your wallet before you try again."), page.slice(0, 300));
    await p.waitForTimeout(8500);
    check("…then they go", (await shown(p)).cards === 0);
    const still = await sw.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).filter(([k, v]) => k.startsWith("thankmu.pending|") && !v.settled).length);
    check("off settled nothing: the tip's key is still held", still === 1, String(still));
    await p.close();
    await popupSwitch();   // back on for what follows
    await sw.evaluate(() => chrome.storage.session.clear());
  }

  // --- positive control: signed in, both recorders see the partner-list request -------------------------------
  {
    await hook();   // real fetch: the app host maps to 127.0.0.1, so the request is attempted and fails locally
    await sw.evaluate(() => { globalThis.__seen.length = 0; });
    await store(TOKEN, KEYS);
    const before = ctxRequests.length;
    const p = await load("/story");
    await p.close();
    const s = await seen();
    check("control: signed in, the worker recorder sees GET /api/publishers/partners", s.includes(`GET ${appOrigin}/api/publishers/partners`), JSON.stringify(s));
    const f = foreign(ctxRequests.slice(before));
    check("control: signed in, the browser-level recorder sees the worker's request to the app too",
      f.some(r => r.url === `${appOrigin}/api/publishers/partners`), JSON.stringify(f));
    await store({}, KEYS);
  }

  // --- the worker's start-up path, signed out: a second start of the same profile (onStartup, status()) --------------
  {
    await ctx.close();
    const before = ctxRequests.length;
    ctx = await launch();   // the browser-level recorder is attached as soon as the context exists
    await sleep(8000);
    const f = foreign(ctxRequests.slice(before));
    check("browser restart, signed out: the worker's start-up makes no request (as far as the browser log shows)", f.length === 0, JSON.stringify(f));
  }
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(`signed-out e2e: ${ok ? "all passed" : "FAILED"}`);
process.exit(ok ? 0 : 1);
