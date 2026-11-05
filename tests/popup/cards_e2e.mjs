// W-T1 follow-up (E2E-02), run by tests/popup/run.sh inside the pinned Playwright image (never in CI: it needs docker).
// Loads the REAL built extension into Chromium on local pages shaped like thestreet.com: slot <div>s holding an empty
// <div>, responsive variants the page hides with its own CSS, a live ad, a fixed-position slot, a slot in a flex row
// and a slot the page adds 7 s after load. Only the app is stubbed (in the worker); the fictional .example site
// resolves to a local server. The cards' closed shadow roots are read through the DevTools protocol (pierce), which
// the page itself cannot do. It checks:
//   placement: one card per emptied slot and none for the page-hidden variant, the live ad or the fixed slot; a card
//     for the late slot; each card over its empty box (placement B) except the one in the flex row, which follows it (A);
//     a covered slot that an ad fills later is uncovered at once (the card moves after it);
//   slot margins: over a 300x250 box with margins of 0, 16 px, 16 px bottom only and -8 px, the card's rect is the
//     box's and it covers nothing else on the page, at the top of the page and scrolled past every slot before the
//     cards appear, and again after a resize re-places them; in a centring column flex parent the card lands on the
//     box or cleanly after it;
//   pledge (an unknown site): a like shows "Liked." in every card; one Send is one POST /api/pledges, and every card
//     says "Pledged.";
//   tip (a partner site): a like shows in every card; one Send across N cards is one POST /api/ledger/spends, and
//     every card says "Tip sent.";
//   402: every card shows the shortfall and Reload; no tab opens until Reload is clicked, then exactly one, to
//     /open?…&next=/wallet/topup;
//   nothing else ever opens a tab.
// Usage: node cards_e2e.mjs <unpacked extension dir> <output dir>. Exit 0 only if every check passed.
import http from "node:http";
import { chromium } from "playwright";

const [extDir, outDir] = process.argv.slice(2);
if (!extDir || !outDir) { console.error("usage: cards_e2e.mjs <extension dir> <output dir>"); process.exit(2); }
const SITE = "harbordaily.example", PORT = 8080;
const slot = (id, extra = "") => `<div class="ad-slot" id="ad-${id}-container" style="width:322px;height:300px;display:flex${extra}"><div id="ad-${id}"></div></div>`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Harbor Daily</title>
<meta property="og:title" content="Ferry timetable returns to winter hours">
<style>.not-size-c{display:none!important} body{font:16px sans-serif;max-width:1100px;margin:auto} main{display:flex;gap:24px}
article{flex:1} aside{width:330px} .row{display:flex;gap:12px;align-items:flex-start}</style></head><body>
<h1>Ferry timetable returns to winter hours</h1>
<main><article><p>The harbour authority said the dredging is complete.</p>
<div class="ad-slot not-size-d" id="ad-in_content-a-container" style="width:640px;height:140px;display:flex"><div id="ad-in_content-a"></div></div>
<div class="ad-slot not-size-c" id="ad-in_content-b-container" style="width:640px;height:140px"><div id="ad-in_content-b"></div></div>
<p>More text.</p>
<div class="ad-slot" id="ad-live-container" style="width:300px;height:250px"><div id="ad-live"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="300" height="250"></div></div>
<div class="row">${slot("row")}<p>Text beside a slot in a flex row.</p></div>
</article><aside>${slot("sidebar-1")}${slot("sidebar-2")}</aside></main>
<div style="position:fixed;bottom:0;left:0;right:0">${slot("fixed_bottom")}</div>
<p style="height:1400px">end</p>
<script>setTimeout(() => { document.querySelector("aside").insertAdjacentHTML("beforeend", ${JSON.stringify(slot("sidebar-late"))}); }, 7000);</script>
</body></html>`;
// Slot margins (W-T1 follow-up, QA on dev): 300x250 empty slots in a block column with margins of 0, 16 px top and
// bottom, 16 px bottom only, and -8 px top and bottom, each between two lines of text (16 px margins); then one in a
// column flex parent that centres its children (the slot moves while the card is placed). The column is centred, so a
// narrower window moves every box and forces re-placement.
const MARGINS = [["m0", "0"], ["m16", "16px 0"], ["mb16", "0 0 16px"], ["mneg", "-8px 0"]];
const marginSlot = (id, m) => `<p class="txt" id="before-${id}">Text before ${id}.</p>
<div class="ad-slot" id="ad-${id}-container" style="width:300px;height:250px;margin:${m}"><div id="ad-${id}"></div></div>
<p class="txt" id="after-${id}">Text after ${id}.</p>`;
const MARGINS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Harbor Daily</title>
<meta property="og:title" content="Tide tables for the week">
<style>body{font:16px sans-serif;margin:0} main{width:640px;margin:20px auto} p.txt{margin:16px 0;background:#eee}</style></head><body>
<main>${MARGINS.map(([id, m]) => marginSlot(id, m)).join("\n")}
<div id="colflex" style="display:flex;flex-direction:column;justify-content:center;height:800px">${marginSlot("flex", "16px 0")}</div>
</main><p style="height:1400px">end</p></body></html>`;
const server = http.createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(q.url.startsWith("/margins") ? MARGINS_PAGE : PAGE); });
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

