// The game and /admin each have their own login (two cookies, two sessions), so two different people can be signed in at once: a
// player in the game, the creator in /admin. A login made for the game can never open /admin, and an admin login is not a player.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { ADMIN_SESSION_MS, WAYS } from "../src/worker/signin";
import { Browser, signedInWith, walletAnswer } from "./api";
import { makeDb, testAccount } from "./helpers";

let env: Env;
let close: () => Promise<void>;
const owner = testAccount();
const player = testAccount();
beforeAll(async () => {
  const made = await makeDb();
  close = made.close;
  env = { DB: made.db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off" };
});
afterAll(() => close());
beforeEach(async () => {
  for (const t of ["hits", "sessions", "signin_requests"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
const cookieNames = (res: Response) => res.headers.getSetCookie().map((c) => c.split("=")[0]!.replace(/^__Host-/, ""));

describe("the admin login", () => {
  it("a wallet sign-in started from /admin makes the admin cookie (one day), not the game's", async () => {
    const browser = new Browser();
    const start = await browser.call(env, "/api/signin/start", { body: { way: "berry", scope: "admin" } });
    expect(cookieNames(start.res)).toEqual(["starter-admin"]);
    await walletAnswer(env, "berry", start.body, owner);
    const done = await browser.call(env, "/api/signin/check", { body: { id: start.body.id, way: "berry", scope: "admin" } });
    expect(done.body).toEqual({ status: "signedin", address: owner.address });
    expect(cookieNames(done.res)).toEqual(["admin"]);
    const [header] = done.res.headers.getSetCookie();
    expect(header).toContain(`Max-Age=${ADMIN_SESSION_MS / 1000}`);
    const row = await env.DB.prepare("SELECT created_at, expires_at, via FROM sessions").first<{ created_at: number; expires_at: number; via: string }>();
    expect(row!.expires_at - row!.created_at).toBe(ADMIN_SESSION_MS);
    expect(row!.via).toBe("wallet");
    expect(browser.jar.has("admin")).toBe(true);
    expect(browser.jar.has("session")).toBe(false);
    expect((await browser.call(env, "/api/admin/summary")).status).toBe(200);
  });

  it("a login made for the game never opens /admin, even the owner's own wallet login", async () => {
    for (const way of WAYS) {
      const creatorAsPlayer = await signedInWith(env, way, owner, "play");
      expect((await creatorAsPlayer.call(env, "/api/me")).body).toMatchObject({ address: owner.address });
      expect((await creatorAsPlayer.call(env, "/api/admin/summary")).status).toBe(401);
      expect((await creatorAsPlayer.call(env, "/api/admin/check", { body: {} })).status).toBe(401);
    }
  });

  it("an admin login is not a player: the game sees a guest and an order is refused", async () => {
    const creator = await signedInWith(env, "berry", owner, "admin");
    expect((await creator.call(env, "/api/me")).body).toMatchObject({ address: null, admin: false });
    expect((await creator.call(env, "/api/orders", { body: { lookId: "sunset" } })).status).toBe(401);
  });

  it("the game and /admin have different people signed in at once, in one browser", async () => {
    const browser = await signedInWith(env, "berry", player, "play");
    await signedInWith(env, "nautilus", owner, "admin", browser);
    expect(browser.jar.has("session") && browser.jar.has("admin")).toBe(true);
    expect((await browser.call(env, "/api/me")).body).toMatchObject({ address: player.address });
    const summary = await browser.call(env, "/api/admin/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.address).toBe(owner.address);
    expect(await sessionCount()).toBe(2);
  });

  it("a second player sign-in does not end the admin login, and the admin sign-in does not end the player's", async () => {
    const browser = await signedInWith(env, "berry", player, "play");
    await signedInWith(env, "berry", owner, "admin", browser);
    const adminToken = browser.jar.get("admin");
    await signedInWith(env, "nanchat", testAccount(), "play", browser);
    expect(browser.jar.get("admin")).toBe(adminToken);
    expect((await browser.call(env, "/api/admin/summary")).status).toBe(200);
  });

  it("sign-out ends only its own login", async () => {
    const browser = await signedInWith(env, "berry", player, "play");
    await signedInWith(env, "berry", owner, "admin", browser);
    expect((await browser.call(env, "/api/signout", { body: { scope: "admin" } })).status).toBe(200);
    expect(browser.jar.has("admin")).toBe(false);
    expect((await browser.call(env, "/api/admin/summary")).status).toBe(401);
    expect((await browser.call(env, "/api/me")).body).toMatchObject({ address: player.address });
    expect(await sessionCount()).toBe(1);

    await signedInWith(env, "berry", owner, "admin", browser);
    expect((await browser.call(env, "/api/signout", { body: {} })).status).toBe(200);
    expect(browser.jar.has("session")).toBe(false);
    expect((await browser.call(env, "/api/me")).body).toMatchObject({ address: null });
    expect((await browser.call(env, "/api/admin/summary")).status).toBe(200);
    // A sign-out with no scope (an older page) ends the game's login, as before.
    const old = await signedInWith(env, "berry", player, "play");
    expect((await old.call(env, "/api/signout", { method: "POST" })).status).toBe(200);
    expect(old.jar.has("session")).toBe(false);
  });

  it("a request started for the game cannot be finished as an admin login, and the other way round", async () => {
    for (const [started, finished] of [["play", "admin"], ["admin", "play"]] as const) {
      const browser = new Browser();
      const start = await browser.call(env, "/api/signin/start", { body: { way: "berry", scope: started } });
      await walletAnswer(env, "berry", start.body, owner);
      const before = await sessionCount();
      const wrong = await browser.call(env, "/api/signin/check", { body: { id: start.body.id, way: "berry", scope: finished } });
      expect(wrong.body).toEqual({ status: "elsewhere" });
      expect(wrong.res.headers.getSetCookie()).toEqual([]);
      expect(await sessionCount()).toBe(before);
      // The right scope still finishes it, once.
      const right = await browser.call(env, "/api/signin/check", { body: { id: start.body.id, way: "berry", scope: started } });
      expect(right.body).toEqual({ status: "signedin", address: owner.address });
    }
  });

  it("any scope but \"admin\" is the game's", async () => {
    for (const scope of [undefined, "play", "root", 1, null, ["admin"]]) {
      const browser = new Browser();
      const start = await browser.call(env, "/api/signin/start", { body: { way: "berry", scope } });
      expect(cookieNames(start.res), String(scope)).toEqual(["starter"]);
    }
  });

  it("an admin login after one day is refused, and a sign-out of a login that is not there is fine", async () => {
    const creator = await signedInWith(env, "berry", owner, "admin");
    const later = Date.now() + ADMIN_SESSION_MS + 60_000;
    expect((await creator.call(env, "/api/admin/summary", { now: later })).status).toBe(401);
    expect((await new Browser().call(env, "/api/signout", { body: { scope: "admin" } })).status).toBe(200);
  });
});
