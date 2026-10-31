// The "Game" card of /admin: two switches (and the friends list, test/friends.test.ts) kept in the `meta` table (the package's D1 store), read by the Worker at run time. They move the
// character choice and the sign-in word of the listing with no push and no deploy. The routes sit behind the SAME admin guard as every admin
// call: this file checks each refusal again for the new routes, and that a press changes only these two settings.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/shared/config";
import { CHARACTER_NEEDS_SIGNIN, CHARACTER_SIGNIN_OFF, isCharacter, isSigninChoice, parsePatch, pressOf, REVIEW_NOTE, signinOn, stateOf, SWITCHES } from "@nano133/nanoterra/admin";
import { EXAMPLE_ADDRESS, type Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { createSession } from "../src/worker/signin";
import { Browser, ORIGIN } from "./api";
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

const live = (extra: Partial<Env> = {}): Env => ({ DB: db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off", NANOTERRA_CLIENT_ID: "ng_00000000000000000001", NANOTERRA_SECRET: "ns_test", ...extra });
async function adminIn(address: string, o: { ageMs?: number; via?: "wallet" | "nanoterra" } = {}) {
  const b = new Browser();
  b.jar.set("admin", await createSession(db, address, Date.now() - (o.ageMs ?? 0), o.via ?? "wallet", "admin"));
  return b;
}
const settings = async () => (await db.prepare("SELECT key, value FROM meta ORDER BY key").all<{ key: string; value: string }>()).results;
/** The whole Worker (the listing and the Nanoterra pages are not under /api). */
const fetchAs = (env: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": "203.0.113.50" }, ...init }), env);

describe("the words of the switches (@nano133/nanoterra/admin)", () => {
  it("parsePatch takes the two known words and nothing else", () => {
    expect(parsePatch({ character: "own" })).toEqual({ ok: true, patch: { character: "own" } });
    expect(parsePatch({ signin: "none" })).toEqual({ ok: true, patch: { signin: "none" } });
    expect(parsePatch({ character: "nanoterra", signin: "exchange" })).toEqual({ ok: true, patch: { character: "nanoterra", signin: "exchange" } });
    for (const bad of [{}, [], null, "own", 5, { character: "penguin" }, { signin: "ticket" }, { signin: "on" }, { character: "own", price: 1 }, { looks: [] }, { character: 1 }]) {
      expect(parsePatch(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(isCharacter("own") && isCharacter("nanoterra") && !isCharacter("x")).toBe(true);
    expect(isSigninChoice("exchange") && isSigninChoice("none") && !isSigninChoice("ticket")).toBe(true);
  });

  it("a press is the other state; sign-in is on for exchange and ticket, off for none", () => {
    const s = { character: "nanoterra" as const, signin: "exchange" as const };
    expect(stateOf("character", s)).toBe(true);
    expect(pressOf("character", s)).toEqual({ character: "own" });
    expect(pressOf("signin", s)).toEqual({ signin: "none" });
    expect(pressOf("signin", { ...s, signin: "none" })).toEqual({ signin: "exchange" });
    expect(signinOn("ticket")).toBe(true);
    expect(signinOn("none")).toBe(false);
    expect(pressOf("signin", { ...s, signin: "ticket" })).toEqual({ signin: "none" });
  });

  it("each switch says in words what it does, and the sign-in note says that this page cannot see Nanoterra's review", () => {
    for (const id of ["character", "signin"] as const) {
      expect(SWITCHES[id].title.length).toBeGreaterThan(10);
      expect(SWITCHES[id].on).toMatch(/^On:/);
      expect(SWITCHES[id].off).toMatch(/^Off:/);
    }
    expect(REVIEW_NOTE).toContain("review decides");
    expect(REVIEW_NOTE).toContain("cannot see that review");
  });

  it("the character switch says that it needs sign-in, and says what a player gets while sign-in is Off", () => {
    expect(CHARACTER_NEEDS_SIGNIN).toContain("Players can sign in with Nanoterra");
    expect(CHARACTER_NEEDS_SIGNIN).toContain("to be On");
    expect(CHARACTER_SIGNIN_OFF).toContain("every player starts as the island's first character");
    expect(CHARACTER_SIGNIN_OFF).toContain("signed in from Nanoterra before included");
    expect(CHARACTER_SIGNIN_OFF).not.toContain("keeps their character");
    // The sign-in switch's own title is the name that the character switch points at.
    expect(CHARACTER_NEEDS_SIGNIN).toContain(SWITCHES.signin.title);
  });
});

describe("the Game switches through the Worker", () => {
  it("start from game.config.json, and say so", async () => {
    const r = await (await adminIn(owner.address)).call(live(), "/api/admin/game");
    expect(r.status).toBe(200);
    // The friends list is the package's own default ("nanoterra"): game.config.json does not name it.
    expect(r.body).toEqual({ character: CONFIG.character, signin: CONFIG.signin, friends: "nanoterra", fromAdmin: { character: false, signin: false, friends: false } });
  });

  it("a press is saved, read back, and kept in two meta rows with their own prefix", async () => {
    const b = await adminIn(owner.address);
    const r = await b.call(live(), "/api/admin/game", { method: "POST", body: { character: "own" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ character: "own", signin: CONFIG.signin, fromAdmin: { character: true, signin: false } });
    expect((await b.call(live(), "/api/admin/game")).body.character).toBe("own");
    const rows = await settings();
    expect(rows.map((x) => x.key)).toEqual(["rate", "salt", "setting:character"]);
    expect(rows.find((x) => x.key === "setting:character")!.value).toBe("own");
    // Both at once, and a second press of one leaves the other alone.
    await b.call(live(), "/api/admin/game", { method: "POST", body: { character: "nanoterra", signin: "none" } });
    await b.call(live(), "/api/admin/game", { method: "POST", body: { signin: "exchange" } });
    expect((await b.call(live(), "/api/admin/game")).body).toMatchObject({ character: "nanoterra", signin: "exchange", fromAdmin: { character: true, signin: true } });
  });

  it("changes nothing but those two settings: not the price, the salt, an order or an owned look", async () => {
    await db.prepare("INSERT INTO owned (player, look_id, order_id, granted_at) VALUES ('p', 'l', 'o', 1)").run();
    const before = JSON.stringify(await settings());
    const b = await adminIn(owner.address);
    await b.call(live(), "/api/admin/game", { method: "POST", body: { character: "own", signin: "none" } });
    const after = (await settings()).filter((x) => !x.key.startsWith("setting:"));
    expect(JSON.stringify(after)).toBe(before);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM owned").first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM orders").first<{ n: number }>())!.n).toBe(0);
  });

  it("refuses a bad word, an unknown switch, an empty body and a body that is too large, and saves nothing", async () => {
    const b = await adminIn(owner.address);
    for (const body of [{ character: "penguin" }, { signin: "ticket" }, { price: 5 }, {}, [], { character: "own", looks: [] }]) {
      expect((await b.call(live(), "/api/admin/game", { method: "POST", body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await settings()).some((x) => x.key.startsWith("setting:"))).toBe(false);
    const big = await fetchAs(live(), "/api/admin/game", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: `admin=${[...b.jar.values()][0]}` }, body: JSON.stringify({ character: "own", pad: "x".repeat(600) }) });
    // Too much to read is 413 (the package's handler stops reading at the limit), not 400.
    expect(big.status).toBe(413);
    expect((await settings()).some((x) => x.key.startsWith("setting:"))).toBe(false);
  });

  it("gives an address 30 presses a minute (an address of its own, so the other tests keep their count)", async () => {
    const b = await adminIn(owner.address);
    const cookie = `admin=${[...b.jar.values()][0]}`;
    let last = 0;
    for (let i = 0; i < 32 && last !== 429; i++) {
      last = (await fetchAs(live(), "/api/admin/game", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie, "CF-Connecting-IP": "203.0.113.99" }, body: JSON.stringify({ character: i % 2 ? "own" : "nanoterra" }) })).status;
    }
    expect(last).toBe(429);
  });
});

describe("the same admin guard for the new routes", () => {
  const routes: [string, string][] = [["GET", "/api/admin/game"], ["POST", "/api/admin/game"]];

  it("refuses a visitor who is not signed in (401), for read and press", async () => {
    for (const [method, path] of routes) expect((await new Browser().call(live(), path, { method, ...(method === "POST" ? { body: { character: "own" } } : {}) })).status, method).toBe(401);
  });

  it("refuses a login made for the game, even the owner's own (401): only the admin login opens it", async () => {
    const b = new Browser();
    b.jar.set("session", await createSession(db, owner.address, Date.now(), "wallet", "play"));
    for (const [method, path] of routes) expect((await b.call(live(), path, { method, ...(method === "POST" ? { body: { character: "own" } } : {}) })).status, method).toBe(401);
  });

  it("refuses another wallet (403, other_address) and a Nanoterra login, even for the owner's address (403, nanoterra)", async () => {
    const wrong = await (await adminIn(other.address)).call(live(), "/api/admin/game", { method: "POST", body: { character: "own" } });
    expect(wrong.status).toBe(403);
    expect(wrong.body.reason).toBe("other_address");
    const viaNanoterra = await (await adminIn(owner.address, { via: "nanoterra" })).call(live(), "/api/admin/game", { method: "POST", body: { character: "own" } });
    expect(viaNanoterra.status).toBe(403);
    expect(viaNanoterra.body.reason).toBe("nanoterra");
    expect((await settings()).some((x) => x.key.startsWith("setting:"))).toBe(false);
  });

  it("refuses everyone while no real receive address is set (403, no_address), and an admin login older than a day (401)", async () => {
    const none = await (await adminIn(EXAMPLE_ADDRESS)).call(live({ RECEIVE_ADDRESS: EXAMPLE_ADDRESS }), "/api/admin/game");
    expect(none.status).toBe(403);
    expect(none.body.reason).toBe("no_address");
    expect((await (await adminIn(owner.address, { ageMs: 25 * 3_600_000 })).call(live(), "/api/admin/game")).status).toBe(401);
  });

  it("refuses a press from another site (403), even with the owner's admin cookie", async () => {
    const b = await adminIn(owner.address);
    const r = await b.call(live(), "/api/admin/game", { method: "POST", body: { character: "own" }, origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect((await settings()).some((x) => x.key.startsWith("setting:"))).toBe(false);
  });
});

describe("the Worker reads the switches at run time", () => {
  it("/api/config says the character and whether sign-in is on, for anyone", async () => {
    const guest = new Browser();
    expect((await guest.call(live(), "/api/config")).body).toMatchObject({ character: CONFIG.character, nanoterraSignin: CONFIG.signin !== "none" });
    const b = await adminIn(owner.address);
    await b.call(live(), "/api/admin/game", { method: "POST", body: { character: "own", signin: "none" } });
    expect((await guest.call(live(), "/api/config")).body).toMatchObject({ character: "own", nanoterraSignin: false });
    await b.call(live(), "/api/admin/game", { method: "POST", body: { character: "nanoterra", signin: "exchange" } });
    expect((await guest.call(live(), "/api/config")).body).toMatchObject({ character: "nanoterra", nanoterraSignin: true });
  });

  it("the listing file's signin word follows the switch, and is served for 60 seconds", async () => {
    const b = await adminIn(owner.address);
    const first = await fetchAs(live(), "/nano-game.json");
    expect(first.status).toBe(200);
    expect((await first.json()).signin).toBe(CONFIG.signin);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=60");
    await b.call(live(), "/api/admin/game", { method: "POST", body: { signin: "none" } });
    expect((await (await fetchAs(live(), "/nano-game.json")).json()).signin).toBe("none");
    await b.call(live(), "/api/admin/game", { method: "POST", body: { signin: "exchange" } });
    expect((await (await fetchAs(live(), "/nano-game.json")).json()).signin).toBe("exchange");
  });

  it("the character switch is not in the listing file, and nothing else in it changed", async () => {
    const b = await adminIn(owner.address);
    await b.call(live(), "/api/admin/game", { method: "POST", body: { character: "own" } });
    const file = await (await fetchAs(live(), "/nano-game.json")).json();
    expect(Object.keys(file).sort()).toEqual(["ages", "art", "creator", "line", "multiplayer", "name", "nanoGame", "play", "regions", "signin"]);
  });

  it("with sign-in off, the start, the callback and Continue answer 'off' and a link made before signs nobody in; 'Not me' still works", async () => {
    const b = await adminIn(owner.address);
    expect((await fetchAs(live(), "/nanoterra/start")).status).toBe(302);
    await b.call(live(), "/api/admin/game", { method: "POST", body: { signin: "none" } });
    const sessionsBefore = (await db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
    for (const [path, method] of [["/nanoterra/start", "GET"], [`/nanoterra/callback?code=${"A".repeat(43)}&state=${"s".repeat(32)}`, "GET"], ["/nanoterra/confirm", "POST"]] as const) {
      const r = await fetchAs(live(), path, { method, headers: { "CF-Connecting-IP": "203.0.113.51", Origin: ORIGIN, Cookie: `nanoterra-state=${"s".repeat(32)}` } });
      expect(r.status, path).toBe(503);
      expect(await r.text(), path).toContain("Sign-in from Nanoterra is off");
      expect(r.headers.getSetCookie().some((c) => c.startsWith("session=") || c.startsWith("__Host-session=")), path).toBe(false);
    }
    expect((await fetchAs(live(), "/nanoterra/cancel", { method: "POST" })).status).toBe(303);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(sessionsBefore);
    await b.call(live(), "/api/admin/game", { method: "POST", body: { signin: "exchange" } });
    expect((await fetchAs(live(), "/nanoterra/start")).status).toBe(302);
  });

  it("a database fault in reading the switches gives the defaults: the listing and the config still answer", async () => {
    const broken = { ...live(), DB: { prepare: () => { throw new Error("D1 is down"); } } as unknown as D1Database };
    const file = await fetchAs(broken, "/nano-game.json");
    expect(file.status).toBe(200);
    expect((await file.json()).signin).toBe(CONFIG.signin);
  });
});