let ok = true;
const check = (n, c, d = "") => { if (!c) ok = false; console.log(`${c ? "  ok  " : "  FAIL"} ${n}${d ? ` -- ${d}` : ""}`); };
const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 1200, height: 900 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--host-resolver-rules=MAP ${SITE} 127.0.0.1`] });
try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));   // the worker can be replaced once while upstream registers its rulesets
  sw = ctx.serviceWorkers().at(-1);
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  const cfg = await ctx.newPage(); await cfg.goto(`${base}/js/thankmu/config.js`);
  const appOrigin = /APP_ORIGIN = "([^"]+)"/.exec(await cfg.locator("body").innerText())[1]; await cfg.close();
  // The app stub. partner: the site is a partner; spend: the status POST /api/ledger/spends answers.
  const stub = (opts) => sw.evaluate(async ({ origin, opts }) => {
    globalThis.__real ??= globalThis.fetch.bind(globalThis);
    globalThis.__seen = []; globalThis.__tabs = [];
    const reply = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    globalThis.fetch = async (input, init = {}) => {
      const u = new URL(typeof input === "string" ? input : input.url);
      if (u.origin !== origin) return globalThis.__real(input, init);
      const m = (init.method || "GET").toUpperCase(); globalThis.__seen.push(`${m} ${u.pathname}`);
      if (u.pathname === "/api/publishers/partners") return reply(200, { entries: opts.partner ? [{ domain: "harbordaily.example", status: "partner" }] : [], truncated: false });
      if (u.pathname === "/api/likes") return reply(201, { id: "l", property_status: opts.partner ? "partner" : "unknown" });
      if (u.pathname === "/api/pledges") return reply(201, { id: "p", expires_at: "2027-11-01T00:00:00Z" });
      if (u.pathname === "/api/ledger/balance") return reply(200, { balance_cents: 1250, promotional_cents: 1250, purchased_cents: 0, currency: "usd", promotional_expires_at: null });
      if (u.pathname === "/api/ledger/spends") return opts.spend === 402 ? reply(402, { error: "insufficient_funds" })
        : reply(201, { spend_id: "s", kind: "tip", amount_cents: 50, funded_cents: 0, domain: "harbordaily.example", replayed: false, balance: { balance_cents: 1200, promotional_cents: 1200 } });
      if (u.pathname === "/api/access/handoff") return reply(201, { code: "C".repeat(43), expires_in: 60 });
      return reply(404, { error: "not_stubbed" });
    };
    if (!globalThis.__tabsHooked) {
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = p => { globalThis.__tabs.push(p.url); return create({ url: "about:blank" }); };
      globalThis.__tabsHooked = true;
    }
    await chrome.storage.local.set({ "thankmu.token": "tmc_" + "f".repeat(43), "thankmu.clientId": "c", "thankmu.account": "u" });
    await chrome.storage.local.remove(["thankmu.partners", "thankmu.prompts.dismissed"]);
  }, { origin: appOrigin, opts });
  const seen = () => sw.evaluate(() => globalThis.__seen);
  const tabs = () => sw.evaluate(() => globalThis.__tabs);

  // Every card's text, read through the closed shadow roots with the DevTools protocol.
  const cardTexts = async page => {
    const cdp = await ctx.newCDPSession(page);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    await cdp.detach();
    const out = [];
    const text = n => (n.nodeType === 3 ? n.nodeValue : n.nodeName === "STYLE" ? "" :
      [...(n.shadowRoots ?? []), ...(n.children ?? [])].map(text).join(" "));
    const walk = n => { if (n.nodeName === "THANKMU-CARD") out.push(text(n).replace(/\s+/g, " ").trim()); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c); };
    walk(root);
    return out;
  };
  // Keyboard on one card (its shadow root is closed): focus the slot it belongs to, Tab n times, Enter.
  const press = async (page, slotId, tabsN = 1) => {
    await page.evaluate(id => { const s = document.getElementById(id); s.tabIndex = -1; s.scrollIntoView({ block: "center" }); s.focus(); }, slotId);
    await page.waitForTimeout(700);   // the card must have been visible for its arming time
    for (let i = 0; i < tabsN; i++) await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
  };
  const open = async (opts, path) => {
    await stub(opts);
    const page = await ctx.newPage();
    await page.goto(`http://${SITE}:${PORT}${path}`);
    await page.waitForTimeout(8000);
    return page;
  };

  // --- placement B whatever the slot's margins, the scroll position and the window size --------------------------
  {
    // Where each margins-page card is: on its box (B), or for the column flex slot cleanly after it (A); never over
    // anything but its own box.
    const where = page => page.evaluate(ids => ids.map(id => {
      const s = document.getElementById(`ad-${id}-container`), h = s.nextElementSibling;
      if (h?.tagName !== "THANKMU-CARD") return { id, card: h?.tagName ?? null };
      const a = s.getBoundingClientRect(), b = h.getBoundingClientRect();
      const hit = (x, y) => x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1;
      // Everything on the page that is not the slot, its content, a card or an ancestor of the card.
      const others = [...document.body.querySelectorAll("*")].filter(e => e !== s && !s.contains(e) && e.tagName !== "THANKMU-CARD" && !e.contains(h));
      const covered = others.filter(e => hit(e.getBoundingClientRect(), b)).map(e => e.id || e.tagName);
      return { id, card: h.tagName, slot: [a.left, a.top, a.width, a.height].map(Math.round), rect: [b.left, b.top, b.width, b.height].map(Math.round),
        on: ["left", "top", "right", "bottom"].every(k => Math.abs(a[k] - b[k]) <= 1), clear: !hit(a, b), covered };
    }), [...MARGINS.map(([id]) => id), "flex"]);
    const checkAll = (res, when) => {
      for (const [id, m] of MARGINS) {
        const r = res.find(x => x.id === id);
        check(`placement B with slot margin ${m}${when}: the card's rect sits on the box and covers nothing outside it`, r?.on === true && r.covered.length === 0, JSON.stringify(r));
      }
      const f = res.find(x => x.id === "flex");
      check(`column flex parent${when}: the card lands on the box or cleanly after it, covering nothing else`,
        f?.card === "THANKMU-CARD" && (f.on || f.clear) && f.covered.length === 0, JSON.stringify(f));
    };
    const page = await open({ partner: false }, "/margins");
    checkAll(await where(page), "");
    await page.screenshot({ path: `${outDir}/cards-margins.png`, fullPage: true });
    // A narrower window moves every box sideways: the cards are re-placed onto them.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(1000);
    checkAll(await where(page), ", after a resize");
    await page.close();

    // The reader scrolled past every slot before the cards appear (scroll anchoring moves the page while a card is
    // placed); then a resize re-places them while scrolled.
    await stub({ partner: false });
    const p2 = await ctx.newPage();
    await p2.goto(`http://${SITE}:${PORT}/margins?scrolled`);
    await p2.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await p2.waitForTimeout(8000);
    const y = await p2.evaluate(() => scrollY);
    check("the page was scrolled past every slot before the cards appeared", y > 1500, String(y));
    checkAll(await where(p2), ", scrolled past");
    await p2.setViewportSize({ width: 900, height: 900 });
    await p2.waitForTimeout(1000);
    checkAll(await where(p2), ", scrolled past, after a resize");
    await p2.close();
  }

  // --- pledge (an unknown site) and placement -------------------------------------------------------------
  {
    const page = await open({ partner: false }, "/pledge");
    const where = await page.evaluate(() => [...document.querySelectorAll("thankmu-card")].map(h => {
      const s = h.previousElementSibling, a = s.getBoundingClientRect(), b = h.getBoundingClientRect();
      return { slot: s.id, over: Math.abs(a.top - b.top) <= 1 && Math.abs(a.left - b.left) <= 1 && b.height >= a.height - 1, clear: b.top >= a.bottom - 1 || b.left >= a.right - 1, w: Math.round(b.width) };
    }));
    const ids = where.map(w => w.slot).sort();
    check("one card per emptied slot: in_content-a, row, sidebar-1, sidebar-2 (none for the page-hidden variant, the live ad or the fixed slot)",
      JSON.stringify(ids) === JSON.stringify(["ad-in_content-a-container", "ad-row-container", "ad-sidebar-1-container", "ad-sidebar-2-container"]), JSON.stringify(where));
    const by = id => where.find(w => w.slot === id);
    check("placement B: each card in a block column lies over its empty box", ["ad-in_content-a-container", "ad-sidebar-1-container", "ad-sidebar-2-container"].every(id => by(id)?.over), JSON.stringify(where));
    check("placement A: the card in a flex row follows its slot instead (beside it, never over it)", by("ad-row-container")?.clear === true && by("ad-row-container")?.over === false, JSON.stringify(by("ad-row-container")));
    await page.screenshot({ path: `${outDir}/cards-ask.png`, fullPage: true });
    // Review B2 (ADR-013): an ad arriving in a covered box later must never be under the card.
    await page.evaluate(() => {
      document.getElementById("ad-sidebar-2").innerHTML = '<iframe title="ad" style="width:300px;height:250px;border:0" src="about:blank"></iframe>';
    });
    await page.waitForTimeout(600);
    const filled = await page.evaluate(() => {
      const s = document.getElementById("ad-sidebar-2-container"), h = s.nextElementSibling;
      const a = s.getBoundingClientRect(), b = h?.getBoundingClientRect();
      return { card: h?.tagName, overlaps: b ? (b.left < a.right && a.left < b.right && b.top < a.bottom && a.top < b.bottom) : null };
    });
    check("B2: a covered slot that fills later is uncovered at once (the card moves after it, still shown)",
      filled.card === "THANKMU-CARD" && filled.overlaps === false, JSON.stringify(filled));
    await page.waitForTimeout(12000);
    check("a slot the page adds later gets its card too", (await page.evaluate(() => document.querySelectorAll("thankmu-card").length)) === 5);
    await press(page, "ad-sidebar-1-container");                         // Like
    let texts = await cardTexts(page);
    check("pledge: a like in one card shows in every card", texts.length === 5 && texts.every(t => t.includes("Liked.")), JSON.stringify(texts));
    await press(page, "ad-sidebar-1-container");                         // 25¢
    await press(page, "ad-sidebar-1-container");                         // Pledge 25¢
    texts = await cardTexts(page);
    const s = await seen();
    check("pledge: one Send is one POST /api/pledges and no spend", s.filter(x => x === "POST /api/pledges").length === 1 && !s.some(x => x.includes("spends")), JSON.stringify(s));
    check("pledge: every card says Pledged. and that nothing was charged", texts.every(t => t.includes("Pledged.") && t.includes("Nothing was charged")), JSON.stringify(texts[0]));
    await page.screenshot({ path: `${outDir}/cards-pledged.png`, fullPage: true });
    check("pledge: nothing opened a tab", (await tabs()).length === 0, JSON.stringify(await tabs()));
    await page.close();
  }

  // --- tip (a partner site) ----------------------------------------------------------------------------------
  {
    const page = await open({ partner: true }, "/tip");
    await press(page, "ad-sidebar-2-container");                         // Like (then the balance)
    let texts = await cardTexts(page);
    check("tip: a like in one card shows in every card, with the tip offer", texts.length >= 4 && texts.every(t => t.includes("Liked.") && t.includes("Add a tip?")), JSON.stringify(texts));
    await press(page, "ad-sidebar-2-container", 2);                      // 50¢
    await press(page, "ad-sidebar-2-container");                         // Send 50¢ tip
    texts = await cardTexts(page);
    const s = await seen();
    check(`tip: one Send across ${texts.length} cards is one POST /api/ledger/spends`, s.filter(x => x === "POST /api/ledger/spends").length === 1, JSON.stringify(s));
    check("tip: every card says Tip sent.", texts.every(t => t.includes("Tip sent.") && t.includes("50¢ to harbordaily.example")), JSON.stringify(texts[0]));
    check("tip: nothing opened a tab", (await tabs()).length === 0, JSON.stringify(await tabs()));
    await page.screenshot({ path: `${outDir}/cards-tipped.png`, fullPage: true });
    await page.close();
  }

  // --- 402: the shortfall in place, Reload only on its click -------------------------------------------------
  {
    const page = await open({ partner: true, spend: 402 }, "/short");
    await press(page, "ad-sidebar-1-container", 2);                      // Tip (skip Like)
    await press(page, "ad-sidebar-1-container", 2);                      // 50¢
    await press(page, "ad-sidebar-1-container");                         // Send
    const texts = await cardTexts(page);
    check("402: every card shows the shortfall with Reload", texts.every(t => t.includes("Not enough in your wallet for this tip.") && t.includes("Reload")), JSON.stringify(texts[0]));
    check("402: no tab opens by itself", (await tabs()).length === 0, JSON.stringify(await tabs()));
    await press(page, "ad-sidebar-1-container");                         // Reload
    const t = await tabs();
    check("402: Reload opens exactly one tab, the handoff to /wallet/topup", t.length === 1 && t[0] === `${appOrigin}/open?code=${"C".repeat(43)}&next=/wallet/topup`, JSON.stringify(t));
    await page.screenshot({ path: `${outDir}/cards-short.png`, fullPage: true });
    await page.close();
  }
} finally {
  await ctx.close();
  server.close();
}
console.log(`cards e2e: ${ok ? "all passed" : "FAILED"}`);
process.exit(ok ? 0 : 1);
