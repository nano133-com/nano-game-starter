// The admin sign-in, hardened (Wes's security ideas, 2026-10-27). What a wallet signs for the ADMIN names the admin and where the request started, so that a link sent to the
// owner by a stranger does not look like any sign-in; a game sign-in signature can never open /admin and an admin one can never make a game session; an admin request lives 2
// minutes and works once; the sign-ins are listed with only three things; and "Sign out everywhere" ends the admin logins and no player's.

import { nanoSigninMessage } from "@nano133/signin";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { ADMIN_LOGIN_KEEP_MS, ADMIN_REQUEST_MS, createSession, recordAdminLogin } from "../src/worker/signin";
import { Browser, ORIGIN, signedInWith, walletAnswer, walletCall, walletFrom } from "./api";
import { berryAnswer, makeDb, nanoauthItem, nautilusAnswer, testAccount } from "./helpers";

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
  walletFrom.ip = `198.51.100.${10 + (++visitors % 200)}`;
  for (const t of ["hits", "sessions", "signin_requests", "admin_logins"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
const us = () => new Browser(ORIGIN, { "CF-IPCountry": "US", "User-Agent": CHROME_MAC });
const start = (b: Browser, way: "berry" | "nautilus" | "nanchat", scope: "play" | "admin", now?: number) => b.call(env, "/api/signin/start", { body: { way, scope }, now });
const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
const berryRequest = async (id: string) => (await walletCall(env, `/api/signin/nano/${id}`)).body as Record<string, string>;

describe("what the wallet signs for the admin", () => {
  it("Berry Wallet: the URI line of the signed text names the admin with no query (Berry refused \"/admin?from=US\"), and the text carries the start time; the game's names no admin", async () => {
    const a = await start(us(), "berry", "admin");
    expect(a.status).toBe(200);
    const req = await berryRequest(a.body.id);
    expect(req.uri).toBe(`${ORIGIN}/admin`);
    expect(new URL(req.uri).search).toBe("");
    const text = nanoSigninMessage(req as never, owner.address);
    expect(text).toContain(`URI: ${ORIGIN}/admin\n`);
    expect(text).not.toContain("?");
    expect(text).toContain(`Issued At: ${req.issuedAt}\n`);
    expect(new Date(req.issuedAt).toISOString()).toBe(req.issuedAt);

    const g = await start(new Browser(), "berry", "play");
    const gameReq = await berryRequest(g.body.id);
    expect(gameReq.uri).toBe(`${ORIGIN}/`);
    expect(nanoSigninMessage(gameReq as never, owner.address)).not.toContain("admin");
  });

  it("Berry Wallet: the address is the same /admin, with no query, with a country, with none (no header, or Cloudflare's XX and T1) and with a bad value", async () => {
    for (const value of [undefined, "US", "XX", "T1", "usa"]) {
      const b = new Browser(ORIGIN, value === undefined ? {} : { "CF-IPCountry": value });
      const a = await start(b, "berry", "admin");
      expect((await berryRequest(a.body.id)).uri, String(value)).toBe(`${ORIGIN}/admin`);
    }
  });

  it("Nautilus: the signed label says ADMIN and the country, the line it shows says when and from where and to not sign if it is not yours; the game's label is as it was", async () => {
    const a = await start(us(), "nautilus", "admin");
    const item = nanoauthItem(a.body.link);
    expect(item.label).toMatch(/^ADMIN of game\.test sign-in [A-Z2-9]{4}-[A-Z2-9]{4} from US$/);
    expect(item.message).toMatch(/^Sign in to the ADMIN of game\.test\. Started \d\d:\d\d UTC from US\. If you did not start this, do not sign\.$/);
    expect(item.label).not.toContain(":");
    const none = nanoauthItem((await start(new Browser(), "nautilus", "admin")).body.link);
    expect(none.label).toMatch(/^ADMIN of game\.test sign-in [A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(none.message).toContain("from an unknown country");
    const g = nanoauthItem((await start(new Browser(), "nautilus", "play")).body.link);
    expect(g.label).toMatch(/^game\.test sign-in [A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(g.message).toBe("Sign in to game.test. No payment: your wallet only signs this request.");
  });

  it("NanChat cannot name the admin, so it does not open the admin: the server refuses it for the admin and still offers it for the game", async () => {
    const a = await start(new Browser(), "nanchat", "admin");
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/NanChat cannot open the admin/);
    expect((await start(new Browser(), "nanchat", "play")).status).toBe(200);
    expect(await sessionCount()).toBe(0);
  });
});

describe("a game sign-in can never open /admin, and an admin sign-in can never make a game session", () => {
  for (const way of ["berry", "nautilus"] as const) {
    it(`${way}: a signature made for the game's request does not open the admin, in anyone's browser`, async () => {
      const game = new Browser();
      const s = await start(game, way, "play");
      await walletAnswer(env, way, s.body, owner); // the OWNER signs the game's text
      const before = await sessionCount();
      // A stranger's browser, and the game's own browser asking as the admin (its game cookie copied to the admin's name): neither gets an admin login.
      const stranger = new Browser();
      expect((await stranger.call(env, "/api/signin/check", { body: { id: s.body.id, way, scope: "admin" } })).body).toEqual({ status: "elsewhere" });
      expect(stranger.jar.has("admin")).toBe(false);
      game.jar.set("starter-admin", game.jar.get("starter")!);
      const asAdmin = await game.call(env, "/api/signin/check", { body: { id: s.body.id, way, scope: "admin" } });
      expect(asAdmin.body).toEqual({ status: "elsewhere" });
      expect(game.jar.has("admin")).toBe(false);
      expect(await sessionCount()).toBe(before);
      expect((await game.call(env, "/api/admin/summary")).status).toBe(401);
      // The control: asked as the game, it is a game session, and still no admin.
      const asGame = await game.call(env, "/api/signin/check", { body: { id: s.body.id, way, scope: "play" } });
      expect(asGame.body).toEqual({ status: "signedin", address: owner.address });
      expect(game.jar.has("session")).toBe(true);
      expect((await game.call(env, "/api/admin/summary")).status).toBe(401);
    });

    it(`${way}: a signature made for the admin's request makes no game session, in anyone's browser`, async () => {
      const admin = us();
      const s = await start(admin, way, "admin");
      await walletAnswer(env, way, s.body, owner); // the owner signs the ADMIN's text
      const before = await sessionCount();
      const stranger = new Browser();
      expect((await stranger.call(env, "/api/signin/check", { body: { id: s.body.id, way, scope: "play" } })).body).toEqual({ status: "elsewhere" });
      admin.jar.set("starter", admin.jar.get("starter-admin")!);
      const asGame = await admin.call(env, "/api/signin/check", { body: { id: s.body.id, way, scope: "play" } });
      expect(asGame.body).toEqual({ status: "elsewhere" });
      expect(admin.jar.has("session")).toBe(false);
      expect(await sessionCount()).toBe(before);
      expect((await admin.call(env, "/api/me")).body).toMatchObject({ address: null });
      // The control: asked as the admin, it is an admin login and no game session.
      const asAdmin = await admin.call(env, "/api/signin/check", { body: { id: s.body.id, way, scope: "admin" } });
      expect(asAdmin.body).toEqual({ status: "signedin", address: owner.address });
      expect(admin.jar.has("admin")).toBe(true);
      expect(admin.jar.has("session")).toBe(false);
      expect((await admin.call(env, "/api/me")).body).toMatchObject({ address: null, admin: false });
    });
  }

  it("Berry Wallet: the game's signed text sent for an admin request is refused, and so is the admin's sent for a game request; each is accepted only as its own", async () => {
    const a = await start(us(), "berry", "admin");
    const g = await start(new Browser(), "berry", "play");
    const adminReq = await berryRequest(a.body.id);
    const gameReq = await berryRequest(g.body.id);
    const post = (id: string, body: unknown) => walletCall(env, `/api/signin/nano/${id}`, body);
    // The game's text, signed, posted for the admin's request id (and the other way round).
    const gameText = nanoSigninMessage(gameReq as never, owner.address);
    const adminText = nanoSigninMessage(adminReq as never, owner.address);
    const crossA = await post(a.body.id, { ...berryAnswer(gameReq, owner, gameText), requestId: a.body.id });
    expect(crossA.status).toBe(401);
    expect(crossA.body.message).toBe("The signed text is not this sign-in's.");
    const crossG = await post(g.body.id, { ...berryAnswer(adminReq, owner, adminText), requestId: g.body.id });
    expect(crossG.status).toBe(401);
    // The admin request's OWN id with the game's form of the text (the URI line without /admin): refused too.
    const plain = nanoSigninMessage({ ...adminReq, uri: `${ORIGIN}/` } as never, owner.address);
    expect((await post(a.body.id, berryAnswer(adminReq, owner, plain))).status).toBe(401);
    // Nothing was used up: each is still waiting, and each is accepted as its own.
    expect((await walletCall(env, `/api/signin/nano/${a.body.id}`)).status).toBe(200);
    expect((await post(a.body.id, berryAnswer(adminReq, owner, adminText))).status).toBe(204);
    expect((await post(g.body.id, berryAnswer(gameReq, owner, gameText))).status).toBe(204);
  });

  it("Nautilus: the game's signed label sent for an admin request is refused, and so is the admin's sent for a game request", async () => {
    const a = await start(us(), "nautilus", "admin");
    const g = await start(new Browser(), "nautilus", "play");
    const adminItem = nanoauthItem(a.body.link);
    const gameItem = nanoauthItem(g.body.link);
    const post = (id: string, answer: unknown) => walletCall(env, `/api/signin/nautilus?id=${id}`, answer);
    const crossA = await post(a.body.id, nautilusAnswer(gameItem, owner));
    expect(crossA.body.status).toBe(1);
    expect(crossA.body.message).toBe("The signed text is not this sign-in's.");
    expect((await post(g.body.id, nautilusAnswer(adminItem, owner))).body.status).toBe(1);
    expect((await post(a.body.id, nautilusAnswer(adminItem, owner))).body.status).toBe(0);
    expect((await post(g.body.id, nautilusAnswer(gameItem, owner))).body.status).toBe(0);
  });
});

describe("an admin request lives 2 minutes and works once", () => {
  it("the admin's request ends after 2 minutes (the game's after 5): a signature after that is refused", async () => {
    expect(ADMIN_REQUEST_MS).toBe(120_000);
    const t0 = Date.now();
    for (const way of ["berry", "nautilus"] as const) {
      const a = await start(us(), way, "admin", t0);
      const g = await start(new Browser(), way, "play", t0);
      expect(a.body.expiresAt - t0, `${way} admin`).toBe(120_000);
      expect(g.body.expiresAt - t0, `${way} game`).toBe(300_000);
      const late = await walletAnswer(env, way, a.body, owner, t0 + 121_000);
      expect(late.status === 401 || late.body?.status === 1, `${way}: ${JSON.stringify(late.body)}`).toBe(true);
      const gameAtThatTime = await walletAnswer(env, way, g.body, owner, t0 + 121_000);
      expect(gameAtThatTime.status === 204 || gameAtThatTime.body?.status === 0, `${way} game still takes it`).toBe(true);
    }
  });

  it("a signature in time is delivered for one more minute after the request ends, and no longer; the game's is delivered for an hour as it always was", async () => {
    const t0 = Date.now();
    for (const way of ["berry", "nautilus"] as const) {
      const admin = us();
      const a = await start(admin, way, "admin", t0);
      await walletAnswer(env, way, a.body, owner, t0 + 100_000);
      const late = await admin.call(env, "/api/signin/check", { body: { id: a.body.id, way, scope: "admin" }, now: t0 + 120_000 + 61_000 });
      expect(late.body, way).toEqual({ status: "elsewhere" });
      expect(admin.jar.has("admin")).toBe(false);
      // The same timing in time: delivered.
      const admin2 = us();
      const b = await start(admin2, way, "admin", t0);
      await walletAnswer(env, way, b.body, owner, t0 + 100_000);
      expect((await admin2.call(env, "/api/signin/check", { body: { id: b.body.id, way, scope: "admin" }, now: t0 + 120_000 + 30_000 })).body, way).toEqual({ status: "signedin", address: owner.address });
      // The game's: 5 minutes and an hour of delivery, unchanged.
      const game = new Browser();
      const g = await start(game, way, "play", t0);
      await walletAnswer(env, way, g.body, owner, t0 + 100_000);
      expect((await game.call(env, "/api/signin/check", { body: { id: g.body.id, way, scope: "play" }, now: t0 + 300_000 + 61_000 })).body, way).toEqual({ status: "signedin", address: owner.address });
    }
  });

  it("an admin sign-in makes one login, once: a second check of the same request makes none", async () => {
    for (const way of ["berry", "nautilus"] as const) {
      const admin = us();
      const a = await start(admin, way, "admin");
      await walletAnswer(env, way, a.body, owner);
      expect((await admin.call(env, "/api/signin/check", { body: { id: a.body.id, way, scope: "admin" } })).body).toEqual({ status: "signedin", address: owner.address });
      const before = await sessionCount();
      expect((await admin.call(env, "/api/signin/check", { body: { id: a.body.id, way, scope: "admin" } })).body).toEqual({ status: "used" });
      expect(await sessionCount()).toBe(before);
      // Someone else who has the request's id and copies the cookie has no second login either.
      const copy = new Browser();
      copy.jar.set("starter-admin", admin.jar.get("starter-admin")!);
      expect((await copy.call(env, "/api/signin/check", { body: { id: a.body.id, way, scope: "admin" } })).body).toEqual({ status: "used" });
      expect(await sessionCount()).toBe(before);
    }
  });
});

describe("the list of admin sign-ins keeps three things", () => {
  const rows = async () => (await env.DB.prepare("SELECT * FROM admin_logins ORDER BY id").all<Record<string, unknown>>()).results;

  it("a sign-in is listed with the time, the country and a short browser name, newest first; the table holds nothing else", async () => {
    const first = await signedInWith(env, "berry", owner, "admin", us());
    const second = await signedInWith(env, "nautilus", owner, "admin", new Browser(ORIGIN, { "User-Agent": EDGE_WIN, "CF-Connecting-IP": "198.51.100.200" }));
    const list = (await second.call(env, "/api/admin/summary")).body.logins as Record<string, unknown>[];
    expect(list.length).toBe(2);
    expect(list.map((l) => [l.country, l.browser])).toEqual([[null, "Edge on Windows"], ["US", "Chrome on macOS"]]);
    for (const l of list) expect(Object.keys(l).sort()).toEqual(["at", "browser", "country"]);
    expect((list[0]!.at as number) >= (list[1]!.at as number)).toBe(true);
    expect((await first.call(env, "/api/admin/summary")).body.canSignOutEverywhere).toBe(true);
    const info = (await env.DB.prepare("PRAGMA table_info(admin_logins)").all<{ name: string }>()).results.map((c) => c.name);
    expect(info).toEqual(["id", "at", "country", "browser"]);
    const dump = JSON.stringify(await rows());
    for (const never of ["203.0.113", "198.51.100", "Mozilla", "AppleWebKit", owner.address]) expect(dump.includes(never), never).toBe(false);
  });

  it("the list shows the last 10", async () => {
    let admin: Browser | undefined;
    for (let i = 0; i < 12; i++) admin = await signedInWith(env, "berry", owner, "admin", us());
    expect(((await admin!.call(env, "/api/admin/summary")).body.logins as unknown[]).length).toBe(10);
    expect((await rows()).length).toBe(12);
  });

  it("a row older than 30 days is deleted when the next sign-in is written, and a row of 29 days stays", async () => {
    const now = Date.now();
    const req = new Request(`${ORIGIN}/`, { headers: { "CF-IPCountry": "DE", "User-Agent": CHROME_MAC } });
    await env.DB.prepare("INSERT INTO admin_logins (at, country, browser) VALUES (?, 'FR', 'Old'), (?, 'FR', 'Kept')").bind(now - ADMIN_LOGIN_KEEP_MS - 1000, now - ADMIN_LOGIN_KEEP_MS + 86_400_000).run();
    await recordAdminLogin(env.DB, req, now);
    const left = (await rows()).map((r) => r.browser);
    expect(left).toEqual(["Kept", "Chrome on macOS"]);
  });

  it("a hostile browser text and a hostile country header put nothing but the fixed words in the list", async () => {
    const hostile = new Browser(ORIGIN, { "User-Agent": "<script>alert(1)</script> \"); DROP TABLE admin_logins;--", "CF-IPCountry": "<s>" });
    const admin = await signedInWith(env, "berry", owner, "admin", hostile);
    const list = (await admin.call(env, "/api/admin/summary")).body.logins as { country: string | null; browser: string }[];
    expect(list).toEqual([{ at: expect.any(Number), country: null, browser: "Unknown browser" }]);
  });
});

describe("who makes admin logins", () => {
  it("a game sign-in makes only player sessions (scope play), and only a wallet signature started from /admin makes an admin one, with the word wallet", async () => {
    for (const way of ["berry", "nautilus"] as const) await signedInWith(env, way, player, "play");
    expect((await env.DB.prepare("SELECT scope, via FROM sessions").all<{ scope: string; via: string }>()).results).toEqual([
      { scope: "play", via: "wallet" },
      { scope: "play", via: "wallet" },
    ]);
    await signedInWith(env, "berry", owner, "admin", us());
    const rows = (await env.DB.prepare("SELECT scope, via, address FROM sessions ORDER BY scope").all<{ scope: string; via: string; address: string }>()).results;
    expect(rows.filter((r) => r.scope === "admin")).toEqual([{ scope: "admin", via: "wallet", address: owner.address }]);
    expect(rows.filter((r) => r.scope === "play").length).toBe(2);
  });
});

describe("Sign out everywhere", () => {
  it("ends every admin login (this browser's too) and no player's login; not from another site, not for a visitor", async () => {
    const a1 = await signedInWith(env, "berry", owner, "admin", us());
    const a2 = await signedInWith(env, "nautilus", owner, "admin", us());
    const p = new Browser();
    p.jar.set("session", await createSession(env.DB, player.address, Date.now(), "wallet", "play"));
    expect((await a1.call(env, "/api/admin/signout-all", { method: "POST", body: {}, origin: "https://evil.test" })).status).toBe(403);
    expect((await new Browser().call(env, "/api/admin/signout-all", { method: "POST", body: {} })).status).toBe(401);
    expect((await p.call(env, "/api/admin/signout-all", { method: "POST", body: {} })).status).toBe(401);
    expect((await a2.call(env, "/api/admin/summary")).status).toBe(200);
    const done = await a1.call(env, "/api/admin/signout-all", { method: "POST", body: {} });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ ok: true, signedOut: 2 });
    expect((await a1.call(env, "/api/admin/summary")).status).toBe(401);
    expect((await a2.call(env, "/api/admin/summary")).status).toBe(401);
    expect((await p.call(env, "/api/me")).body).toMatchObject({ address: player.address });
    const left = (await env.DB.prepare("SELECT scope, COUNT(*) AS n FROM sessions GROUP BY scope").all<{ scope: string; n: number }>()).results;
    expect(left).toEqual([{ scope: "play", n: 1 }]);
  });
});

describe("what the third security read found", () => {
  const checkAs = (b: Browser, id: string, way: "berry" | "nautilus", scope: "play" | "admin", now?: number) => b.call(env, "/api/signin/check", { body: { id, way, scope }, now });

  for (const way of ["berry", "nautilus"] as const) {
    it(`${way}: a signature for an ADMIN request never makes a game login, even with the starter cookie retyped with the admin prefix, even later (the game's one-hour delivery does not apply)`, async () => {
      const t0 = Date.now();
      const admin = us();
      const a = await start(admin, way, "admin", t0);
      await walletAnswer(env, way, a.body, owner, t0 + 10_000);
      const before = await sessionCount();
      const value = admin.jar.get("starter-admin")!;
      // The attack: put "admin:" + the admin starter in the game's starter cookie (percent-encoded too) and ask as the game.
      for (const forged of [`admin:${value}`, encodeURIComponent(`admin:${value}`)]) {
        const forger = new Browser(ORIGIN);
        forger.jar.set("starter", forged);
        for (const at of [t0 + 20_000, t0 + 30 * 60_000]) {
          const got = await checkAs(forger, a.body.id, way, "play", at);
          expect(got.body, `${way} at +${at - t0} ms`).toEqual({ status: "elsewhere" });
          expect(forger.jar.has("session")).toBe(false);
        }
      }
      // A starter that is not 64 hex characters is no starter at all, in either scope.
      for (const odd of ["x", "", "g".repeat(64), "A".repeat(64), "0".repeat(63), `${"0".repeat(64)} `]) {
        const b = new Browser(ORIGIN);
        b.jar.set("starter", odd);
        b.jar.set("starter-admin", odd);
        expect((await checkAs(b, a.body.id, way, "admin")).body, JSON.stringify(odd)).toEqual({ status: "elsewhere" });
        expect((await checkAs(b, a.body.id, way, "play")).body, JSON.stringify(odd)).toEqual({ status: "elsewhere" });
      }
      expect(await sessionCount()).toBe(before);
      // The request was not used up by those tries: its own browser still gets its admin login, once.
      expect((await checkAs(admin, a.body.id, way, "admin")).body).toEqual({ status: "signedin", address: owner.address });
    });
  }

  it("the rows know whose request they are: an admin request has scope admin, a game request scope play, and one with no scope is the game's", async () => {
    await start(us(), "berry", "admin");
    await start(new Browser(), "berry", "play");
    await start(us(), "nautilus", "admin");
    await start(new Browser(), "nautilus", "play");
    const rows = (await env.DB.prepare("SELECT way, scope FROM signin_requests ORDER BY way, scope").all<{ way: string; scope: string }>()).results;
    expect(rows).toEqual([{ way: "berry", scope: "admin" }, { way: "berry", scope: "play" }, { way: "nautilus", scope: "admin" }, { way: "nautilus", scope: "play" }]);
    await env.DB.prepare("INSERT INTO signin_requests (id, way, starter, status, expires_at) VALUES ('old', 'berry', 'x', 'waiting', 1)").run();
    expect((await env.DB.prepare("SELECT scope FROM signin_requests WHERE id = 'old'").first<{ scope: string }>())!.scope).toBe("play");
  });

  it("Berry: the admin's text comes from the stored SCOPE, not from a note: with the note removed an admin request still gets the admin's text, and the game's text is refused for it", async () => {
    const a = await start(us(), "berry", "admin");
    await env.DB.prepare("UPDATE signin_requests SET label = NULL WHERE id = ?").bind(a.body.id).run();
    const req = await berryRequest(a.body.id);
    expect(req.uri).toBe(`${ORIGIN}/admin`);
    const gameText = nanoSigninMessage({ ...req, uri: `${ORIGIN}/` } as never, owner.address);
    const crossed = await walletCall(env, `/api/signin/nano/${a.body.id}`, berryAnswer(req, owner, gameText));
    expect(crossed.status).toBe(401);
    expect(crossed.body.message).toBe("The signed text is not this sign-in's.");
    // A game request whose note says admin is still the game's text: the scope decides.
    const g = await start(new Browser(), "berry", "play");
    await env.DB.prepare("UPDATE signin_requests SET label = 'admin:US' WHERE id = ?").bind(g.body.id).run();
    expect((await berryRequest(g.body.id)).uri).toBe(`${ORIGIN}/`);
  });

  it("Sign out everywhere also ends an admin request that the owner signed but the browser has not collected: its check makes no login; a game request is left alone", async () => {
    for (const way of ["berry", "nautilus"] as const) {
      const pending = us();
      const a = await start(pending, way, "admin");
      await walletAnswer(env, way, a.body, owner); // signed, not yet delivered
      const gameBrowser = new Browser();
      const g = await start(gameBrowser, way, "play");
      await walletAnswer(env, way, g.body, owner);
      const other = await signedInWith(env, way, owner, "admin", us());
      expect((await other.call(env, "/api/admin/signout-all", { method: "POST", body: {} })).status).toBe(200);
      const got = await checkAs(pending, a.body.id, way, "admin");
      expect(got.body.status, way).not.toBe("signedin");
      expect(pending.jar.has("admin")).toBe(false);
      expect((await checkAs(gameBrowser, g.body.id, way, "play")).body, way).toEqual({ status: "signedin", address: owner.address });
    }
  });

  it("a session row is read only in its own scope: an admin token whose row says play opens nothing, and a game token whose row says admin is no game login", async () => {
    const admin = await signedInWith(env, "berry", owner, "admin", us());
    expect((await admin.call(env, "/api/admin/summary")).status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET scope = 'play' WHERE scope = 'admin'").run();
    expect((await admin.call(env, "/api/admin/summary")).status).toBe(401);
    await env.DB.prepare("DELETE FROM sessions").run();
    const player = await signedInWith(env, "berry", owner, "play");
    expect((await player.call(env, "/api/me")).body).toMatchObject({ address: owner.address });
    await env.DB.prepare("UPDATE sessions SET scope = 'admin'").run();
    expect((await player.call(env, "/api/me")).body).toMatchObject({ address: null });
  });
});

describe("the delivery and the session are one batch (a fourth security read found a race between them)", () => {
  /** The same Worker env, but with the database watched: `onBatch` runs once, just before the FIRST batch of two statements (the delivery and the session) is sent. */
  const watched = (onBatch: () => Promise<void>) => {
    const sizes: number[] = [];
    let armed = true;
    const DB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            sizes.push(statements.length);
            if (statements.length === 2 && armed) {
              armed = false;
              await onBatch();
            }
            return target.batch(statements);
          };
        }
        const value = (target as any)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    return { env: { ...env, DB } as Env, sizes };
  };

  for (const way of ["berry", "nautilus"] as const) {
    it(`${way}: a Sign out everywhere that runs just before the delivery leaves no admin login (the delivery changes no row, so no session is written)`, async () => {
      const pending = us();
      const a = await start(pending, way, "admin");
      await walletAnswer(env, way, a.body, owner); // signed, not yet collected
      const other = await signedInWith(env, way, owner, "admin", us());
      let ran = false;
      const w = watched(async () => {
        ran = true;
        expect((await other.call(env, "/api/admin/signout-all", { method: "POST", body: {} })).status).toBe(200);
      });
      const got = await pending.call(w.env, "/api/signin/check", { body: { id: a.body.id, way, scope: "admin" } });
      expect(ran, "the delivery and the session are not sent as one batch of two statements").toBe(true);
      expect(got.body.status).not.toBe("signedin");
      expect(pending.jar.has("admin")).toBe(false);
      expect(await sessionCount()).toBe(0);
    });

    it(`${way}: with no race the one batch makes the login, and a second check makes none`, async () => {
      const browser = us();
      const a = await start(browser, way, "admin");
      await walletAnswer(env, way, a.body, owner);
      const w = watched(async () => {});
      const got = await browser.call(w.env, "/api/signin/check", { body: { id: a.body.id, way, scope: "admin" } });
      expect(got.body).toEqual({ status: "signedin", address: owner.address });
      // The first batch is the delivery with its session; the second is the sign-in list's row.
      expect(w.sizes[0]).toBe(2);
      expect(await sessionCount()).toBe(1);
      expect((await browser.call(w.env, "/api/signin/check", { body: { id: a.body.id, way, scope: "admin" } })).body).toEqual({ status: "used" });
      expect(await sessionCount()).toBe(1);
    });
  }
});
