// The admin guard (only the creator's own address, signed in, opens /admin) and the test-mode rule (a pay
// screen never offers a payment to an address nobody holds the key for).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXAMPLE_ADDRESS, type Env } from "../src/worker/env";
import { KEYED_NODE, PUBLIC_NODES } from "../src/worker/nodes";
import { createSession } from "../src/worker/signin";
import { Browser, ORIGIN } from "./api";
import { makeDb, testAccount } from "./helpers";

let db: D1Database;
let close: () => Promise<void>;
const owner = testAccount();
const player = testAccount();
beforeAll(async () => ({ db, close } = await makeDb()));
afterAll(() => close());
beforeEach(async () => {
  for (const t of ["orders", "owned", "sessions", "hits", "meta"]) await db.prepare(`DELETE FROM ${t}`).run();
  // A fresh price, so no test asks a real price feed.
  await db.prepare("INSERT INTO meta (key, value, at) VALUES ('rate', ?, ?)").bind(JSON.stringify({ usd: 1, sources: ["test"] }), Date.now()).run();
});

const live = (): Env => ({ DB: db, RECEIVE_ADDRESS: owner.address, TEST_MODE: "off" });
async function signedIn(address: string, ageMs = 0) {
  const b = new Browser();
  b.jar.set("session", await createSession(db, address, Date.now() - ageMs));
  return b;
}

describe("the admin guard", () => {
  it("refuses everyone while no real receive address is set", async () => {
    const env = { DB: db, RECEIVE_ADDRESS: EXAMPLE_ADDRESS, TEST_MODE: "off" };
    const r = await (await signedIn(EXAMPLE_ADDRESS)).call(env, "/api/admin/summary");
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("no_address");
  });

  it("refuses a visitor who is not signed in", async () => {
    expect((await new Browser().call(live(), "/api/admin/summary")).status).toBe(401);
  });

  it("refuses a player signed in with another address", async () => {
    const r = await (await signedIn(player.address)).call(live(), "/api/admin/summary");
    expect(r.status).toBe(403);
    expect(r.body.signedInAs).toBe(player.address);
    expect(r.body.reason).toBe("other_address");
  });

  it("opens for the receive address, signed in", async () => {
    const r = await (await signedIn(owner.address)).call(live(), "/api/admin/summary");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ address: owner.address, testMode: false, counts: { open: 0, paid: 0, expired: 0, paid_late: 0 } });
    expect(r.body.warnings.join(" ")).toMatch(/Turnstile is OFF/);
  });

  it('warns about each optional secret left as "none" or a space, and not once it is set', async () => {
    const admin = await signedIn(owner.address);
    const skipped = await admin.call({ ...live(), NODE_API_KEY: "none", TURNSTILE_SECRET: " ", TURNSTILE_SITE_KEY: "NONE" }, "/api/admin/summary");
    expect(skipped.status).toBe(200);
    expect(skipped.body).toMatchObject({ turnstile: false, nodes: PUBLIC_NODES.map((n) => n.name) });
    expect(skipped.body.warnings.join(" ")).toMatch(/No NODE_API_KEY/);
    expect(skipped.body.warnings.join(" ")).toMatch(/Turnstile is OFF: sign-in and orders are not checked/);

    const half = await admin.call({ ...live(), TURNSTILE_SECRET: "none", TURNSTILE_SITE_KEY: "test-site-not-real" }, "/api/admin/summary");
    expect(half.body.warnings.join(" ")).toMatch(/Turnstile is OFF: set both/);

    const set = { ...live(), NODE_API_KEY: "test-key-not-real", TURNSTILE_SECRET: "test-secret-not-real", TURNSTILE_SITE_KEY: "test-site-not-real" };
    const all = await admin.call(set, "/api/admin/summary");
    expect(all.body).toMatchObject({ turnstile: true, nodes: [KEYED_NODE.name, ...PUBLIC_NODES.map((n) => n.name)] });
    expect(all.body.warnings.join(" ")).not.toMatch(/NODE_API_KEY|Turnstile/);
    expect((await new Browser().call(set, "/api/config")).body.turnstileSiteKey).toBe("test-site-not-real");
    expect((await new Browser().call({ ...set, TURNSTILE_SITE_KEY: "none" }, "/api/config")).body.turnstileSiteKey).toBeNull();
  });

  it("asks the creator to sign in again after a day", async () => {
    const r = await (await signedIn(owner.address, 25 * 60 * 60_000)).call(live(), "/api/admin/summary");
    expect(r.status).toBe(401);
  });

  it("refuses an admin call sent from another site", async () => {
    const r = await (await signedIn(owner.address)).call(live(), "/api/admin/check", { body: {}, origin: "https://evil.test" });
    expect(r.status).toBe(403);
  });

  it("never shows one player's order to another", async () => {
    const buyer = await signedIn(player.address);
    const made = await buyer.call(live(), "/api/orders", { body: { lookId: "sunset" } });
    expect(made.status).toBe(201);
    const other = await signedIn(testAccount().address);
    expect((await other.call(live(), `/api/orders/${made.body.id}`)).status).toBe(404);
    expect((await buyer.call(live(), `/api/orders/${made.body.id}`)).status).toBe(200);
  });
});

describe("test mode", () => {
  it("with the example address, a pay screen gets no address and no payment link", async () => {
    const env = { DB: db, RECEIVE_ADDRESS: EXAMPLE_ADDRESS, TEST_MODE: "off" };
    const r = await (await signedIn(player.address)).call(env, "/api/orders", { body: { lookId: "sunset" } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ test: true, xno: "0.25" });
    expect(r.body.address).toBeUndefined();
    expect(r.body.uri).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("nano:");
  });

  it("TEST_MODE on keeps test mode with a real address", async () => {
    const r = await (await signedIn(player.address)).call({ ...live(), TEST_MODE: "on" }, "/api/orders", { body: { lookId: "sunset" } });
    expect(r.body.test).toBe(true);
    expect(r.body.uri).toBeUndefined();
  });

  it("live mode gives the creator's address and the exact amount in the link", async () => {
    const r = await (await signedIn(player.address)).call(live(), "/api/orders", { body: { lookId: "sunset" } });
    expect(r.body).toMatchObject({ test: false, address: owner.address, uri: `nano:${owner.address}?amount=250000000000000000000000000000` });
  });

  it("the listing names the creator's address only when it is real, and never lists looks or prices", async () => {
    const { listing } = await import("../src/worker/index");
    const req = new Request(`${ORIGIN}/nano-game.json`);
    expect(listing({ DB: db, RECEIVE_ADDRESS: EXAMPLE_ADDRESS }, req).creator.nano).toBeNull();
    const l = listing(live(), req);
    expect(l).toMatchObject({ nanoGame: 1, play: `${ORIGIN}/`, creator: { nano: owner.address }, multiplayer: false, regions: ["Global"], ages: "18+" });
    expect(JSON.stringify(l)).not.toMatch(/price|usd|look/i);
  });
});
