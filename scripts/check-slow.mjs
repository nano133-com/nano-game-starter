#!/usr/bin/env node
// The slow-network check: `npm run check:slow`.
//
// It builds the game, serves dist/client on 127.0.0.1 (Brotli for text files, no compression for .glb, the
// _headers file's security headers: what Cloudflare does), and opens it in Chrome with the network slowed down:
//   Slow 4G  1.6 Mbps down, 750 kbps up, 150 ms latency
//   3G       400 kbps down, 400 kbps up, 400 ms latency
// on a phone (390x844) first, then a tablet and a computer. Each run starts with an empty cache and prints
//   bytes  what the browser downloaded before Play was ready (compressed, as sent)
//   paint  when the start card first showed (first contentful paint)
//   ready  when the Play key said "Play" and the game could start
// Then it breaks the network on purpose (a failed script, a new deploy, a stalled script, a part that fails after the
// start) and checks that the page says the right thing and offers the right key (pictures in dist/slow-check/). It
// fails when a number is over its budget (BUDGET below) or a broken network shows the wrong thing.
//
//   npm run check:slow                 build, then check
//   npm run check:slow -- --no-build   check the build that is there
//   npm run check:slow -- --phone      the phone only
//   npm run check:slow -- --no-faults  the numbers only
//
// It needs Google Chrome installed (it uses your Chrome, with its sandbox on; it downloads no browser).

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { brotliCompressSync, constants as zlib } from "node:zlib";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist", "client");
const SHOTS = join(ROOT, "dist", "slow-check");
const args = new Set(process.argv.slice(2));

/**
 * The budget, for the PHONE (the slowest device here). From the starter's own numbers (2026-11-02: 222 KB; the card at
 * 0.5 s on Slow 4G and 1.6 s on 3G; Play ready at 1.5 s and 5.5 s):
 * - bytes 300 KB: the starter, with about 80 KB of room for a creator's own level, art and code. At 3G (50 KB a second)
 *   300 KB is about 6 s of download, so Play is still ready before the 8 s "Still loading" note.
 * - paint 2 s / 3 s: the start card is plain HTML and CSS and needs no script. A white screen longer than that loses players.
 * - ready 4 s / 8 s: Play works within 4 s on Slow 4G (a normal weak phone signal), and on 3G before the page would say
 *   "Still loading. Your connection is slow." (8 s).
 * A bigger game raises a number here only with a reason (and loads what it can later, with import()).
 */
const BUDGET = {
  bytes: 300 * 1024,
  slow4g: { paint: 2000, ready: 4000 },
  "3g": { paint: 3000, ready: 8000 },
};

const NETS = {
  slow4g: { label: "Slow 4G", offline: false, downloadThroughput: (1.6e6 / 8) | 0, uploadThroughput: (750e3 / 8) | 0, latency: 150 },
  "3g": { label: "3G", offline: false, downloadThroughput: (400e3 / 8) | 0, uploadThroughput: (400e3 / 8) | 0, latency: 400 },
};
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DEVICES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD },
  computer: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

// ---- build ----

if (!args.has("--no-build")) {
  const built = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
if (!existsSync(join(DIST, "index.html"))) {
  console.error("No build in dist/client. Run `npm run build` first.");
  process.exit(1);
}

// ---- a local server like Cloudflare's ----

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
};
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".svg"]);

