// The game and /admin each have their own login (two cookies, two sessions), so two different people can be signed in at once: a
// player in the game, the creator in /admin. A login made for the game can never open /admin, and an admin login is not a player.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { ADMIN_SESSION_MS, createSession, SESSION_DAYS, sessionOf, WAYS } from "../src/worker/signin";
import { Browser, signedInWith, walletAnswer, walletFrom } from "./api";
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
let visitors = 0;
beforeEach(async () => {
  // A new wallet visitor for each test (the wallet route's limit is kept in memory for the whole file).
  walletFrom.ip = `198.51.100.${10 + (++visitors % 200)}`;
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

describe("the server keeps the two logins apart, not only the cookies' names", () => {
  it("a game token put in the admin cookie does not open /admin, and an admin token put in the game's cookie is not a player", async () => {
    const asPlayer = await signedInWith(env, "berry", owner, "play");
    asPlayer.jar.set("admin", asPlayer.jar.get("session")!);
    expect((await asPlayer.call(env, "/api/admin/summary")).status).toBe(401);

    const asAdmin = await signedInWith(env, "berry", owner, "admin");
    asAdmin.jar.set("session", asAdmin.jar.get("admin")!);
    expect((await asAdmin.call(env, "/api/me")).body).toMatchObject({ address: null });
    expect((await asAdmin.call(env, "/api/orders", { body: { lookId: "sunset" } })).status).toBe(401);
  });

  it("a request's starter value copied from one scope's cookie to the other's does not finish it", async () => {
    const browser = new Browser();
    const start = await browser.call(env, "/api/signin/start", { body: { way: "berry", scope: "play" } });
    await walletAnswer(env, "berry", start.body, owner);
    browser.jar.set("starter-admin", browser.jar.get("starter")!);
    const before = await sessionCount();
    const done = await browser.call(env, "/api/signin/check", { body: { id: start.body.id, way: "berry", scope: "admin" } });
    expect(done.body).toEqual({ status: "elsewhere" });
    expect(browser.jar.has("admin")).toBe(false);
    expect(await sessionCount()).toBe(before);
  });

  it("another wallet makes no admin login, leaves the owner's admin login alone, and the request stays unused", async () => {
    const browser = await signedInWith(env, "berry", owner, "admin");
    const token = browser.jar.get("admin");
    const start = await browser.call(env, "/api/signin/start", { body: { way: "nanchat", scope: "admin" } });
    await walletAnswer(env, "nanchat", start.body, player);
    const before = await sessionCount();
    const refused = await browser.call(env, "/api/signin/check", { body: { id: start.body.id, way: "nanchat", scope: "admin" } });
    expect(refused.body).toEqual({ status: "not_owner", address: player.address });
    expect(refused.res.headers.getSetCookie()).toEqual([]);
    expect(browser.jar.get("admin")).toBe(token);
    expect(await sessionCount()).toBe(before);
    const used = await env.DB.prepare("SELECT delivered FROM signin_requests WHERE status = 'signedin' AND account = ?").bind(player.address).first<{ delivered: number }>();
    expect(used?.delivered ?? 0).toBe(0);
    expect((await browser.call(env, "/api/admin/summary")).status).toBe(200);
  });

  it("with no receive address, nobody makes an admin login", async () => {
    const none: Env = { ...env, RECEIVE_ADDRESS: "none" };
    const browser = new Browser();
    const start = await browser.call(none, "/api/signin/start", { body: { way: "berry", scope: "admin" } });
    await walletAnswer(none, "berry", start.body, owner);
    const done = await browser.call(none, "/api/signin/check", { body: { id: start.body.id, way: "berry", scope: "admin" } });
    expect(done.body).toEqual({ status: "not_owner", address: owner.address });
    expect(browser.jar.has("admin")).toBe(false);
  });

  it("a sign-out whose body is not JSON signs out of the game, as it always did", async () => {
    const browser = await signedInWith(env, "berry", player, "play");
    const res = await handle(browser, "/api/signout", "scope=admin");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(";")).toMatch(/session=;|session=; /);
  });
});

describe("on https the logins are `__Host-` cookies, one day and thirty days", () => {
  const https = "https://game.test";
  const field = (cookie: string, name: string) => cookie.split(";").map((p) => p.trim()).find((p) => p.toLowerCase().startsWith(`${name.toLowerCase()}=`));

  it("start, sign-in and sign-out set the right names, lifetimes and attributes", async () => {
    const browser = new Browser(https);
    const start = await browser.call(env, "/api/signin/start", { body: { way: "berry", scope: "admin" } });
    const [starter] = start.res.headers.getSetCookie();
    expect(starter!.startsWith("__Host-starter-admin=")).toBe(true);
    for (const attr of ["Path=/", "HttpOnly", "SameSite=Lax", "Secure", "Max-Age=1800"]) expect(starter, attr).toContain(attr);

    // The wallet app is reached on the same host: it reads the request over https too.
    const request = await (await import("../src/worker/index")).handleApi(new Request(`${https}/api/signin/nano/${start.body.id}`, { headers: { "CF-Connecting-IP": "198.51.100.9" } }), env, Date.now());
    expect(request.status).toBe(200);

    // A game login and an admin login, made directly: the https names and the lifetimes.
    const game = await createSession(env.DB, player.address, Date.now(), "wallet", "play");
    const admin = await createSession(env.DB, owner.address, Date.now(), "wallet", "admin");
    const asReq = (cookie: string) => new Request(`${https}/x`, { headers: { Cookie: cookie } });
    expect((await sessionOf(env.DB, asReq(`__Host-session=${game}`), Date.now(), "play"))?.address).toBe(player.address);
    expect((await sessionOf(env.DB, asReq(`__Host-admin=${admin}`), Date.now(), "admin"))?.address).toBe(owner.address);
    // The plain names are not read on https (a sibling subdomain can set them; it cannot set a `__Host-` one).
    expect(await sessionOf(env.DB, asReq(`session=${game}`), Date.now(), "play")).toBeNull();
    expect(await sessionOf(env.DB, asReq(`admin=${admin}`), Date.now(), "admin")).toBeNull();
    // And each token is good only in its own scope.
    expect(await sessionOf(env.DB, asReq(`__Host-admin=${game}`), Date.now(), "admin")).toBeNull();
    expect(await sessionOf(env.DB, asReq(`__Host-session=${admin}`), Date.now(), "play")).toBeNull();

    const rows = await env.DB.prepare("SELECT address, expires_at - created_at AS life FROM sessions WHERE address IN (?, ?)").bind(player.address, owner.address).all<{ address: string; life: number }>();
    const life = Object.fromEntries(rows.results.map((r) => [r.address, r.life]));
    expect(life[player.address]).toBe(SESSION_DAYS * 86_400_000);
    expect(life[owner.address]).toBe(ADMIN_SESSION_MS);

    const out = await browser.call(env, "/api/signout", { body: { scope: "admin" } });
    const [cleared] = out.res.headers.getSetCookie();
    expect(cleared!.startsWith("__Host-admin=")).toBe(true);
    expect(field(cleared!, "Max-Age")).toBe("Max-Age=0");
  });
});

/** A POST with a body that is not JSON, from the game's own page. */
async function handle(browser: Browser, path: string, raw: string): Promise<Response> {
  const { handleApi } = await import("../src/worker/index");
  const cookie = [...browser.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  return handleApi(new Request(`${browser.base}${path}`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: browser.base, Cookie: cookie, "CF-Connecting-IP": "203.0.113.7" }, body: raw }), env, Date.now());
}
