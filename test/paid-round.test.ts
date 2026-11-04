// test/paid-round.test.ts: a pretend payment, in a test only. No real node, no real money, no screen.
import assert from "node:assert/strict";
import { afterAll as after, beforeAll as before, test } from "vitest";
import looks from "../looks.json";
import { SCAN_GAP_MS, createMemoryShop, createShopHandler } from "@nano133/nanoterra/shop";
import { MockNode, hash64, testAccount } from "./helpers.js";
const testAddress = () => testAccount().address;   // the starter's test helpers

const payee = testAddress();        // nobody holds its key
const node = new MockNode();
before(() => node.start());
after(() => node.stop());

test("a paid play order gives the player one round", async () => {
  let clock = Date.now();
  const shop = createShopHandler({
    store: createMemoryShop(),
    catalogue: looks,               // your looks.json
    plays: [{ id: "extra-round", name: "Extra round", priceUsd: 0.05, use: "round" }],
    legal: () => ({ adultsOnly: false, sellLives: false, refundDays: 14, refundWords: "Ask within {days} days.", lawsConfirmedAt: 1 }),
    payee,
    player: async (req) => req.headers.get("X-Test-Player"),
    nodes: [{ name: "mock", url: node.url }],
    rate: { feeds: [{ name: "Test feed", url: "https://feed.test/", read: (j) => j.usd }], fetch: async () => Response.json({ usd: 1 }) },
    now: () => clock,
  });
  const post = (path: string, body: unknown) =>
    shop.handle(new Request(`https://game.test${path}`, { method: "POST", headers: { Origin: "https://game.test", "X-Test-Player": "p1", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const order = await (await post("/api/orders", { playId: "extra-round" }))!.json();
  node.sends.push({ hash: hash64(), from: testAddress(), to: payee, amount: order.amount, seenMs: clock + 1000, confirmed: true });
  clock += SCAN_GAP_MS + 1;                                   // the scan runs at most once a gap
  assert.equal((await (await post(`/api/orders/${order.id}/check`, {}))!.json()).status, "paid");
  assert.deepEqual(await shop.ready("p1"), [{ playId: "extra-round", ready: 1 }]);
  assert.deepEqual(await (await post("/api/plays/use", { playId: "extra-round", ref: "round-1" }))!.json(), { used: true, again: false });
});
