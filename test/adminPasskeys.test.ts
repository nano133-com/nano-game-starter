// The owner's passkeys for /admin (kit 0.12.0, `createAdminSignin({ passkeys: true })`), on the real Worker and its D1 tables. A passkey is only a key to
// /admin: the money stays in the owner's wallet. A link counts only when both sides prove their key (a live WALLET admin login of RECEIVE_ADDRESS, and the
// passkey's own signature of the link text); a linked passkey's signature of the ADMIN text opens /admin; the link is read on every request with the CURRENT
// owner, so Remove or a new RECEIVE_ADDRESS ends the access at the next request; a player's passkey signature (the host alone) never opens /admin.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PASSKEY_LIMIT } from "@nano133/nanoterra/admin-signin";
import { adminSigninStoreConformance } from "@nano133/nanoterra/admin-signin/conformance";
import { createD1AdminSignin } from "@nano133/nanoterra/admin-signin/d1";
import { EXAMPLE_ADDRESS, type Env } from "../src/worker/env";
import { Browser, linkPasskey, ORIGIN, passkeyBody, signedInWith, signedInWithPasskey, testPasskey, walletFrom } from "./api";
import { createSession, makeDb, testAccount } from "./helpers";

let env: Env;
let close: () => Promise<void>;
const owner = testAccount();
const other = testAccount();
beforeAll(async () => {
  const made = await makeDb();
  close = made.close;
  env = { DB: made.db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off" };
});
afterAll(() => close());
let visitors = 0;
beforeEach(async () => {
  // A new visitor for each test: the limits per address are kept in memory (the list, a link: 30 a minute) and in D1 (the starts: 20 in 10 minutes).
  walletFrom.ip = `198.51.100.${10 + (++visitors % 200)}`;
  env.RECEIVE_ADDRESS = owner.address;
  for (const t of ["hits", "sessions", "signin_requests", "admin_logins", "admin_passkeys", "admin_once"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

/** A browser from its own address, so the limits per visitor never decide a case here. */
let browsers = 0;
const browser = () => new Browser(ORIGIN, { "CF-Connecting-IP": `203.0.113.${(++browsers % 250) + 1}` });
/** The owner's WALLET admin login (Berry Wallet, on /api/admin-signin), in a new browser. */
const ownerWallet = () => signedInWith(env, "berry", owner, "admin", browser());
const linkedCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_passkeys").first<{ n: number }>())!.n;
const summary = (b: Browser) => b.call(env, "/api/admin/summary");

describe("a link is written only by the owner's wallet login", () => {
  it("the owner's wallet login links a passkey that signed the link text; the list shows it", async () => {
    const admin = await ownerWallet();
    const pk = testPasskey();
    const r = await linkPasskey(env, admin, pk.seed);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, address: pk.address, limit: ADMIN_PASSKEY_LIMIT, via: "wallet", canChange: true, you: owner.address });
    expect(r.body.passkeys).toEqual([{ address: pk.address, createdAt: expect.any(Number) }]);
    const row = await env.DB.prepare("SELECT owner, address FROM admin_passkeys").first<{ owner: string; address: string }>();
    expect(row).toEqual({ owner: owner.address, address: pk.address });
    // The same passkey again changes nothing.
    const again = await linkPasskey(env, admin, pk.seed);
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe("exists");
    expect(await linkedCount()).toBe(1);
  });

  it("refused with no login, with a player's login (the owner's own), with a passkey's login and with another wallet: nothing is written", async () => {
    const pk = testPasskey();
    expect((await linkPasskey(env, browser(), pk.seed)).status).toBe(401);
    const asPlayer = await signedInWith(env, "berry", owner, "play", browser());
    expect((await linkPasskey(env, asPlayer, pk.seed)).status).toBe(401);
    const otherWallet = await signedInWith(env, "berry", other, "admin", browser()).catch(() => null);
    // Another wallet makes no admin login at all (the sign-in says not_owner); its admin-scope row, written by hand, is refused by the guard.
    expect(otherWallet).toBeNull();
    const forged = browser();
    forged.jar.set("admin", await createSession(env.DB, other.address, Date.now(), "wallet", "admin"));
    const byOther = await linkPasskey(env, forged, pk.seed);
    expect(byOther.status).toBe(403);
    expect(byOther.body.reason).toBe("other_address");
    // A passkey's login (a linked one) cannot add another passkey.
    const first = testPasskey();
    expect((await linkPasskey(env, await ownerWallet(), first.seed)).status).toBe(200);
    const byPasskey = await signedInWithPasskey(env, first.seed, browser());
    const refused = await linkPasskey(env, byPasskey, pk.seed);
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe("wallet_only");
    expect((await env.DB.prepare("SELECT address FROM admin_passkeys").all<{ address: string }>()).results.map((r) => r.address)).toEqual([first.address]);
  });

  it("the owner's wallet login must come with the passkey's OWN signature of the link text: a sign-in text, a player's text or a wrong signature links nothing", async () => {
    const admin = await ownerWallet();
    const pk = testPasskey();
    for (const body of [passkeyBody.admin(pk.seed), passkeyBody.player(pk.seed), { ...passkeyBody.link(pk.seed), address: testPasskey().address }]) {
      const r = await admin.call(env, "/api/admin-signin/passkey/link", { body });
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    }
    expect(await linkedCount()).toBe(0);
  });

  it(`at most ${ADMIN_PASSKEY_LIMIT} passkeys for the owner`, async () => {
    const admin = await ownerWallet();
    for (let i = 0; i < ADMIN_PASSKEY_LIMIT; i++) expect((await linkPasskey(env, admin, testPasskey().seed)).status).toBe(200);
    const full = await linkPasskey(env, admin, testPasskey().seed);
    expect(full.status).toBe(409);
    expect(full.body.reason).toBe("full");
    expect(await linkedCount()).toBe(ADMIN_PASSKEY_LIMIT);
  });
});

describe("a linked passkey opens /admin, and only while its link to the current owner exists", () => {
  it("a linked passkey's ADMIN signature makes an admin login (the admin cookie, one day, via passkey) that opens /api/admin/summary", async () => {
    const pk = testPasskey();
    await linkPasskey(env, await ownerWallet(), pk.seed);
    const b = browser();
    const r = await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(pk.seed) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "signedin", address: pk.address, linkedTo: owner.address });
    expect(b.jar.has("admin")).toBe(true);
    expect(b.jar.has("session")).toBe(false);
    const row = await env.DB.prepare("SELECT address, via, scope, expires_at - created_at AS life FROM sessions WHERE via = 'passkey'").first();
    expect(row).toEqual({ address: pk.address, via: "passkey", scope: "admin", life: 86_400_000 });
    expect((await summary(b)).status).toBe(200);
    // It is no player: the game's own login stays signed out, and /api/me names no admin.
    expect((await b.call(env, "/api/me")).body).toMatchObject({ address: null, admin: false });
    // The list says who it is, and that it may not change the list.
    const list = await b.call(env, "/api/admin-signin/passkeys", { body: {} });
    expect(list.body).toMatchObject({ via: "passkey", canChange: false, you: pk.address });
  });

  it("an unlinked passkey is refused (not_linked) and gets no cookie, and a passkey of another owner's link is refused too", async () => {
    const pk = testPasskey();
    const b = browser();
    const r = await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(pk.seed) });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("not_linked");
    expect(b.jar.has("admin")).toBe(false);
    // A link row of another address (written by hand): it is not this game's owner, so it opens nothing.
    await env.DB.prepare("INSERT INTO admin_passkeys (owner, address, created_at) VALUES (?, ?, ?)").bind(other.address, pk.address, Date.now()).run();
    const again = await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(pk.seed) });
    expect(again.status).toBe(403);
    expect(again.body.reason).toBe("not_linked");
    expect((await summary(b)).status).toBe(401);
  });

  it("each signature counts once: the same ADMIN signature sent again makes no second login", async () => {
    const pk = testPasskey();
    await linkPasskey(env, await ownerWallet(), pk.seed);
    const body = passkeyBody.admin(pk.seed);
    expect((await browser().call(env, "/api/admin-signin/passkey", { body })).status).toBe(200);
    const replay = browser();
    expect((await replay.call(env, "/api/admin-signin/passkey", { body })).status).toBe(409);
    expect(replay.jar.has("admin")).toBe(false);
  });

  it("Remove (by the wallet login) ends the passkey's access at its next request, and deletes its admin logins", async () => {
    const pk = testPasskey();
    const admin = await ownerWallet();
    await linkPasskey(env, admin, pk.seed);
    const b = await signedInWithPasskey(env, pk.seed, browser());
    expect((await summary(b)).status).toBe(200);
    // A passkey's own login cannot remove it.
    const self = await b.call(env, "/api/admin-signin/passkey/unlink", { body: { address: pk.address } });
    expect(self.status).toBe(403);
    expect(self.body.reason).toBe("wallet_only");
    const removed = await admin.call(env, "/api/admin-signin/passkey/unlink", { body: { address: pk.address } });
    expect(removed.body).toMatchObject({ ok: true, removed: true, passkeys: [] });
    expect((await summary(b)).status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE via = 'passkey'").first<{ n: number }>())!.n).toBe(0);
    // And it cannot sign in again; the wallet login stays.
    expect((await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(pk.seed) })).body.reason).toBe("not_linked");
    expect((await summary(admin)).status).toBe(200);
  });

  it("a new owner (RECEIVE_ADDRESS) ends the passkey's access at the next request: its link belongs to the old address", async () => {
    const pk = testPasskey();
    await linkPasskey(env, await ownerWallet(), pk.seed);
    const b = await signedInWithPasskey(env, pk.seed, browser());
    expect((await summary(b)).status).toBe(200);
    env.RECEIVE_ADDRESS = other.address;
    expect((await summary(b)).status).toBe(401);
    expect((await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(pk.seed) })).body.reason).toBe("not_linked");
    // No owner address (the example address, nobody's key): the passkey opens nothing, and its sign-in says why.
    env.RECEIVE_ADDRESS = EXAMPLE_ADDRESS;
    const closed = await summary(b);
    expect(closed.status).toBe(403);
    expect(closed.body.reason).toBe("no_address");
    const none = await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(pk.seed) });
    expect(none.status).toBe(403);
    expect(none.body.reason).toBe("no_address");
    // The old owner's address again: the link was never removed, so the passkey opens /admin again (a link names its owner).
    env.RECEIVE_ADDRESS = owner.address;
    expect((await summary(b)).status).toBe(200);
  });

  it("Sign out everywhere ends the passkey's login and keeps its link", async () => {
    const pk = testPasskey();
    const admin = await ownerWallet();
    await linkPasskey(env, admin, pk.seed);
    const b = await signedInWithPasskey(env, pk.seed, browser());
    expect((await admin.call(env, "/api/admin/signout-all", { method: "POST", body: {} })).status).toBe(200);
    expect((await summary(b)).status).toBe(401);
    expect(await linkedCount()).toBe(1);
    expect((await summary(await signedInWithPasskey(env, pk.seed, browser()))).status).toBe(200);
  });
});

