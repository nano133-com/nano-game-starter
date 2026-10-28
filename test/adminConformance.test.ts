// The package's conformance suite (@nano133/nanoterra/admin/conformance), run against THIS game's own chain: the admin cookie, sessionOf, receiveAddress, the
// D1 store and the whole Worker (worker.fetch). It proves the part that is the game's own: that the game reads the ADMIN cookie only, passes its real owner,
// and that every route the handler lists is behind the guard. The pure guard has its own tests in the package.

import { adminConformance, adminSigninConformance, adminStoreConformance, type ConformanceHost, type SigninHost, type StoreHarness, type Who } from "@nano133/nanoterra/admin/conformance";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminHandler, gameStore } from "../src/worker/admin";
import { EXAMPLE_ADDRESS, type Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { createSession } from "../src/worker/signin";
import { Browser, ORIGIN, signedInWith, walletAnswer, walletFrom } from "./api";
import { makeDb, testAccount } from "./helpers";

let db: D1Database;
let close: () => Promise<void>;
const owner = testAccount();
const other = testAccount();
beforeAll(async () => ({ db, close } = await makeDb()));
afterAll(() => close());
beforeEach(async () => {
  for (const t of ["orders", "owned", "sessions", "hits", "meta", "nanoterra_players", "admin_logins", "signin_requests"]) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("INSERT INTO meta (key, value, at) VALUES ('rate', ?, ?)").bind(JSON.stringify({ usd: 1, sources: ["test"] }), Date.now()).run();
  await db.prepare("INSERT INTO meta (key, value, at) VALUES ('salt', 'abc', 1)").run();
});

const live = (): Env => ({ DB: db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off" });
const DAY = 24 * 60 * 60_000;
let calls = 0;

/**
 * The game's own sessions, one for each kind of visitor the suite names. `base` is the game's origin: over https the cookies are `__Host-session` and `__Host-admin`, and the
 * suite runs on both (the `__Host-` branch of the cookie code is the one that runs in production). `again`: the same login as the last one of this kind.
 */
function sessions(base: string) {
  const prefix = base.startsWith("https:") ? "__Host-" : "";
  const last = new Map<Who, string>();
  const cookie = (name: "session" | "admin", token: string) => `${prefix}${name}=${token}`;
  async function make(who: Who): Promise<string | null> {
    const now = Date.now();
    switch (who) {
      case "signed_out":
        return null;
      case "game_login":
        // A login made for the game's PLAYERS (cookie `session`), the owner's own: it must NOT open the admin.
        return cookie("session", await createSession(db, owner.address, now, "wallet", "play"));
      case "game_token_as_admin":
        // The token of a login made for the game's players, put in the ADMIN cookie: the admin scope's hashed keys must not match it.
        return cookie("admin", await createSession(db, owner.address, now, "wallet", "play"));
      case "nanoterra_login":
        return cookie("admin", await createSession(db, owner.address, now, "nanoterra", "admin"));
      case "unknown_via_login":
        // An admin-scope row whose login word is none that the game writes: it must never be read as a wallet login.
        return cookie("admin", await createSession(db, owner.address, now, "ticket" as never, "admin"));
      case "old_valid_row": {
        // More than a day old by its creation time, but the row's own expiry is still in the future: only the guard's age check can refuse it.
        const made = now - DAY - 60_000 - calls++;
        const token = await createSession(db, owner.address, made, "wallet", "admin");
        await db.prepare("UPDATE sessions SET expires_at = ? WHERE created_at = ?").bind(now + DAY, made).run();
        return cookie("admin", token);
      }
      case "other_wallet":
        return cookie("admin", await createSession(db, other.address, now, "wallet", "admin"));
      case "expired_login": {
        // Made an hour ago, so the guard's one-day age check would allow it, but the game's own store has expired it: only the store can refuse it.
        const made = now - 3_600_000 - calls++;
        const token = await createSession(db, owner.address, made, "wallet", "admin");
        await db.prepare("UPDATE sessions SET expires_at = ? WHERE created_at = ?").bind(now - 1000, made).run();
        return cookie("admin", token);
      }
      case "signed_out_login": {
        // A login that the game's own sign-out route ended (the real route, with the real cookie).
        const mine = cookie("admin", await createSession(db, owner.address, now, "wallet", "admin"));
        const out = await worker.fetch(new Request(`${base}/api/signout`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: mine, "CF-Connecting-IP": `198.51.100.${(calls++ % 250) + 1}` }, body: JSON.stringify({ scope: "admin" }) }), live());
        expect(out.status).toBe(200);
        return mine;
      }
      case "no_address":
      case "owner":
        return cookie("admin", await createSession(db, owner.address, now, "wallet", "admin"));
    }
  }
  const get = async (who: Who, again = false): Promise<string | null> => {
    if (again && last.has(who)) return last.get(who)!;
    const made = await make(who);
    if (made) last.set(who, made);
    return made;
  };
  /** Ends the login of the last request of this kind with the game's OWN sign-out route and the real cookie. */
  const end = async (who: Who) => {
    const mine = last.get(who);
    if (!mine) return;
    const out = await worker.fetch(new Request(`${base}/api/signout`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: mine, "CF-Connecting-IP": `198.51.100.${(calls++ % 250) + 1}` }, body: JSON.stringify({ scope: "admin" }) }), live());
    expect(out.status).toBe(200);
  };
  return { get, end };
}

