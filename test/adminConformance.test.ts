// The package's conformance suite (@nano133/nanoterra/admin/conformance), run against THIS game's own chain: the admin cookie, sessionOf, receiveAddress, the
// D1 store and the whole Worker (worker.fetch). It proves the part that is the game's own: that the game reads the ADMIN cookie only, passes its real owner,
// and that every route the handler lists is behind the guard. The pure guard has its own tests in the package.

import { adminConformance, adminStoreConformance, type ConformanceHost, type StoreHarness, type Who } from "@nano133/nanoterra/admin/conformance";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
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
  for (const t of ["orders", "owned", "sessions", "hits", "meta", "nanoterra_players"]) await db.prepare(`DELETE FROM ${t}`).run();
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
    case "nanoterra_login":
      return `admin=${await createSession(db, owner.address, now, "nanoterra", "admin")}`;
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
      async snapshot() {
        const q = async (sql: string) => JSON.stringify((await db.prepare(sql).all()).results);
        return [await q("SELECT * FROM orders ORDER BY id"), await q("SELECT * FROM owned ORDER BY player, look_id"), await q("SELECT * FROM meta WHERE key NOT IN ('setting:character', 'setting:signin', 'salt') ORDER BY key")].join("|");
      },
    };
  };
  for (const c of adminStoreConformance(harness)) it(c.name, c.run);
});
