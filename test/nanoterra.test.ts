// Sign in from Nanoterra (src/worker/nanoterra.ts): the callback trades a one-time code for the player's details with a call from
// the server, then makes a session that never opens /admin. Nanoterra itself is a stand-in here (a fake fetch).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_SESSION_MS } from "../src/worker/admin";
import type { Env } from "../src/worker/env";
import { callback, exchangeCode, readPlayer } from "../src/worker/nanoterra";
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

describe("Sign in from Nanoterra", () => {
  it("trades the code for the player's details with a call from the server, and makes a session for that address", async () => {
    const calls: Call[] = [];
    const res = await visit(CODE, env, "203.0.113.10", nanoterra(200, answerOf(), calls));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^session=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax/);
    // One POST to Nanoterra's token endpoint, JSON, with the client id, the secret and the code; no redirect followed.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://nano133.com/api/nanoterra/token");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ client_id: "ng_00000000000000000001", client_secret: SECRET, code: CODE });
    expect((await sessionsOf(player.address)).map((s) => s.via)).toEqual(["nanoterra"]);
    const kept = await env.DB.prepare("SELECT username, look, items FROM nanoterra_players WHERE address = ?").bind(player.address).first<{ username: string; look: string; items: string }>();
    expect(kept).toMatchObject({ username: "Ann", look: JSON.stringify(LOOK), items: JSON.stringify(["hub.sun-hat"]) });
  });

  it("the browser then sees the name, the character and the address on /api/me", async () => {
    const browser = new Browser();
    const res = await visit(CODE, env, "203.0.113.11", nanoterra(200, answerOf()));
    browser.jar.set("session", decodeURIComponent(res.headers.getSetCookie()[0]!.split(";")[0]!.slice("session=".length)));
    const me = await browser.call(env, "/api/me");
    expect(me.body).toMatchObject({ address: player.address, via: "nanoterra", username: "Ann", look: LOOK, nanoterraItems: ["hub.sun-hat"], admin: false });
  });

  it("a second sign-in updates the name and the character, and makes another session", async () => {
    await visit(CODE, env, "203.0.113.12", nanoterra(200, answerOf({ username: "Ann2" })));
    const kept = await env.DB.prepare("SELECT username FROM nanoterra_players WHERE address = ?").bind(player.address).first<{ username: string }>();
    expect(kept!.username).toBe("Ann2");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM nanoterra_players WHERE address = ?").bind(player.address).first<{ n: number }>())!.n).toBe(1);
  });

  it("a session made here never opens /admin, even for the creator's own address", async () => {
    const res = await visit(CODE, env, "203.0.113.13", nanoterra(200, answerOf({ address: owner.address, playerId: owner.address })));
    expect(res.status).toBe(302);
    const browser = new Browser();
    browser.jar.set("session", decodeURIComponent(res.headers.getSetCookie()[0]!.split(";")[0]!.slice("session=".length)));
    const me = await browser.call(env, "/api/me");
    expect(me.body).toMatchObject({ address: owner.address, via: "nanoterra", admin: false });
    const summary = await browser.call(env, "/api/admin/summary");
    expect(summary.status).toBe(403);
    expect(summary.body.error).toContain("wallet");
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
    }
  });

  it("only GET works, and one address gets 20 tries a minute", async () => {
    const post = await callback(env, new Request(`${ORIGIN}/nanoterra/callback?code=${CODE}`, { method: "POST" }), "203.0.113.41");
    expect(post.status).toBe(405);
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
    } finally {
      console.warn = warn;
    }
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(CODE);
    const rows = JSON.stringify((await env.DB.prepare("SELECT * FROM nanoterra_players").all()).results) + JSON.stringify((await env.DB.prepare("SELECT * FROM sessions").all()).results);
    expect(rows).not.toContain(SECRET);
    expect(rows).not.toContain(CODE);
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
