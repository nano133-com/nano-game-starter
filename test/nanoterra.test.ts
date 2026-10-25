// Sign in from Nanoterra (src/worker/nanoterra.ts): the callback trades a one-time code for the player's details with a call from
// the server and shows a confirm screen; only a press of Continue (from the same browser and the game's own page) makes a session,
// and that session never opens /admin. Nanoterra itself is a stand-in here (a fake fetch).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_SESSION_MS } from "../src/worker/admin";
import type { Env } from "../src/worker/env";
import { bindOf, callback, cancel, confirm, exchangeCode, pendingToken, readPlayer } from "../src/worker/nanoterra";
import { Browser, ORIGIN } from "./api";
import { makeDb, testAccount } from "./helpers";

let env: Env;
let close: () => Promise<void>;
const player = testAccount();
const owner = testAccount();
const CODE = "A".repeat(43);
const SECRET = "ns_test-secret-never-real";
const LOOK = { skin: "#f2c29b", hair: "#3a2a1e", shirt: "#2a9df4", pants: "#1e2a4a", shoes: "#ffffff" };

beforeAll(async () => {
  const made = await makeDb();
  close = made.close;
  env = { DB: made.db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off", NANOTERRA_CLIENT_ID: "ng_00000000000000000001", NANOTERRA_SECRET: SECRET };
});
afterAll(() => close());

const answerOf = (over: Record<string, unknown> = {}) => ({ username: "Ann", address: player.address, playerId: player.address, character: { v: 1, look: LOOK, items: ["hub.sun-hat"] }, ...over });
type Call = { url: string; init: RequestInit };
/** A stand-in for Nanoterra's token endpoint. */
const nanoterra = (status: number, body: unknown, calls: Call[] = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
const visit = (code: string | null, e: Env = env, ip = "203.0.113.9", fetcher?: typeof fetch) =>
  callback(e, new Request(`${ORIGIN}/nanoterra/callback${code === null ? "" : `?code=${code}`}`, { headers: { "CF-Connecting-IP": ip } }), ip, Date.now(), fetcher);
const sessionsOf = async (address: string) => (await env.DB.prepare("SELECT via FROM sessions WHERE address = ?").bind(address).all<{ via: string }>()).results;
const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
/** The `name=value` pair of a cookie that a response sets, as a browser sends it back. */
const pairOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? null;
/** A press of Continue (or Not me) as the confirm screen's form makes it. */
const press = (what: "confirm" | "cancel", cookie: string | null, o: { origin?: string | null; ip?: string; method?: string; now?: number; e?: Env; bind?: string } = {}) => {
  const ip = o.ip ?? "203.0.113.9";
  const headers = new Headers({ "CF-Connecting-IP": ip });
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  if (origin) headers.set("Origin", origin);
  if (cookie) headers.set("Cookie", cookie);
  const method = o.method ?? "POST";
  const body = method === "POST" && o.bind !== undefined ? new URLSearchParams({ bind: o.bind }) : undefined;
  const req = new Request(`${ORIGIN}/nanoterra/${what}`, { method, headers, body });
  return what === "confirm" ? confirm(o.e ?? env, req, ip, o.now) : cancel(o.e ?? env, req, o.now);
};
/** The `bind` field of the confirm screen in `html`. */
const bindIn = (html: string) => /name="bind" value="([0-9a-f]{32})"/.exec(html)?.[1];
/** The whole sign-in as a browser does it: the callback (the confirm screen), then Continue. */
const signIn = async (code: string, ip: string, fetcher: typeof fetch) => {
  const shown = await visit(code, env, ip, fetcher);
  const done = await press("confirm", pairOf(shown, "nanoterra-pending"), { ip, bind: bindIn(await shown.text()) });
  return { shown, done };
};

describe("Sign in from Nanoterra", () => {
  it("trades the code for the player's details with a call from the server, keeps them, and shows a confirm screen: no session yet", async () => {
    const calls: Call[] = [];
    const res = await visit(CODE, env, "203.0.113.10", nanoterra(200, answerOf(), calls));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // Not "no-referrer": a browser then sends `Origin: null` on the form's POST and Continue would be refused (seen in a real browser).
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("Sign in as Ann?");
    expect(html).toContain(`<code>${player.address.slice(0, 11)}\u2026${player.address.slice(-6)}</code>`);
    expect(html).toContain('<form method="post" action="/nanoterra/confirm">');
    expect(html).toContain('<form method="post" action="/nanoterra/cancel">');
    expect(html).not.toContain(player.address);
    // The Continue form carries a hash of the cookie's token (so a press is tied to this screen), never the token itself.
    const cookieToken = decodeURIComponent(res.headers.getSetCookie()[0]!.split(";")[0]!.slice("nanoterra-pending=".length));
    expect(bindIn(html)).toBe(await bindOf(cookieToken));
    expect(html).not.toContain(cookieToken);
    // The only cookie is the one that waits for Continue: signed, 5 minutes, this site only, and no session cookie.
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^nanoterra-pending=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Max-Age=300; HttpOnly; SameSite=Lax/);
    // One POST to Nanoterra's token endpoint, JSON, with the client id, the secret and the code; no redirect followed.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://nano133.com/api/nanoterra/token");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ client_id: "ng_00000000000000000001", client_secret: SECRET, code: CODE });
    expect(await sessionsOf(player.address)).toEqual([]);
    const kept = await env.DB.prepare("SELECT username, look, items FROM nanoterra_players WHERE address = ?").bind(player.address).first<{ username: string; look: string; items: string }>();
    expect(kept).toMatchObject({ username: "Ann", look: JSON.stringify(LOOK), items: JSON.stringify(["hub.sun-hat"]) });
  });

  it("Continue makes the session for that address, drops the pending cookie and goes to the game", async () => {
    const { done } = await signIn(CODE, "203.0.113.15", nanoterra(200, answerOf()));
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe("/");
    expect(done.headers.get("Cache-Control")).toBe("no-store");
    const cookies = done.headers.getSetCookie();
    expect(cookies[0]).toMatch(/^session=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax/);
    expect(cookies[1]).toMatch(/^nanoterra-pending=; Path=\/; Max-Age=0/);
    expect((await sessionsOf(player.address)).map((s) => s.via)).toEqual(["nanoterra"]);
  });

  it("the browser then sees the name, the character and the address on /api/me", async () => {
    const browser = new Browser();
    const { done } = await signIn(CODE, "203.0.113.11", nanoterra(200, answerOf()));
    browser.jar.set("session", decodeURIComponent(pairOf(done, "session")!.slice("session=".length)));
    const me = await browser.call(env, "/api/me");
    expect(me.body).toMatchObject({ address: player.address, via: "nanoterra", username: "Ann", look: LOOK, nanoterraItems: ["hub.sun-hat"], admin: false });
  });

  it("a second sign-in updates the name and the character", async () => {
    await visit(CODE, env, "203.0.113.12", nanoterra(200, answerOf({ username: "Ann2" })));
    const kept = await env.DB.prepare("SELECT username FROM nanoterra_players WHERE address = ?").bind(player.address).first<{ username: string }>();
    expect(kept!.username).toBe("Ann2");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM nanoterra_players WHERE address = ?").bind(player.address).first<{ n: number }>())!.n).toBe(1);
  });

  it("a session made here never opens /admin, even for the creator's own address", async () => {
    const { done } = await signIn(CODE, "203.0.113.13", nanoterra(200, answerOf({ address: owner.address, playerId: owner.address })));
    expect(done.status).toBe(303);
    // The confirm screen makes the game's login only: it never sets, replaces or clears the admin login.
    expect(done.headers.getSetCookie().filter((c) => /^(__Host-)?admin=/.test(c))).toEqual([]);
    const browser = new Browser();
    browser.jar.set("session", decodeURIComponent(pairOf(done, "session")!.slice("session=".length)));
    const me = await browser.call(env, "/api/me");
    expect(me.body).toMatchObject({ address: owner.address, via: "nanoterra", admin: false });
    // The game's login is not an admin login: /admin reads only its own cookie, so this browser is simply not signed in there.
    const summary = await browser.call(env, "/api/admin/summary");
    expect(summary.status).toBe(401);
    expect((await browser.call(env, "/api/admin/check", { method: "POST", body: {} })).status).toBe(401);
    // And if that very token were put in the admin cookie, a Nanoterra login is still refused (defence in depth).
    browser.jar.set("admin", browser.jar.get("session")!);
    const forced = await browser.call(env, "/api/admin/summary");
    expect(forced.status).toBe(403);
    expect(forced.body.error).toContain("wallet");
    expect(forced.body.reason).toBe("nanoterra");
    expect((await browser.call(env, "/api/admin/check", { method: "POST", body: {} })).status).toBe(403);
    expect(ADMIN_SESSION_MS).toBeGreaterThan(0);
  });

  it("a code of the wrong shape or a missing code is a 400 page and makes no call", async () => {
    const calls: Call[] = [];
    for (const code of [null, "", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}!`, "../../x"]) {
      const res = await visit(code, env, "203.0.113.14", nanoterra(200, answerOf(), calls));
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(await res.text()).toContain('<a href="/">Play as a guest</a>');
    }
    expect(calls).toHaveLength(0);
  });

  it("a refusal, a fault or a wrong answer makes no session", async () => {
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
    const refusals: [string, typeof fetch][] = [
      ["a 400 refusal", nanoterra(400, { error: "invalid" })],
      ["a 500", nanoterra(500, "boom")],
      ["a redirect", nanoterra(302, "")],
      ["not JSON", nanoterra(200, "<html>")],
      ["a network fault", (async () => { throw new TypeError("network"); }) as unknown as typeof fetch],
      ["a answer that is too large", nanoterra(200, JSON.stringify({ pad: "x".repeat(5000) }))],
      ["a bad address", nanoterra(200, answerOf({ address: "nano_notanaddress", playerId: "nano_notanaddress" }))],
      ["a playerId that is not the address", nanoterra(200, answerOf({ playerId: owner.address }))],
      ["an empty name", nanoterra(200, answerOf({ username: "  " }))],
      ["a name over 60 characters", nanoterra(200, answerOf({ username: "x".repeat(61) }))],
      ["a character of version 2", nanoterra(200, answerOf({ character: { v: 2, look: LOOK, items: [] } }))],
      ["a look colour that is not hex", nanoterra(200, answerOf({ character: { v: 1, look: { ...LOOK, shirt: "red" }, items: [] } }))],
      ["a missing look part", nanoterra(200, answerOf({ character: { v: 1, look: { skin: LOOK.skin }, items: [] } }))],
    ];
    for (const [name, fetcher] of refusals) {
      const res = await visit(CODE, env, `203.0.113.${20 + refusals.findIndex(([n]) => n === name)}`, fetcher);
      expect(res.status, name).toBe(400);
      expect(res.headers.getSetCookie(), name).toEqual([]);
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(before);
  });

  it("is off until both the client id and the secret are set", async () => {
    for (const e of [{ ...env, NANOTERRA_SECRET: undefined }, { ...env, NANOTERRA_CLIENT_ID: "none" }, { ...env, NANOTERRA_SECRET: "  " }, { ...env, NANOTERRA_CLIENT_ID: undefined }] as Env[]) {
      const calls: Call[] = [];
      const res = await visit(CODE, e, "203.0.113.40", nanoterra(200, answerOf(), calls));
      expect(res.status).toBe(503);
      expect(calls).toHaveLength(0);
      expect((await press("confirm", null, { e })).status).toBe(503);
    }
  });

  it("only GET works, and one address gets 20 tries a minute", async () => {
    const post = await callback(env, new Request(`${ORIGIN}/nanoterra/callback?code=${CODE}`, { method: "POST" }), "203.0.113.41");
    expect(post.status).toBe(405);
    expect((await press("confirm", null, { method: "GET" })).status).toBe(405);
    expect((await press("cancel", null, { method: "GET" })).status).toBe(405);
    let last = 0;
    for (let i = 0; i < 22 && last !== 429; i++) last = (await visit(CODE, env, "203.0.113.42", nanoterra(400, { error: "invalid" }))).status;
    expect(last).toBe(429);
  });

  it("the secret is in the call to Nanoterra and nowhere else: not in the page, the cookie, the log or the stored rows", async () => {
    const logs: string[] = [];
    const spy = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    const { warn } = console;
    console.warn = spy;
    try {
      const refused = await visit(CODE, env, "203.0.113.43", nanoterra(400, { error: "invalid" }));
      const ok = await visit(CODE, env, "203.0.113.44", nanoterra(200, answerOf()));
      expect(await refused.text()).not.toContain(SECRET);
      expect(ok.headers.get("Set-Cookie") ?? "").not.toContain(SECRET);
      expect(await ok.text()).not.toContain(SECRET);
    } finally {
      console.warn = warn;
    }
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(CODE);
    const rows = JSON.stringify((await env.DB.prepare("SELECT * FROM nanoterra_players").all()).results) + JSON.stringify((await env.DB.prepare("SELECT * FROM sessions").all()).results);
    expect(rows).not.toContain(SECRET);
    expect(rows).not.toContain(CODE);
  });

  it("Not me drops the pending cookie and makes no session", async () => {
    const before = await sessionCount();
    const shown = await visit(CODE, env, "203.0.113.50", nanoterra(200, answerOf()));
    const bind = bindIn(await shown.clone().text());
    const res = await press("cancel", pairOf(shown, "nanoterra-pending"), { ip: "203.0.113.50" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.getSetCookie()).toHaveLength(1);
    expect(res.headers.getSetCookie()[0]).toMatch(/^nanoterra-pending=; Path=\/; Max-Age=0/);
    expect(await sessionCount()).toBe(before);
    // The token is used up: a copy of the cookie that someone kept does not sign in.
    expect((await press("confirm", pairOf(shown, "nanoterra-pending"), { ip: "203.0.113.50", bind })).status).toBe(400);
    expect(await sessionCount()).toBe(before);
  });

  it("a link with someone else's code makes no session by itself, and a press of Continue needs this browser's own cookie", async () => {
    const before = await sessionCount();
    // The victim opens the attacker's callback link: only the screen. The attacker's own cookie never reaches the victim's browser.
    const attacker = await visit(CODE, env, "203.0.113.51", nanoterra(200, answerOf({ username: "Mallory" })));
    expect(await attacker.text()).toContain("Sign in as Mallory?");
    expect(await sessionCount()).toBe(before);
    // A form on another site posts to /nanoterra/confirm: no cookie (SameSite=Lax) and the wrong Origin.
    expect((await press("confirm", null, { origin: "http://evil.test", ip: "203.0.113.52" })).status).toBe(403);
    expect((await press("confirm", null, { ip: "203.0.113.53" })).status).toBe(400);
    expect(await sessionCount()).toBe(before);
  });

  it("a pending cookie that was changed, signed with another secret, run out or for a bad address makes no session; so does a request from another site", async () => {
    const before = await sessionCount();
    const now = Date.now();
    const good = await pendingToken(env, player.address, now);
    const [payload, sig] = good.split(".") as [string, string];
    const bad: [string, string][] = [
      ["a changed payload", `${payload.slice(0, -2)}${payload.endsWith("AA") ? "BB" : "AA"}.${sig}`],
      ["a changed signature", `${payload}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`],
      ["no signature", payload],
      ["three parts", `${good}.x`],
      ["a token that is not base64", "!!!.???"],
      ["another secret", await pendingToken({ ...env, NANOTERRA_SECRET: "ns_another-secret" }, player.address, now)],
      ["a bad address", await pendingToken(env, "nano_notanaddress", now)],
      ["too long", `${payload}.${"A".repeat(600)}`],
    ];
    for (const [name, token] of bad) expect((await press("confirm", `nanoterra-pending=${token}`, { ip: "203.0.113.60", now })).status, name).toBe(400);
    // Run out: 5 minutes and one second later.
    expect((await press("confirm", `nanoterra-pending=${good}`, { ip: "203.0.113.61", now: now + 301_000 })).status).toBe(400);
    // A good cookie from another site's form, or with no Origin and no Sec-Fetch-Site, is refused.
    expect((await press("confirm", `nanoterra-pending=${good}`, { ip: "203.0.113.62", now, origin: "http://evil.test" })).status).toBe(403);
    expect((await press("confirm", `nanoterra-pending=${good}`, { ip: "203.0.113.63", now, origin: null })).status).toBe(403);
    expect(await sessionCount()).toBe(before);
    // And the good one, from the game's own page, works.
    const bind = await bindOf(good);
    expect((await press("confirm", `nanoterra-pending=${good}`, { ip: "203.0.113.64", now, bind })).status).toBe(303);
    expect(await sessionCount()).toBe(before + 1);
  });

  it("a press is tied to its screen: a second callback in the same browser, or no bind field, makes no session", async () => {
    const before = await sessionCount();
    // The victim's screen is drawn, then an attacker's callback replaces the cookie (a second tab, or a link that the victim follows).
    const victim = await visit(CODE, env, "203.0.113.80", nanoterra(200, answerOf({ username: "Victim" })));
    const victimBind = bindIn(await victim.text());
    const attacker = await visit(CODE, env, "203.0.113.81", nanoterra(200, answerOf({ username: "Mallory", address: owner.address, playerId: owner.address })));
    const attackerCookie = pairOf(attacker, "nanoterra-pending");
    // The browser now sends the ATTACKER's cookie, and the form of the victim's screen.
    const res = await press("confirm", attackerCookie, { ip: "203.0.113.82", bind: victimBind });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That sign-in changed");
    expect((await press("confirm", attackerCookie, { ip: "203.0.113.83" })).status).toBe(400);
    expect((await press("confirm", attackerCookie, { ip: "203.0.113.84", bind: "0".repeat(32) })).status).toBe(400);
    expect(await sessionCount()).toBe(before);
    // The attacker's own screen still works for the attacker's own press.
    expect((await press("confirm", attackerCookie, { ip: "203.0.113.85", bind: bindIn(await attacker.text()) })).status).toBe(303);
  });

  it("a pending cookie works once: a second press with the same cookie makes no second session", async () => {
    const shown = await visit(CODE, env, "203.0.113.90", nanoterra(200, answerOf()));
    const cookie = pairOf(shown, "nanoterra-pending");
    const bind = bindIn(await shown.text());
    const before = await sessionCount();
    expect((await press("confirm", cookie, { ip: "203.0.113.91", bind })).status).toBe(303);
    expect(await sessionCount()).toBe(before + 1);
    for (let i = 0; i < 3; i++) {
      const again = await press("confirm", cookie, { ip: `203.0.113.${92 + i}`, bind });
      expect(again.status).toBe(400);
      expect(await again.text()).toContain("That sign-in was used");
    }
    expect(await sessionCount()).toBe(before + 1);
  });

  it("a name that holds markup is escaped on the confirm screen, and the cookie stays small for a player with many items", async () => {
    const name = `<img src=x onerror=alert(1)> & "q" 'a'`;
    const items = Array.from({ length: 64 }, (_, i) => `item.${String(i).padStart(2, "0")}${"x".repeat(40)}`);
    const res = await visit(CODE, env, "203.0.113.70", nanoterra(200, answerOf({ username: name, character: { v: 1, look: LOOK, items } })));
    const html = await res.text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img src=x onerror=alert(1)&#62; &#38; &#34;q&#34; &#39;a&#39;");
    expect(res.headers.getSetCookie()[0]!.length).toBeLessThan(400);
  });

  it("readPlayer keeps only what it knows, and exchangeCode times out as a refusal", async () => {
    expect(readPlayer(answerOf())).toEqual({ username: "Ann", address: player.address, look: LOOK, items: ["hub.sun-hat"] });
    expect(readPlayer(answerOf({ character: { v: 1, look: LOOK, items: ["ok.id", 5, "BAD ID", "x".repeat(60), "a.b-c"] } }))!.items).toEqual(["ok.id", "a.b-c"]);
    expect(readPlayer(null)).toBeNull();
    expect(readPlayer([])).toBeNull();
    const slow = (async () => { throw new DOMException("timeout", "TimeoutError"); }) as unknown as typeof fetch;
    expect(await exchangeCode(env, CODE, slow)).toBeNull();
  });

  it("the listing says how the game signs a player in", async () => {
    const { listing } = await import("../src/worker/index");
    expect(listing(env, new Request(`${ORIGIN}/nano-game.json`)).signin).toBe("exchange");
  });
});
