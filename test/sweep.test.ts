// The payment match against a mock Nano node: the exact amount, after the order time, exactly once, and
// late payments. No real network: the node runs on 127.0.0.1 in this test.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { priceRaw } from "../src/shared/amount";
import type { Env } from "../src/worker/env";
import { candidates, checkSend, CLOCK_SLACK_MS } from "../src/worker/match";
import { forgetNodeHealth } from "../src/worker/nodes";
import { orderById, reserve, settle, type OrderRow } from "../src/worker/orders";
import { forgetBlocks, SCAN_GAP_MS, sweep } from "../src/worker/sweep";
import { hash64, makeDb, MockNode, testAccount } from "./helpers";

let db: D1Database;
let close: () => Promise<void>;
const node = new MockNode();
const creator = testAccount();
const buyer = testAccount();
let env: Env;
let clock = 1_800_000_000_000;

beforeAll(async () => {
  ({ db, close } = await makeDb());
  await node.start();
  env = { DB: db, RECEIVE_ADDRESS: creator.address, TEST_MODE: "off" };
});
afterAll(async () => {
  await node.stop();
  await close();
});
beforeEach(async () => {
  for (const t of ["orders", "owned", "meta"]) await db.prepare(`DELETE FROM ${t}`).run();
  node.sends = [];
  node.mode = "ok";
  forgetNodeHealth();
  forgetBlocks();
  clock += 3_600_000 * 10;
});

const price = priceRaw(0.25, 1)!;
const newOrder = (player = buyer.address, lookId = "sunset") => reserve(db, { player, lookId, usd: "0.25", rate: 1, price, visitor: null, now: clock });
/** One scan, a little later each time (the scan gap). */
const scan = () => {
  clock += SCAN_GAP_MS + 1;
  return sweep(env, { at: clock, nodes: [{ name: "mock", url: node.url }], rpc: { timeoutMs: 1000 } });
};
const pay = (o: OrderRow, extra: Partial<(typeof node.sends)[number]> = {}) => {
  const s = { hash: hash64(), from: buyer.address, to: creator.address, amount: o.amount, seenMs: clock + 1000, confirmed: true, ...extra };
  node.sends.push(s);
  return s;
};
const owned = async () => (await db.prepare("SELECT player, look_id, order_id FROM owned").all()).results;

describe("the payment match", () => {
  it("an exact payment after the order pays it and gives the look", async () => {
    const o = await newOrder();
    const s = pay(o);
    const r = await scan();
    expect(r.settled).toEqual([{ id: o.id, status: "paid" }]);
    const after = await orderById(db, o.id);
    expect(after).toMatchObject({ status: "paid", hash: s.hash, payer: buyer.address, amount_lock: null });
    expect(await owned()).toEqual([{ player: buyer.address, look_id: "sunset", order_id: o.id }]);
  });

  it("a payment of another amount, to another address, or not a send, pays nothing", async () => {
    const o = await newOrder();
    pay(o, { amount: (BigInt(o.amount) + 1n).toString() }); // one raw more
    pay(o, { amount: (BigInt(o.amount) - 10n ** 26n).toString() }); // one step less
    pay(o, { to: testAccount().address }); // someone else's address
    await scan();
    expect((await orderById(db, o.id))!.status).toBe("open");
    expect(await owned()).toEqual([]);
    // The node's block says "send" to the right address only for the right block.
    expect(checkSend({ subtype: "receive", amount: o.amount, contents: { link_as_account: creator.address }, local_timestamp: "2000000000", confirmed: "true" }, creator.address, o.amount, 0).kind).toBe("wrong");
  });

  it("a payment the node saw before the order (less the clock allowance) never counts", async () => {
    const o = await newOrder();
    pay(o, { seenMs: o.created_at - CLOCK_SLACK_MS - 1000 });
    await scan();
    expect((await orderById(db, o.id))!.status).toBe("open");
    // A send with no time at all never counts either.
    expect(checkSend({ subtype: "send", amount: o.amount, contents: { link_as_account: creator.address }, local_timestamp: "0", confirmed: "true" }, creator.address, o.amount, o.created_at).kind).toBe("early");
  });

  it("an unconfirmed payment waits, and counts once it is confirmed", async () => {
    const o = await newOrder();
    const s = pay(o, { confirmed: false });
    await scan();
    expect((await orderById(db, o.id))!.status).toBe("open");
    s.confirmed = true;
    await scan();
    expect((await orderById(db, o.id))!.status).toBe("paid");
  });

  it("finds a payment the creator's wallet already received (the history)", async () => {
    const o = await newOrder();
    pay(o, { received: true });
    await scan();
    expect((await orderById(db, o.id))!.status).toBe("paid");
  });

  it("exactly once: more scans and a second settle give nothing more", async () => {
    const o = await newOrder();
    const s = pay(o);
    await scan();
    await scan();
    await scan();
    expect(await owned()).toHaveLength(1);
    expect(await settle(db, o, { hash: s.hash, payer: buyer.address, seenMs: s.seenMs }, clock)).toBe("taken");
    expect(await owned()).toHaveLength(1);
  });

  it("one payment never pays a second order, even one that gets the same amount later", async () => {
    const first = await newOrder();
    pay(first);
    await scan();
    // The amount is free again, and the next order of this price asks for it: the old payment is still in
    // the node's list, but its hash is recorded, so it never counts again.
    const second = await newOrder(testAccount().address);
    expect(second.amount).toBe(first.amount);
    await scan();
    expect((await orderById(db, second.id))!.status).toBe("open");
    // And settle refuses a hash that paid another order, in the same transaction.
    const hash = (await orderById(db, first.id))!.hash!;
    expect(await settle(db, second, { hash, payer: buyer.address, seenMs: clock }, clock)).toBe("used");
    expect((await orderById(db, second.id))!.status).toBe("open");
  });

  it("two scans at the same instant ask the node once", async () => {
    await newOrder();
    clock += SCAN_GAP_MS + 1;
    node.calls = [];
    const both = await Promise.all([1, 2].map(() => sweep(env, { at: clock, nodes: [{ name: "mock", url: node.url }] })));
    expect(both.filter((b) => b.scanned)).toHaveLength(1);
    expect(node.calls.filter((c) => c.action === "receivable")).toHaveLength(1);
  });
});

