// The package's conformance suite (@nano133/nanoterra/admin/conformance), run against THIS game's own chain: the admin cookie, sessionOf, receiveAddress, the
// D1 store and the whole Worker (worker.fetch). It proves the part that is the game's own: that the game reads the ADMIN cookie only, passes its real owner,
// and that every route the handler lists is behind the guard. The pure guard has its own tests in the package.

import { adminConformance, adminStoreConformance, type ConformanceHost, type StoreHarness, type Who } from "@nano133/nanoterra/admin/conformance";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminHandler, gameStore } from "../src/worker/admin";
import { EXAMPLE_ADDRESS, type Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { createSession } from "../src/worker/signin";
import { ORIGIN } from "./api";
import { makeDb, testAccount } from "./helpers";

let db: D1Database;
let close: () => Promise<void>;
const owner = testAccount();
const other = testAccount();
beforeAll(async () => ({ db, close } = await makeDb()));
afterAll(() => close());
beforeEach(async () => {
  for (const t of ["orders", "owned", "sessions", "hits", "meta", "nanoterra_players", "admin_logins"]) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("INSERT INTO meta (key, value, at) VALUES ('rate', ?, ?)").bind(JSON.stringify({ usd: 1, sources: ["test"] }), Date.now()).run();
  await db.prepare("INSERT INTO meta (key, value, at) VALUES ('salt', 'abc', 1)").run();
});

const live = (): Env => ({ DB: db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off" });
const DAY = 24 * 60 * 60_000;
let calls = 0;

/** The game's own sessions, one for each kind of visitor the suite names. */
async function cookieFor(who: Who): Promise<string | null> {
  const now = Date.now();
  switch (who) {
    case "signed_out":
      return null;
    case "game_login":
      // A login made for the game's PLAYERS (cookie `session`), the owner's own: it must NOT open the admin.
      return `session=${await createSession(db, owner.address, now, "wallet", "play")}`;
    case "game_token_as_admin":
      // The token of a login made for the game's players, put in the ADMIN cookie: the admin scope's hashed keys must not match it.
      return `admin=${await createSession(db, owner.address, now, "wallet", "play")}`;
    case "nanoterra_login":
      return `admin=${await createSession(db, owner.address, now, "nanoterra", "admin")}`;
    case "unknown_via_login":
      // An admin-scope row whose login word is none that the game writes: it must never be read as a wallet login.
      return `admin=${await createSession(db, owner.address, now, "ticket" as never, "admin")}`;
    case "old_valid_row": {
      // More than a day old by its creation time, but the row's own expiry is still in the future: only the guard's age check can refuse it.
      const made = now - DAY - 60_000 - calls++;
      const token = await createSession(db, owner.address, made, "wallet", "admin");
      await db.prepare("UPDATE sessions SET expires_at = ? WHERE created_at = ?").bind(now + DAY, made).run();
      return `admin=${token}`;
    }
    case "other_wallet":
      return `admin=${await createSession(db, other.address, now, "wallet", "admin")}`;
    case "expired_login":
      return `admin=${await createSession(db, owner.address, now - DAY - 60_000, "wallet", "admin")}`;
    case "no_address":
    case "owner":
      return `admin=${await createSession(db, owner.address, now, "wallet", "admin")}`;
  }
}

const host = (): ConformanceHost => {
  const routes = adminHandler(live(), Date.now(), "203.0.113.1");
  return {
    routes: routes.routes,
    basePath: routes.basePath,
    origin: ORIGIN,
    // Routes under /api/admin that an older page, or a later change, might serve. The Worker sends every path under the base to the package's handler first.
    otherRoutes: [
      { method: "GET", path: "/api/admin/orders" },
      { method: "GET", path: "/api/admin/" },
      { method: "GET", path: "/api/admin/summary.json" },
      { method: "POST", path: "/api/admin/debug" },
      { method: "GET", path: "/api/admin/game/" },
    ],
    async request(who, req) {
      // A different address for each call: the generic limit per address (120 a minute) must not be what refuses a request in this test.
      const headers = new Headers({ "CF-Connecting-IP": `198.51.100.${(calls++ % 250) + 1}`, ...req.headers });
      const cookie = await cookieFor(who);
      if (cookie) headers.set("Cookie", cookie);
      // While no owner address is set, the game runs with the example address (nobody's key): the admin is closed to everyone.
      const env: Env = who === "no_address" ? { DB: db, RECEIVE_ADDRESS: EXAMPLE_ADDRESS, TEST_MODE: "off" } : live();
      return worker.fetch(new Request(`${ORIGIN}${req.path}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body }), env);
    },
  };
};

describe("the package's admin conformance suite, run against this game's own sessions, store and Worker", () => {
  for (const c of adminConformance(host())) it(c.name, c.run);
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