describe("a player's passkey never opens /admin, and the admin's passkey text never makes a player", () => {
  it("the player's signature (the host alone) is refused at the admin route, even for a linked passkey; the same text signs the player in on the game's route", async () => {
    const pk = testPasskey();
    await linkPasskey(env, await ownerWallet(), pk.seed);
    const b = browser();
    const r = await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.player(pk.seed) });
    expect(r.status).toBe(401);
    expect(b.jar.has("admin")).toBe(false);
    expect((await summary(b)).status).toBe(401);
    // A link signature is not a sign-in either.
    expect((await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.link(pk.seed) })).status).toBe(401);
    expect(b.jar.has("admin")).toBe(false);
    // The control: the player's text is a PLAYER sign-in on the game's route, and that login still opens no /admin.
    const asPlayer = await b.call(env, "/api/signin/passkey", { body: passkeyBody.player(pk.seed) });
    expect(asPlayer.body).toMatchObject({ status: "signedin", address: pk.address });
    expect(b.jar.has("session")).toBe(true);
    expect((await summary(b)).status).toBe(401);
  });

  it("the ADMIN text and the link text make no player login on the game's route", async () => {
    const pk = testPasskey();
    await linkPasskey(env, await ownerWallet(), pk.seed);
    const b = browser();
    for (const body of [passkeyBody.admin(pk.seed), passkeyBody.link(pk.seed)]) expect((await b.call(env, "/api/signin/passkey", { body })).status).toBe(401);
    expect(b.jar.has("session")).toBe(false);
    expect((await b.call(env, "/api/me")).body).toMatchObject({ address: null });
  });

  it("the passkey routes are POSTs from the game's own page: another Origin is refused", async () => {
    const pk = testPasskey();
    await linkPasskey(env, await ownerWallet(), pk.seed);
    const b = browser();
    const r = await b.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(pk.seed), origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(b.jar.has("admin")).toBe(false);
  });
});

describe("the kit's admin sign-in store contract, with the passkey cases, on this game's D1 tables (migrations 0001 to 0009)", () => {
  const TABLES = ["signin_requests", "sessions", "admin_logins", "admin_passkeys", "admin_once"];
  const harness = async () => {
    for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
    return {
      store: createD1AdminSignin(env.DB),
      dump: async () => (await Promise.all(TABLES.map(async (t) => JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results)))).join("|"),
    };
  };
  for (const c of adminSigninStoreConformance(harness, { passkeys: true })) it(c.name, c.run);
});
