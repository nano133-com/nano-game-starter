// Sign in with Nautilus and NanChat through the game's own API routes, beside Berry Wallet, with keys made in this
// test. A valid signature signs in the browser that started the request, once; anything else is refused. Whichever
// wallet signs, only the creator's own address (RECEIVE_ADDRESS) opens /admin.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXAMPLE_ADDRESS, type Env } from "../src/worker/env";
import { WAYS } from "../src/worker/signin";
import { Browser, ORIGIN, signedInWith, walletCall } from "./api";
import { makeDb, nanauthOf, nanchatAnswer, nanoauthItem, nautilusAnswer, testAccount } from "./helpers";

let env: Env;
let close: () => Promise<void>;
const owner = testAccount();
const player = testAccount();
const forger = testAccount();
beforeAll(async () => {
  const made = await makeDb();
  close = made.close;
  env = { DB: made.db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off" };
});
afterAll(() => close());
// Each test starts with fresh rate-limit counters (they are kept per visitor in D1).
beforeEach(async () => void (await env.DB.prepare("DELETE FROM hits").run()));

async function begin(way: "nautilus" | "nanchat", e = env) {
  const browser = new Browser();
  const start = await browser.call(e, "/api/signin/start", { body: { way } });
  expect(start.status).toBe(200);
  expect(start.body.way).toBe(way);
  return { browser, id: start.body.id as string, link: start.body.link as string, code: start.body.code as string | undefined };
}

const check = (browser: Browser, id: string, way: string, e = env) => browser.call(e, "/api/signin/check", { body: { id, way } });

describe("Sign in with Nautilus", () => {
  it("a valid answer signs in the browser that started it, with a new session, once", async () => {
    const { browser, id, link, code } = await begin("nautilus");
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const item = nanoauthItem(link);
    expect(item.label).toBe(`game.test sign-in ${code}`);
    expect(item.account).toBe(owner.address);
    expect(item.method).toEqual({ type: "post", url: `${ORIGIN}/api/signin/nautilus?id=${id}` });

    const answer = await walletCall(env, `/api/signin/nautilus?id=${id}`, nautilusAnswer(item, player));
    expect(answer).toEqual({ status: 200, body: { status: 0, message: "Signed in to game.test. You can go back to the page now.", label: "game.test" } });

    expect((await check(browser, id, "nautilus")).body).toEqual({ status: "signedin", address: player.address });
    expect((await browser.call(env, "/api/me")).body).toMatchObject({ address: player.address, admin: false });
    expect((await check(browser, id, "nautilus")).body).toEqual({ status: "used" });
    expect((await check(new Browser(), id, "nautilus")).body).toEqual({ status: "elsewhere" });
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE address = ?").bind(player.address).first<{ n: number }>();
    expect(sessions!.n).toBe(1);
  });

  it("an invalid answer is refused (HTTP 200, so Nautilus shows the words) and signs nobody in", async () => {
    const { browser, id, link } = await begin("nautilus");
    const item = nanoauthItem(link);
    // Signed by another key, but claiming the player's address.
    const forged = { ...nautilusAnswer(item, forger), account: player.address };
    const answer = await walletCall(env, `/api/signin/nautilus?id=${id}`, forged);
    expect(answer).toEqual({ status: 200, body: { status: 1, message: "The signature does not match this wallet.", label: "game.test" } });
    // Another request's label is not this request's.
    const other = await walletCall(env, `/api/signin/nautilus?id=${id}`, nautilusAnswer({ ...item, label: "game.test sign-in AAAA-AAAA" }, player));
    expect(other.body).toMatchObject({ status: 1, message: "The signed text is not this sign-in's." });
    expect((await check(browser, id, "nautilus")).body).toEqual({ status: "waiting" });
    expect((await browser.call(env, "/api/me")).body.address).toBeNull();
  });

  it("names the example address while no receive address is set, and still signs in", async () => {
    const test = { ...env, RECEIVE_ADDRESS: EXAMPLE_ADDRESS };
    const { browser, id, link } = await begin("nautilus", test);
    const item = nanoauthItem(link);
    expect(item.account).toBe(EXAMPLE_ADDRESS);
    expect((await walletCall(test, `/api/signin/nautilus?id=${id}`, nautilusAnswer(item, player))).body.status).toBe(0);
    expect((await check(browser, id, "nautilus", test)).body).toEqual({ status: "signedin", address: player.address });
  });
});

describe("Sign in with NanChat", () => {
  it("a valid answer signs in the browser that started it, with a new session, once", async () => {
    const { browser, id, link } = await begin("nanchat");
    expect(link.startsWith("https://nanchat.com/?uri=nanauth://sign?message=")).toBe(true);
    const { message, url } = nanauthOf(link);
    expect(message).toMatch(/^Login to game\.test nonce: [0-9a-f]{32}$/);
    expect(url).toBe(`${ORIGIN}/api/signin/nanchat`);

    const answer = await walletCall(env, "/api/signin/nanchat", nanchatAnswer(message, player));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true });
    expect(answer.body.message).toMatch(/^Signed in to game\.test, in the browser that showed this request\./);

    expect((await check(browser, id, "nanchat")).body).toEqual({ status: "signedin", address: player.address });
    expect((await browser.call(env, "/api/me")).body).toMatchObject({ address: player.address, admin: false });
    expect((await check(browser, id, "nanchat")).body).toEqual({ status: "used" });
    expect((await check(new Browser(), id, "nanchat")).body).toEqual({ status: "elsewhere" });
  });

  it("an invalid answer is refused (its words start NOT signed in) and signs nobody in", async () => {
    const { browser, id, link } = await begin("nanchat");
    const { message } = nanauthOf(link);
    const forged = { ...nanchatAnswer(message, forger), account: player.address };
    const answer = await walletCall(env, "/api/signin/nanchat", forged);
    expect(answer).toEqual({ status: 200, body: { ok: false, error: "NOT signed in: the signature does not match this wallet." } });
    // A text for another site is not a sign-in to this game.
    const elsewhere = await walletCall(env, "/api/signin/nanchat", nanchatAnswer(message.replace("game.test", "evil.test"), player));
    expect(elsewhere.body).toEqual({ ok: false, error: "NOT signed in: the signed text is not a sign-in to game.test." });
    expect((await check(browser, id, "nanchat")).body).toEqual({ status: "waiting" });
    expect((await browser.call(env, "/api/me")).body.address).toBeNull();
  });

  it("takes at most 5 tries for one sign-in (NanChat's answers all come from one relay, so the limit is per nonce)", async () => {
    const { browser, id, link } = await begin("nanchat");
    const { message } = nanauthOf(link);
    const forged = { ...nanchatAnswer(message, forger), account: player.address };
    for (let i = 0; i < 5; i++) expect((await walletCall(env, "/api/signin/nanchat", forged)).body.error).toMatch(/does not match/);
    const sixth = await walletCall(env, "/api/signin/nanchat", nanchatAnswer(message, player));
    expect(sixth.body).toEqual({ ok: false, error: "NOT signed in: too many tries for this sign-in. Start again on game.test." });
    expect((await check(browser, id, "nanchat")).body).toEqual({ status: "waiting" });
  });
});

describe("the admin guard, with each wallet", () => {
  for (const way of WAYS) {
    it(`${way}: opens for the receive address, and refuses another address`, async () => {
      const creator = await signedInWith(env, way, owner, "admin");
      expect((await creator.call(env, "/api/admin/summary")).status).toBe(200);
      // The admin login is not the game's: this browser is still a guest in the game.
      expect((await creator.call(env, "/api/me")).body).toMatchObject({ address: null, admin: false });

      const someone = await signedInWith(env, way, player, "admin");
      const refused = await someone.call(env, "/api/admin/summary");
      expect(refused.status).toBe(403);
      expect(refused.body.signedInAs).toBe(player.address);
    });
  }

  it("refuses a way that is not one of the game's", async () => {
    expect((await new Browser().call(env, "/api/signin/start", { body: { way: "natrium" } })).status).toBe(400);
    expect((await new Browser().call(env, "/api/signin/check", { body: { id: "x", way: "natrium" } })).status).toBe(400);
  });
});
