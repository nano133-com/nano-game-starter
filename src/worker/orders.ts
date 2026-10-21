// Orders: the clean amount, its reservation, and the one write that marks an order paid and gives the look.
// DO NOT CHANGE THE MONEY RULES HERE without the tests in test/orders.test.ts and test/sweep.test.ts.
//
// The reservation (the same rule as the Nano Unlock WordPress plugin):
// - An order asks for its price, rounded up to 0.0001 XNO. While another held order has that exact amount,
//   it asks for one step (0.0001 XNO) more, and so on: at most a tenth of the price more, and at most 99 steps.
//   When every step is held, the player is asked to try again in a moment.
// - The column amount_lock is UNIQUE: no two held orders can ever ask for the same amount, so one payment
//   can only match one order. Two orders made at the same instant cannot both take an amount: the database
//   refuses the second, and it moves on to the next step.
// - The amount stays held from the order's start to LATE_HOLD_MS after it expires, so a late payment is still
//   recognised (as "paid late") and never counts for a newer order. A paid order frees its amount at once
//   (its payment's hash is recorded, so that payment never counts again).

import { compareRaw, isClean, plusSteps, STEP_RAW } from "../shared/amount";
import { CLOCK_SLACK_MS } from "./match";

export const ORDER_TTL_MS = 15 * 60_000;
export const LATE_HOLD_MS = 60 * 60_000;
export const MAX_STEPS = 100;
export const MAX_EXTRA_PERCENT = 10;
/** One player can wait on this many orders at once. */
export const MAX_OPEN_PER_PLAYER = 3;

export type OrderStatus = "open" | "paid" | "expired" | "paid_late";

export type OrderRow = {
  id: string;
  player: string;
  look_id: string;
  usd: string;
  rate: number;
  amount: string;
  amount_lock: string | null;
  status: OrderStatus;
  created_at: number;
  expires_at: number;
  hold_until: number;
  hash: string | null;
  payer: string | null;
  paid_at: number | null;
  visitor: string | null;
};

export class Busy extends Error {}

/** How many amounts a price may use: the price and the steps above it. At least 1. */
export function stepsFor(price: string): number {
  const base = BigInt(price) / STEP_RAW;
  return Math.max(1, Math.min(MAX_STEPS, Number((base * BigInt(MAX_EXTRA_PERCENT)) / 100n) + 1));
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");

/** Frees the amounts that no payment can match any more, and marks unpaid orders past their time expired. */
export async function tidy(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE orders SET status = 'expired' WHERE status = 'open' AND expires_at < ?").bind(now),
    db.prepare("UPDATE orders SET amount_lock = NULL WHERE amount_lock IS NOT NULL AND hold_until < ?").bind(now),
  ]);
}

/**
 * Makes an order with the smallest free amount at or above `price` (a clean amount in raw).
 * Throws Busy when every allowed amount is held.
 */
export async function reserve(
  db: D1Database,
  p: { player: string; lookId: string; usd: string; rate: number; price: string; visitor: string | null; now: number; ttlMs?: number },
): Promise<OrderRow> {
  if (!isClean(p.price)) throw new Error("the price must be a clean amount");
  await tidy(db, p.now);
  const amounts = Array.from({ length: stepsFor(p.price) }, (_, k) => plusSteps(p.price, k));
  const held = new Set<string>();
  // Read the held amounts of this price's range first (in chunks: D1 takes at most 100 bound values).
  for (let i = 0; i < amounts.length; i += 90) {
    const chunk = amounts.slice(i, i + 90);
    const rows = await db
      .prepare(`SELECT amount_lock FROM orders WHERE amount_lock IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ amount_lock: string }>();
    for (const r of rows.results) held.add(r.amount_lock);
  }
  const expiresAt = p.now + (p.ttlMs ?? ORDER_TTL_MS);
  for (const amount of amounts) {
    if (held.has(amount)) continue;
    const row: OrderRow = {
      id: newId(),
      player: p.player,
      look_id: p.lookId,
      usd: p.usd,
      rate: p.rate,
      amount,
      amount_lock: amount,
      status: "open",
      created_at: p.now,
      expires_at: expiresAt,
      hold_until: expiresAt + LATE_HOLD_MS,
      hash: null,
      payer: null,
      paid_at: null,
      visitor: p.visitor,
    };
    try {
      await db
        .prepare(
          "INSERT INTO orders (id, player, look_id, usd, rate, amount, amount_lock, status, created_at, expires_at, hold_until, visitor) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
        )
        .bind(row.id, row.player, row.look_id, row.usd, row.rate, row.amount, row.amount_lock, row.created_at, row.expires_at, row.hold_until, row.visitor)
        .run();
      return row;
    } catch (e) {
      // Another order took this amount since the read: go on to the next step. Any other failure stops.
      if (!/UNIQUE/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  }
  throw new Busy("every amount for this price is held");
}

export async function orderById(db: D1Database, id: unknown): Promise<OrderRow | null> {
  if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) return null;
  return db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<OrderRow>();
}

/** The orders whose amount is still held: the only ones a payment can be matched to. */
export async function heldOrders(db: D1Database): Promise<OrderRow[]> {
  return (await db.prepare("SELECT * FROM orders WHERE amount_lock IS NOT NULL").all<OrderRow>()).results;
}

export const smallestAmount = (orders: OrderRow[]) => orders.map((o) => o.amount).sort(compareRaw)[0] ?? null;

export type Settled = "paid" | "paid_late" | "used" | "taken";

/**
 * Records a payment for a held order, exactly once, in ONE transaction (a D1 batch):
 * - sent while the order was open (by the node's time): "paid", and the look is given (once: owned has one
 *   row per player and look, and the grant only happens for this order with this hash);
 * - sent after the order expired, while its amount was still held: "paid_late". No look is given; the admin
 *   page lists it, and the creator sends the money back by hand (the game holds no key).
 * "used": that payment already paid another order. "taken": this order was settled meanwhile.
 */
export async function settle(db: D1Database, order: OrderRow, pay: { hash: string; payer: string; seenMs: number }, now: number): Promise<Settled> {
  const late = pay.seenMs > order.expires_at + CLOCK_SLACK_MS;
  const status: OrderStatus = late ? "paid_late" : "paid";
  try {
    const [update] = await db.batch([
      db
        .prepare("UPDATE orders SET status = ?, hash = ?, payer = ?, paid_at = ?, amount_lock = NULL WHERE id = ? AND status IN ('open', 'expired') AND amount_lock IS NOT NULL")
        .bind(status, pay.hash, pay.payer, pay.seenMs, order.id),
      db
        .prepare("INSERT OR IGNORE INTO owned (player, look_id, order_id, granted_at) SELECT player, look_id, id, ? FROM orders WHERE id = ? AND status = 'paid' AND hash = ?")
        .bind(now, order.id, pay.hash),
    ]);
    return (update?.meta.changes ?? 0) === 1 ? status : "taken";
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) return "used";
    throw e;
  }
}

/** The order as its player sees it. The address and the payment link are left out in test mode. */
export function orderView(o: OrderRow, now: number) {
  const status: OrderStatus = o.status === "open" && o.expires_at < now ? "expired" : o.status;
  return { id: o.id, lookId: o.look_id, usd: o.usd, amount: o.amount, status, createdAt: o.created_at, expiresAt: o.expires_at };
}