/** The headers of the "/*" block of dist/client/_headers (the security headers). */
function siteHeaders() {
  const out = {};
  let inAll = false;
  for (const line of readFileSync(join(DIST, "_headers"), "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) inAll = line.trim() === "/*";
    else if (inAll) {
      const at = line.indexOf(":");
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return out;
}
const HEADERS = siteHeaders();
const packed = new Map();

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.startsWith("/api/")) {
    res.writeHead(404, { ...HEADERS, "content-type": "application/json" });
    return res.end('{"error":"no server in this check"}');
  }
  const file = normalize(join(DIST, path === "/" ? "index.html" : path));
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, HEADERS);
    return res.end("Not found");
  }
  const ext = extname(file);
  let body = readFileSync(file);
  const head = { ...HEADERS, "content-type": TYPES[ext] ?? "application/octet-stream" };
  if (path.startsWith("/assets/")) head["cache-control"] = "public, max-age=31536000, immutable";
  if (COMPRESS.has(ext) && /\bbr\b/.test(req.headers["accept-encoding"] ?? "")) {
    if (!packed.has(file)) packed.set(file, brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }));
    body = packed.get(file);
    head["content-encoding"] = "br";
  }
  res.writeHead(200, head);
  res.end(body);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- the browser ----

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", chromiumSandbox: true });
} catch (e) {
  console.error(`Could not start Google Chrome: ${String(e.message).split("\n")[0]}\nInstall Google Chrome, then run the check again.`);
  server.close();
  process.exit(1);
}

const PAINT = () => {
  window.__slow = { fcp: null };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__slow.fcp = Math.round(e.startTime);
    }).observe({ type: "paint", buffered: true });
  } catch {}
};
const READY = `(() => { const p = document.getElementById("play"); return !!p && !p.disabled && !!window.__gemIsland; })()`;

async function until(page, expr, ms, every = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await page.evaluate(expr)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

const kindOf = (url) => {
  const ext = extname(new URL(url).pathname);
  return ext === ".js" ? "js" : ext === ".css" ? "css" : ext === ".glb" ? "model" : [".webp", ".png", ".jpg", ".svg"].includes(ext) ? "image" : ext === ".html" || !ext ? "html" : "other";
};

async function measure(device, net) {
  const ctx = await browser.newContext(DEVICES[device]);
  await ctx.addInitScript(PAINT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", NETS[net]);
  const reqs = new Map();
  cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, bytes: 0, done: false }));
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r) Object.assign(r, { bytes: e.encodedDataLength, done: true });
  });
  const limit = 60000;
  await page.goto(BASE + "/", { waitUntil: "commit" });
  const ok = await until(page, READY, limit);
  const ready = ok ? await page.evaluate(() => Math.round(performance.now())) : null;
  const fcp = await page.evaluate(() => window.__slow?.fcp ?? null);
  const by = {};
  let bytes = 0;
  for (const r of reqs.values()) {
    if (!r.url.startsWith(BASE)) continue;
    bytes += r.bytes;
    by[kindOf(r.url)] = (by[kindOf(r.url)] ?? 0) + r.bytes;
  }
  // What loads on its own in the 5 s after Play is ready (sounds, models, art that waits for later must not).
  const before = new Set(reqs.keys());
  await page.waitForTimeout(5000);
  const after = [...reqs.entries()].filter(([id, r]) => !before.has(id) && r.url.startsWith(BASE)).map(([, r]) => new URL(r.url).pathname);
  await ctx.close();
  return { device, net, ready, fcp, bytes, by, after };
}

// ---- breaking the network on purpose ----

const ENTRY = /\/assets\/game-[^/]+\.js$/;
const SEEN = (sel) =>
  `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return ""; const r = e.getBoundingClientRect(); return r.height > 0 && getComputedStyle(e).visibility === "visible" ? e.textContent.replace(/\\s+/g, " ").trim() : ""; })()`;

const FAULTS = [
  {
    name: "the game's script fails (no network)",
    want: { note: /^The game did not load\. Check your connection, then try again\.$/, key: "Try again" },
    async setup(ctx) {
      await ctx.route(ENTRY, (r) => r.abort("internetdisconnected"));
      // The page then asks the server for the page again, to tell a new version from a network fault: that fails too.
      await ctx.route(`${BASE}/?**`, (r) => r.abort("internetdisconnected"));
    },
  },
  {
    name: "a new version went out while the page loaded",
    want: { note: /^A new version of the game is out\.$/, key: "Reload" },
    async setup(ctx) {
      await ctx.route(ENTRY, (r) => r.fulfill({ status: 404, body: "Not found" }));
      await ctx.route(`${BASE}/?**`, async (r) => {
        const res = await r.fetch();
        await r.fulfill({ response: res, body: (await res.text()).replace(/\/assets\/game-[^"]+\.js/, "/assets/game-NEWVERSION.js") });
      });
    },
  },
  {
    name: "the game's script stalls (times run 10 times faster)",
    stall: true,
    async setup(ctx) {
      await ctx.route(ENTRY, () => {}); // never answers
    },
  },
  {
    name: "a part fails after the start (the emotes)",
    want: { bar: /^Part of the game did not load\. Check your connection\./ },
    after: true,
    async setup(ctx) {
      await ctx.route(/\/assets\/clips-[^/]+\.js$/, (r) => r.abort("internetdisconnected"));
    },
  },
];

async function fault(f) {
  const ctx = await browser.newContext(DEVICES.phone);
  await f.setup(ctx);
  const page = await ctx.newPage();
  const problems = [];
  const expect = (what, got, want) => {
    if (!(want instanceof RegExp ? want.test(got) : got === want)) problems.push(`${what}: "${got}"`);
  };
  if (f.stall) {
    // The notes are timed by CSS (--boot-slow 8 s, --boot-stall 30 s): play the page's animations 10 times faster.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 10 });
  }
  await page.goto(BASE + "/", { waitUntil: "commit" });
  if (f.stall) {
    await page.waitForTimeout(300);
    expect("at once, the Play key", await page.evaluate(SEEN("#play")), "Loading…");
    expect("at once, a slow note", await page.evaluate(SEEN(".boot-slow")), "");
    await page.waitForTimeout(1200);
    expect("after 8 s, the note", await page.evaluate(SEEN(".boot-slow")), "Still loading. Your connection is slow.");
    expect("after 8 s, the Play key", await page.evaluate(SEEN("#play")), "Loading…");
    await page.waitForTimeout(2200);
    expect("after 30 s, the note", await page.evaluate(SEEN(".boot-stall .boot-note")), "This is taking too long. Check your connection, then try again.");
    expect("after 30 s, the key", await page.evaluate(SEEN(".boot-stall .btn")), "Try again");
    expect("after 30 s, the slow note", await page.evaluate(SEEN(".boot-slow")), "");
    expect("after 30 s, the Play key", await page.evaluate(SEEN("#play")), "");
  } else if (f.after) {
    if (!(await until(page, READY, 10000))) problems.push("Play never ready");
    await page.click("#play");
    await page.locator("#emotes button").first().click({ timeout: 5000 }).catch(() => problems.push("no Emotes key"));
    await until(page, SEEN("#boot-bar"), 5000);
    expect("the notice", await page.evaluate(SEEN("#boot-bar-text")), f.want.bar);
  } else {
    await until(page, SEEN("#boot-retry"), 8000);
    expect("the note", await page.evaluate(SEEN("#boot-note")), f.want.note);
    expect("the key", await page.evaluate(SEEN("#boot-retry")), f.want.key);
    expect("the Play key", await page.evaluate(SEEN("#play")), "");
    expect("the timed notes", await page.evaluate(SEEN(".boot-slow")) + (await page.evaluate(SEEN(".boot-stall"))), "");
  }
  mkdirSync(SHOTS, { recursive: true });
  const shot = join(SHOTS, `${f.name.replace(/\s*\(.*$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "")}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
  return { name: f.name, problems, shot };
}

// ---- run ----

const kb = (n) => `${Math.round(n / 1024)} KB`;
const s = (ms) => (ms === null ? "never" : `${(ms / 1000).toFixed(1)} s`);
const fails = [];
let code = 0;
try {
  const devices = args.has("--phone") ? ["phone"] : ["phone", "tablet", "computer"];
  console.log(`\nSlow-network check (${BASE}, Chrome ${browser.version()})\n`);
  // One run first that is not counted: a new browser's first page is slower (its own start-up, not the network).
  await measure("phone", "slow4g");
  console.log("device    network   bytes    paint    ready    by kind");
  for (const device of devices)
    for (const net of ["slow4g", "3g"]) {
      const r = await measure(device, net);
      const kinds = Object.entries(r.by)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${kb(v)}`)
        .join(", ");
      console.log(`${device.padEnd(10)}${NETS[net].label.padEnd(10)}${kb(r.bytes).padEnd(9)}${s(r.fcp).padEnd(9)}${s(r.ready).padEnd(9)}${kinds}`);
      if (r.after.length) console.log(`          after ready, by itself: ${r.after.join(", ")}`);
      if (device !== "phone") continue;
      const b = BUDGET[net];
      if (r.bytes > BUDGET.bytes) fails.push(`phone ${NETS[net].label}: ${kb(r.bytes)} before Play, budget ${kb(BUDGET.bytes)}`);
      if (r.fcp === null || r.fcp > b.paint) fails.push(`phone ${NETS[net].label}: first paint ${s(r.fcp)}, budget ${s(b.paint)}`);
      if (r.ready === null || r.ready > b.ready) fails.push(`phone ${NETS[net].label}: Play ready at ${s(r.ready)}, budget ${s(b.ready)}`);
    }
  console.log(`\nBudget (phone): ${kb(BUDGET.bytes)} before Play; paint ${s(BUDGET.slow4g.paint)} / ${s(BUDGET["3g"].paint)}; ready ${s(BUDGET.slow4g.ready)} / ${s(BUDGET["3g"].ready)} (Slow 4G / 3G)`);

  if (!args.has("--no-faults")) {
    console.log("\nA broken network (phone, no slowdown):");
    for (const f of FAULTS) {
      const r = await fault(f);
      console.log(`  ${r.problems.length ? "FAIL" : "ok  "} ${r.name}${r.problems.length ? `: ${r.problems.join("; ")}` : ""}`);
      if (r.problems.length) fails.push(`${r.name}: ${r.problems.join("; ")} (picture: ${r.shot})`);
    }
    console.log(`  Pictures: ${SHOTS}`);
  }
  if (fails.length) {
    console.log(`\nFAILED:\n${fails.map((f) => `  - ${f}`).join("\n")}`);
    code = 1;
  } else console.log("\nPassed.");
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
