// The game's own friends list (the admin's friends setting "own"): the package's rules on THIS game's D1 tables (the package's conformance suite),
// and the game's own wiring: the player is the PLAYER session (never the admin cookie), the routes answer only in the "own" mode, a call from
// another site is refused, and the directory names a player by username or short address, never by the full address.

import { friendsStoreConformance } from "@nano133/nanoterra/friends/conformance";
import { createD1Friends } from "@nano133/nanoterra/friends/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/shared/config";
import type { Env } from "../src/worker/env";
import { createSession } from "../src/worker/signin";
import { Browser } from "./api";
import { makeDb, testAccount } from "./helpers";

let db: D1Database;
let close: () => Promise<void>;
const owner = testAccount();
const ann = testAccount();
const bob = testAccount();
beforeAll(async () => ({ db, close } = await makeDb()));
afterAll(() => close());

const FRIEND_TABLES = ["friend_edges", "friend_presence", "friend_prefs"];

describe("the friends store on this game's D1 tables (@nano133/nanoterra/friends/conformance)", () => {
  const harness = async () => {
    for (const t of FRIEND_TABLES) await db.prepare(`DELETE FROM ${t}`).run();
    return {
      store: createD1Friends(db),
      dump: async () => (await Promise.all(FRIEND_TABLES.map(async (t) => JSON.stringify((await db.prepare(`SELECT * FROM ${t}`).all()).results)))).join("|"),
    };
  };
  for (const c of friendsStoreConformance(harness)) it(c.name, c.run);
});

describe("the friends routes through the Worker", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "hits", "meta", "nanoterra_players", "owned", ...FRIEND_TABLES]) await db.prepare(`DELETE FROM ${t}`).run();
    await db.prepare("INSERT INTO meta (key, value, at) VALUES ('salt', 'abc', 1)").run();
  });

  const live = (): Env => ({ DB: db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off" });
  const mode = (friends: "nanoterra" | "own" | "off") => db.prepare("INSERT OR REPLACE INTO meta (key, value, at) VALUES ('setting:friends', ?, 1)").bind(friends).run();
  /** A browser with a PLAYER session (the `session` cookie). Each one has its own IP, so the per-visitor limits do not meet. */
  let ips = 0;
  async function player(address: string, via: "wallet" | "nanoterra" = "wallet") {
    const b = new Browser(undefined, { "CF-Connecting-IP": `198.18.0.${++ips}` });
    b.jar.set("session", await createSession(db, address, Date.now(), via, "play"));
    return b;
  }

  it("GET /api/config gives the friends list (Nanoterra's by default) and the game's id on Nanoterra", async () => {
    const r = await new Browser().call(live(), "/api/config");
    expect(r.status).toBe(200);
    expect(r.body.friends).toBe("nanoterra");
    expect(r.body).toHaveProperty("nanoterraId", CONFIG.nanoterraId);
    await mode("own");
    expect((await new Browser().call(live(), "/api/config")).body.friends).toBe("own");
    await mode("off");
    expect((await new Browser().call(live(), "/api/config")).body.friends).toBe("off");
  });

  it("answers only in the 'own' mode: with 'nanoterra' or 'off' /api/friends is no route (404), for a signed-in player too", async () => {
    const b = await player(ann.address);
    for (const m of [null, "nanoterra", "off"] as const) {
      if (m) await mode(m);
      expect((await b.call(live(), "/api/friends")).status, String(m)).toBe(404);
      expect((await b.call(live(), "/api/friends", { body: { op: "request", name: "bob" } })).status, String(m)).toBe(404);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM friend_edges").first<{ n: number }>())!.n).toBe(0);
  });

  it("refuses a visitor who is not signed in, and the admin cookie (the admin is not a player)", async () => {
    await mode("own");
    expect((await new Browser().call(live(), "/api/friends")).status).toBe(401);
    const admin = new Browser();
    admin.jar.set("admin", await createSession(db, owner.address, Date.now(), "wallet", "admin"));
    expect((await admin.call(live(), "/api/friends")).status).toBe(401);
    expect((await admin.call(live(), "/api/friends", { body: { op: "visibility", showOnline: false } })).status).toBe(401);
    // A player token put in the admin cookie, or an admin token in the player cookie, is no player either.
    const swapped = new Browser();
    swapped.jar.set("session", await createSession(db, owner.address, Date.now(), "wallet", "admin"));
    expect((await swapped.call(live(), "/api/friends")).status).toBe(401);
    expect((await (await player(ann.address)).call(live(), "/api/friends")).status).toBe(200);
  });

  it("refuses a POST from another site and a read from another site (403), and changes nothing", async () => {
    await mode("own");
    await db.prepare("INSERT INTO nanoterra_players (address, username, look, items, updated_at) VALUES (?, 'Bob', '[]', '[]', 1)").bind(bob.address).run();
    const b = await player(ann.address);
    expect((await b.call(live(), "/api/friends", { body: { op: "request", name: "Bob" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await b.call(live(), "/api/friends", { origin: "https://evil.example" })).status).toBe(403);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM friend_edges").first<{ n: number }>())!.n).toBe(0);
  });

  it("two players: a request by Nanoterra username (any case) or by address, an accept, and no full address in any answer", async () => {
    await mode("own");
    await db.prepare("INSERT INTO nanoterra_players (address, username, look, items, updated_at) VALUES (?, 'Bob', '[]', '[]', 1)").bind(bob.address).run();
    const a = await player(ann.address);
    const b = await player(bob.address, "nanoterra");
    // Ann has no Nanoterra name: Bob sees her short address.
    const sent = await a.call(live(), "/api/friends", { body: { op: "request", name: "bob" } });
    expect(sent.status).toBe(200);
    expect(sent.body.people).toMatchObject([{ name: "Bob", state: "outgoing" }]);
    const seen = await b.call(live(), "/api/friends");
    const short = `${ann.address.slice(0, 10)}…${ann.address.slice(-6)}`;
    expect(seen.body.people).toMatchObject([{ name: short, state: "incoming" }]);
    const accepted = await b.call(live(), "/api/friends", { body: { op: "accept", edge: seen.body.people[0].edge } });
    expect(accepted.body.people).toMatchObject([{ name: short, state: "friend" }]);
    for (const body of [sent.body, seen.body, accepted.body]) {
      expect(JSON.stringify(body)).not.toContain(ann.address);
      expect(JSON.stringify(body)).not.toContain(bob.address);
    }
    // By address: the whole address (65 characters; the package takes 80 since 0.6.1) or the part after "nano_", and only an address of a
    // player of this game. A stranger's address is "no such player".
    const c = await player(owner.address);
    expect((await c.call(live(), "/api/friends", { body: { op: "request", name: ann.address } })).status).toBe(200);
    const d = await player(testAccount().address);
    expect((await d.call(live(), "/api/friends", { body: { op: "request", name: ann.address.slice(5).toUpperCase() } })).status).toBe(200);
    expect((await c.call(live(), "/api/friends", { body: { op: "request", name: testAccount().address.slice(5) } })).status).toBe(404);
  });
});