const host = (base: string = ORIGIN): ConformanceHost => {
  const routes = adminHandler(live(), Date.now(), "203.0.113.1");
  const sess = sessions(base);
  const cookieFor = sess.get;
  return {
    routes: routes.routes,
    basePath: routes.basePath,
    origin: base,
    // Routes under /api/admin that an older page, or a later change, might serve. The Worker sends every path under the base to the package's handler first.
    otherRoutes: [
      { method: "GET", path: "/api/admin/orders" },
      { method: "GET", path: "/api/admin/" },
      { method: "GET", path: "/api/admin/summary.json" },
      { method: "POST", path: "/api/admin/debug" },
      { method: "GET", path: "/api/admin/game/" },
      { method: "POST", path: "/api/admin/game/" },
      { method: "GET", path: "/api/admin/logins" },
    ],
    endLogin: sess.end,
    async request(who, req) {
      // A different address for each call: the generic limit per address (120 a minute) must not be what refuses a request in this test.
      const headers = new Headers({ "CF-Connecting-IP": `198.51.100.${(calls++ % 250) + 1}`, ...req.headers });
      const cookie = await cookieFor(who, req.again);
      let path = req.path;
      if (cookie && req.tokenAt && (who === "game_login" || who === "game_token_as_admin")) {
        // The player's login token in a place that is not the game's cookie, and no cookie.
        const token = cookie.slice(cookie.indexOf("=") + 1);
        if (req.tokenAt === "bearer") headers.set("Authorization", `Bearer ${token}`);
        else if (req.tokenAt === "header") headers.set("X-Auth-Token", token);
        else path += `${path.includes("?") ? "&" : "?"}token=${token}&t=${token}&access_token=${token}`;
      } else if (cookie) headers.set("Cookie", cookie);
      // While no owner address is set, the game runs with the example address (nobody's key): the admin is closed to everyone.
      const env: Env = who === "no_address" ? { DB: db, RECEIVE_ADDRESS: EXAMPLE_ADDRESS, TEST_MODE: "off" } : live();
      return worker.fetch(new Request(`${base}${path}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body }), env);
    },
  };
};

describe("the package's admin conformance suite, run against this game's own sessions, store and Worker", () => {
  for (const c of adminConformance(host())) it(c.name, c.run);
});

/** The game's own sign-in chain, driven for the kit's contract: Berry Wallet or Nautilus, started for the game or for the admin, signed by the owner, finished by a browser. */
function signinHost(way: "berry" | "nautilus"): SigninHost {
  type Handle = { browser: Browser; start: { body: Record<string, any> }; scope: "game" | "admin" };
  const name = (s: "game" | "admin") => (s === "admin" ? "admin" : "play");
  // The game's clock for this host: `advance` moves it, and every call after it (the wallet's and the browser's) is made at that time.
  let offset = 0;
  const at = () => Date.now() + offset;
  let browsers = 0;
  return {
    async start(scope) {
      // A new address for each browser and for each signature: the per-address limits (the wallet route's 30 a minute, the sign-in start's) must never be what refuses a call here.
      const browser = new Browser(ORIGIN, { "CF-Connecting-IP": `203.0.113.${(browsers++ % 250) + 1}`, "CF-IPCountry": "US", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });
      const start = await browser.call(live(), "/api/signin/start", { body: { way, scope: name(scope) } });
      expect(start.status).toBe(200);
      return { browser, start, scope } satisfies Handle;
    },
    async sign(h) {
      walletFrom.ip = `198.51.100.${(walletFrom.n = ((walletFrom.n ?? 0) + 1) % 250) + 1}`;
      const out = await walletAnswer(live(), way, (h as Handle).start.body, owner, at());
      // Berry Wallet's accepted answer is 204 with no body, Nautilus's is 200 with status 0. Anything else is a refusal, and a refusal is a fault of the test, never a pass.
      const accepted = way === "berry" ? out.status === 204 : out.status === 200 && out.body?.status === 0;
      if (!accepted) throw new Error(`the wallet's signature was refused: ${out.status} ${JSON.stringify(out.body)}`);
    },
    async finish(h, as, credentials) {
      const { browser, start, scope } = h as Handle;
      const b = new Browser(ORIGIN);
      if (credentials !== "other") b.jar = new Map(browser.jar);
      if (credentials === "retyped") {
        // The browser that started it, presenting its starter as the OTHER scope would read it: copied to the other scope's cookie name, and (for an admin request finished as the game) with the
        // admin scope's hashing prefix put in front, the value that the game's own hashing would turn into the stored admin hash.
        if (scope === "admin" && as === "game") b.jar.set("starter", `admin:${browser.jar.get("starter-admin")}`);
        if (scope === "game" && as === "admin") b.jar.set("starter-admin", browser.jar.get("starter")!);
      }
      b.headers = { "CF-Connecting-IP": `203.0.113.${(browsers++ % 250) + 1}` };
      await b.call(live(), "/api/signin/check", { body: { id: start.body.id, way, scope: name(as) }, now: at() });
      return { admin: b.jar.has("admin"), game: b.jar.has("session") };
    },
    async signOutEverywhere() {
      walletFrom.ip = `198.51.100.${(walletFrom.n = ((walletFrom.n ?? 0) + 1) % 250) + 1}`;
      const admin = await signedInWith(live(), way, owner, "admin", new Browser(ORIGIN, { "CF-Connecting-IP": `203.0.113.${(browsers++ % 250) + 1}` }));
      expect((await admin.call(live(), "/api/admin/signout-all", { method: "POST", body: {} })).status).toBe(200);
    },
    async advance(ms) {
      offset += ms;
    },
  };
}

describe("the kit's sign-in chain contract, run against this game's own sign-in (Berry Wallet, Nautilus)", () => {
  for (const way of ["berry", "nautilus"] as const) for (const c of adminSigninConformance(signinHost(way), { signOutEverywhere: true, advance: true })) it(`[${way}] ${c.name}`, c.run);
});

describe("the same suite over https, where the cookies are __Host-session and __Host-admin", () => {
  for (const c of adminConformance(host("https://game.test"))) it(`[https] ${c.name}`, c.run);
});

describe("the package's store contract, run against this game's D1 store and its real tables", () => {
  const harness = async (): Promise<StoreHarness> => {
    // A new game has no price yet (the beforeEach above gave this file one, like the other tests).
    await db.prepare("DELETE FROM meta WHERE key = 'rate'").run();
    const store = gameStore(live());
    return {
      store,
      async seed(d) {
        for (const o of d.orders ?? []) {
          await db
            .prepare("INSERT INTO orders (id, player, look_id, usd, rate, amount, status, created_at, expires_at, hold_until, hash, payer, paid_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(o.id, o.player, o.lookId, o.usd, o.amountRaw, o.status, o.createdAt, o.expiresAt, o.expiresAt, o.hash, o.payer, o.paidAt)
            .run();
        }
        for (const o of d.owned ?? []) await db.prepare("INSERT OR REPLACE INTO owned (player, look_id, order_id, granted_at) VALUES (?, ?, 'x', ?)").bind(o.player, o.lookId, o.at).run();
        if (d.rate) await db.prepare("INSERT OR REPLACE INTO meta (key, value, at) VALUES ('rate', ?, ?)").bind(d.rate.value, d.rate.at).run();
      },
      async seedLogins(rows) {
        for (const r of rows) await db.prepare("INSERT INTO admin_logins (at, country, browser) VALUES (?, ?, ?)").bind(r.at, r.country, r.browser).run();
      },
      async seedSessions(n) {
        const now = Date.now();
        for (let i = 0; i < n.admin; i++) await db.prepare("INSERT INTO sessions (id_hash, address, created_at, expires_at, via, scope) VALUES (?, ?, ?, ?, 'wallet', 'admin')").bind(`seed-admin-${i}-${now}`, owner.address, now, now + DAY).run();
        for (let i = 0; i < n.play; i++) await db.prepare("INSERT INTO sessions (id_hash, address, created_at, expires_at, via, scope) VALUES (?, ?, ?, ?, 'wallet', 'play')").bind(`seed-play-${i}-${now}`, owner.address, now, now + 30 * DAY).run();
      },
      async seedRequests(n) {
        const at = Date.now();
        for (let i = 0; i < n.admin + n.game; i++) {
          const scope = i < n.admin ? "admin" : "play";
          await db.prepare("INSERT INTO signin_requests (id, way, starter, status, expires_at, delivered, scope) VALUES (?, 'berry', 'seed', 'signedin', ?, 0, ?)").bind(`seed-req-${scope}-${i}-${at}`, at + 300_000, scope).run();
        }
      },
      async pendingRequests() {
        const n = async (scope: string) => (await db.prepare("SELECT COUNT(*) AS n FROM signin_requests WHERE scope = ? AND delivered = 0 AND id LIKE 'seed-req-%'").bind(scope).first<{ n: number }>())!.n;
        return { admin: await n("admin"), game: await n("play") };
      },
      async sessionCounts() {
        const n = async (scope: string) => (await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE scope = ? AND id_hash LIKE 'seed-%'").bind(scope).first<{ n: number }>())!.n;
        return { admin: await n("admin"), play: await n("play") };
      },
      async snapshot() {
        const q = async (sql: string) => JSON.stringify((await db.prepare(sql).all()).results);
        return [await q("SELECT * FROM orders ORDER BY id"), await q("SELECT * FROM owned ORDER BY player, look_id"), await q("SELECT * FROM meta WHERE key NOT IN ('setting:character', 'setting:signin', 'salt') ORDER BY key")].join("|");
      },
    };
  };
  for (const c of adminStoreConformance(harness)) it(c.name, c.run);
});

describe("what a security read found in this game's wiring", () => {
  const adminCookie = async (via: string, ageMs = 0) => `admin=${await createSession(db, owner.address, Date.now() - ageMs, via as never, "admin")}`;
  const options = (path: string, cookie?: string) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, { method: "OPTIONS", headers: { "CF-Connecting-IP": "203.0.113.77", Origin: ORIGIN, "Access-Control-Request-Method": "POST", ...(cookie ? { Cookie: cookie } : {}) } }), live());

  it("a preflight for the admin is not answered for a visitor: 401, and no CORS header; for the owner, 405", async () => {
    for (const path of ["/api/admin/summary", "/api/admin/game", "/api/admin/check", "/api/admin/anything"]) {
      const res = await options(path);
      expect(res.status, path).toBe(401);
      expect([...res.headers.keys()].some((k) => k.startsWith("access-control-")), path).toBe(false);
      // The owner: 405 for a route that exists (it has no OPTIONS), 404 for a path that does not.
      expect((await options(path, await adminCookie("wallet"))).status, path).toBe(path.endsWith("anything") ? 404 : 405);
    }
    // The game's own preflight is unchanged: its own origin gets 204, another origin 403.
    const own = await options("/api/signin/start");
    expect(own.status).toBe(204);
    expect(own.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("a login word that the game does not write is never a wallet login: /admin refuses it, and /api/me says it is no admin", async () => {
    for (const word of ["ticket", "", "Wallet", "WALLET ", "walle"]) {
      const cookie = await adminCookie(word);
      const res = await worker.fetch(new Request(`${ORIGIN}/api/admin/summary`, { headers: { "CF-Connecting-IP": "203.0.113.78", Cookie: cookie } }), live());
      expect(res.status, JSON.stringify(word)).toBe(403);
    }
    // In the game's own scope too: such a row is not an admin, and not a Nanoterra player.
    const play = `session=${await createSession(db, owner.address, Date.now(), "ticket" as never, "play")}`;
    const me = await (await worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { "CF-Connecting-IP": "203.0.113.79", Cookie: play } }), live())).json<Record<string, unknown>>();
    expect(me.admin).toBe(false);
    expect(me.via).toBe("unknown");
  });
});
