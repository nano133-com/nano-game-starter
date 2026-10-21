// Sign in with Nano (Berry Wallet, nano-signin-v1) through the game's own API routes, with keys made in this
// test. A valid signature signs in the browser that started the request, once; anything else is refused.

import { nanoSigninMessage } from "@nano133/signin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import { Browser, ORIGIN, walletCall } from "./api";
import { berryAnswer, makeDb, testAccount } from "./helpers";

let env: Env;
let close: () => Promise<void>;
beforeAll(async () => {
  const made = await makeDb();
  close = made.close;
  env = { DB: made.db, RECEIVE_ADDRESS: testAccount().address, TEST_MODE: "off" };
});
afterAll(() => close());

const player = testAccount();

/** The browser starts, the wallet reads the request. */
async function begin(browser = new Browser()) {
  const start = await browser.call(env, "/api/signin/start", { body: {} });
  expect(start.status).toBe(200);
  const read = await walletCall(env, `/api/signin/nano/${start.body.id}`);
  expect(read.status).toBe(200);
  return { browser, id: start.body.id as string, start: start.body, request: read.body as Record<string, string> };
}

describe("Sign in with Nano", () => {
  it("a valid signature signs in the browser that started it, with a new session, once", async () => {
    const { browser, id, start, request } = await begin();
    expect(start.link).toBe(`berrypay://signin?request_uri=${encodeURIComponent(`${ORIGIN}/api/signin/nano/${id}`)}`);
    expect(request.domain).toBe("game.test");
    const message = nanoSigninMessage(request as any, player.address);
    expect(message).toContain("game.test wants you to sign in with your Nano account:");

    const answer = await walletCall(env, `/api/signin/nano/${id}`, berryAnswer(request, player, message));
    expect(answer).toEqual({ status: 204, body: null }); // Berry Wallet shows success only for 204 with no body

    const check = await browser.call(env, "/api/signin/check", { body: { id } });
    expect(check.body).toEqual({ status: "signedin", address: player.address });
    expect((await browser.call(env, "/api/me")).body).toMatchObject({ address: player.address, admin: false });

    // The same request makes no second session.
    expect((await browser.call(env, "/api/signin/check", { body: { id } })).body).toEqual({ status: "used" });
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE address = ?").bind(player.address).first<{ n: number }>();
    expect(sessions!.n).toBe(1);
  });

  it("an invalid signature is refused, and signs nobody in", async () => {
    const { browser, id, request } = await begin();
    const message = nanoSigninMessage(request as any, player.address);
    const forger = testAccount();
    // Signed by another key, but claiming the player's address.
    const forged = { ...berryAnswer(request, forger, message), address: player.address };
    const answer = await walletCall(env, `/api/signin/nano/${id}`, forged);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: true, message: "The signature does not match this wallet." });
    expect((await browser.call(env, "/api/signin/check", { body: { id } })).body).toEqual({ status: "waiting" });
    expect((await browser.call(env, "/api/me")).body.address).toBeNull();
  });

  it("a signature over another text (another site's domain) is refused", async () => {
    const { id, request } = await begin();
    const other = nanoSigninMessage({ ...(request as any), domain: "evil.test" }, player.address);
    const answer = await walletCall(env, `/api/signin/nano/${id}`, berryAnswer(request, player, other));
    expect(answer.status).toBe(401);
    expect(answer.body.message).toBe("The signed text is not this sign-in's.");
  });

  it("only the browser that started a request is signed in by it", async () => {
    const { id, request } = await begin();
    await walletCall(env, `/api/signin/nano/${id}`, berryAnswer(request, player, nanoSigninMessage(request as any, player.address)));
    const stranger = new Browser();
    expect((await stranger.call(env, "/api/signin/check", { body: { id } })).body).toEqual({ status: "elsewhere" });
    expect(stranger.jar.size).toBe(0);
  });

  it("refuses a sign-in started from another site (login CSRF)", async () => {
    const r = await new Browser().call(env, "/api/signin/start", { body: {}, origin: "https://evil.test" });
    expect(r.status).toBe(403);
    const noOrigin = await new Browser().call(env, "/api/signin/start", { body: {}, origin: null });
    expect(noOrigin.status).toBe(403);
  });

  it("an expired request is refused", async () => {
    const { id, request } = await begin();
    const late = await walletCall(env, `/api/signin/nano/${id}`, berryAnswer(request, player, nanoSigninMessage(request as any, player.address)), Date.now() + 6 * 60_000);
    expect(late.status).toBe(401);
    expect(late.body.message).toMatch(/expired/);
  });
});
