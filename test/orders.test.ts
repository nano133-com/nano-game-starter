import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { priceRaw, xnoText } from "../src/shared/amount";
import { Busy, LATE_HOLD_MS, MAX_STEPS, ORDER_TTL_MS, heldOrders, reserve, settle, stepsFor } from "../src/worker/orders";
import { hash64, makeDb, testAccount } from "./helpers";

let db: D1Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await makeDb()));
afterAll(() => close());
beforeEach(async () => {
  await db.prepare("DELETE FROM orders").run();
  await db.prepare("DELETE FROM owned").run();
});

const T0 = 1_800_000_000_000;
const price = priceRaw(0.25, 1)!; // 0.25 XNO
const order = (now = T0, player = testAccount().address, p = price) => reserve(db, { player, lookId: "sunset", usd: "0.25", rate: 1, price: p, visitor: null, now });

describe("the reservation", () => {
  it("gives two open orders of the same price two different amounts, one step apart", async () => {
    const a = await order();
    const b = await order();
    expect(xnoText(a.amount)).toBe("0.25");
    expect(xnoText(b.amount)).toBe("0.2501");
  });

  it("never gives two held orders the same amount, even when they are made at the same instant", async () => {
    const made = await Promise.all(Array.from({ length: 25 }, () => order()));
    const amounts = made.map((o) => o.amount);
    expect(new Set(amounts).size).toBe(25);
    const held = await heldOrders(db);
    expect(new Set(held.map((h) => h.amount_lock)).size).toBe(held.length);
  });

  it("frees an amount when its hold ends after the expiry, and not before", async () => {
    const a = await order(T0);
    expect(a.expires_at).toBe(T0 + ORDER_TTL_MS);
    // Expired, but a late payment may still come: the amount stays held.
    const b = await order(a.expires_at + 1000);
    expect(b.amount).not.toBe(a.amount);
    // After the hold, the amount is free again.
    const c = await order(a.hold_until + 1);
    expect(c.amount).toBe(a.amount);
    const status = await db.prepare("SELECT status, amount_lock FROM orders WHERE id = ?").bind(a.id).first<{ status: string; amount_lock: string | null }>();
    expect(status).toEqual({ status: "expired", amount_lock: null });
    expect(a.hold_until - a.expires_at).toBe(LATE_HOLD_MS);
  });

  it("frees a paid order's amount at once", async () => {
    const a = await order();
    expect(await settle(db, a, { hash: hash64(), payer: testAccount().address, seenMs: T0 + 1000 }, T0 + 2000)).toBe("paid");
    const b = await order(T0 + 3000);
    expect(b.amount).toBe(a.amount);
  });

  it("asks at most a tenth of the price more, then says busy", async () => {
    // 0.0030 XNO: 30 steps, so 30 * 10% = 3 extra steps: 4 amounts in all.
    const small = priceRaw(0.003, 1)!;
    expect(stepsFor(small)).toBe(4);
    for (let i = 0; i < 4; i++) await order(T0, undefined, small);
    await expect(order(T0, undefined, small)).rejects.toBeInstanceOf(Busy);
    expect(stepsFor(priceRaw(100, 1)!)).toBe(MAX_STEPS);
    expect(stepsFor(priceRaw(0.0001, 1)!)).toBe(1);
  });
});