describe("late payments", () => {
  it("a payment after the expiry is recorded as paid late, and gives no look", async () => {
    const o = await newOrder();
    clock = o.expires_at + 10 * 60_000; // 10 minutes after the order ended
    const s = pay(o, { seenMs: clock - 1000 });
    const r = await scan();
    expect(r.settled).toEqual([{ id: o.id, status: "paid_late" }]);
    expect(await orderById(db, o.id)).toMatchObject({ status: "paid_late", hash: s.hash, amount_lock: null });
    expect(await owned()).toEqual([]);
  });

  it("a payment sent in time but found after the expiry still pays the order", async () => {
    const o = await newOrder();
    pay(o, { seenMs: o.expires_at - 30_000 });
    clock = o.expires_at + 20 * 60_000; // the player closed the page; the cron finds it later
    await scan();
    expect((await orderById(db, o.id))!.status).toBe("paid");
    expect(await owned()).toHaveLength(1);
  });

  it("after the hold ends, nothing is matched to the old order any more", async () => {
    const o = await newOrder();
    clock = o.hold_until + 60_000;
    pay(o, { seenMs: clock - 1000 });
    const r = await scan();
    expect(r.scanned).toBe(false); // no held order: the node is not even asked
    expect((await orderById(db, o.id))!.status).toBe("expired");
  });
});

describe("when the node fails", () => {
  it("fails closed: nothing is credited, and the next scan tries again", async () => {
    const o = await newOrder();
    pay(o);
    node.mode = "down";
    const r = await scan();
    expect(r.error).toMatch(/no Nano node answered/);
    expect((await orderById(db, o.id))!.status).toBe("open");
    node.mode = "ok";
    forgetNodeHealth();
    await scan();
    expect((await orderById(db, o.id))!.status).toBe("paid");
  });

  it("reads both answer forms of receivable", () => {
    const amounts = new Set(["100"]);
    const h = "A".repeat(64);
    expect([...candidates({ blocks: { [h]: "100" } }, null, amounts)]).toEqual([[h, "100"]]);
    expect([...candidates({ blocks: { [h]: { amount: "100", source: "nano_x" } } }, null, amounts)]).toEqual([[h, "100"]]);
    expect([...candidates({ blocks: "" }, { history: "" }, amounts)]).toEqual([]);
    expect([...candidates({ blocks: { "not-a-hash": "100" } }, null, amounts)]).toEqual([]);
  });
});
