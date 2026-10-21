// The payment scan: one look at the creator's address settles every held order at once. A player's pay
// screen asks for it every 5 seconds, the admin page on "Check now", and the cron every 10 minutes (for a
// player who paid and closed the page). Node load stays flat however many players pay: the whole game
// makes at most one scan every SCAN_GAP_MS, and none when no order is held.

import { receiveAddress, type Env } from "./env";
import { candidates, checkSend } from "./match";
import { heldOrders, settle, smallestAmount, tidy, type OrderRow } from "./orders";
import { nodesFor, rpc, type NanoNode, type RpcOptions } from "./nodes";

export const SCAN_GAP_MS = 4000;
/** The most entries one RPC read asks for. */
const COUNT = "50";

export type SweepResult = { scanned: boolean; settled: { id: string; status: string }[]; error?: string };

/** A confirmed send never changes: its answer is kept for an hour (in this copy of the Worker). */
const blockCache = new Map<string, { info: Record<string, any>; until: number }>();

async function blockInfo(nodes: NanoNode[], hash: string, o: RpcOptions, now: number) {
  const hit = blockCache.get(hash);
  if (hit && hit.until > now) return hit.info;
  const { answer } = await rpc(nodes, { action: "block_info", hash, json_block: "true" }, o);
  if (answer && (answer.confirmed === "true" || answer.confirmed === true)) {
    if (blockCache.size > 500) blockCache.clear();
    blockCache.set(hash, { info: answer, until: now + 3_600_000 });
  }
  return answer;
}

/** Claims the next scan for this call, so two calls at once never both ask the nodes. */
async function claimScan(db: D1Database, now: number): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO meta (key, value, at) VALUES ('scan', '', ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at WHERE meta.at <= ?")
    .bind(now, now - SCAN_GAP_MS)
    .run();
  return r.meta.changes === 1;
}

export async function sweep(env: Env, opts: { at?: number; rpc?: RpcOptions; nodes?: NanoNode[] } = {}): Promise<SweepResult> {
  const now = opts.at ?? Date.now();
  const o: RpcOptions = opts.rpc ?? {};
  const db = env.DB;
  await tidy(db, now);
  const address = receiveAddress(env);
  if (!address) return { scanned: false, settled: [] };
  const held = await heldOrders(db);
  if (!held.length) return { scanned: false, settled: [] };
  if (!(await claimScan(db, now))) return { scanned: false, settled: [] };

  const nodes = opts.nodes ?? nodesFor(env);
  const settled: SweepResult["settled"] = [];
  try {
    // Only amounts a held order asks for: small sends ("dust") cannot push a payment out of the list.
    const threshold = smallestAmount(held)!;
    const receivable = await rpc(nodes, { action: "receivable", account: address, count: COUNT, threshold, source: "true" }, o);
    // A new address has no history yet: the node answers "Account not found" (null here).
    const history = await rpc(nodes, { action: "account_history", account: address, count: COUNT, raw: "true" }, o);
    const byAmount = new Map<string, OrderRow>(held.map((h) => [h.amount, h]));
    const found = candidates(receivable.answer, history.answer, new Set(byAmount.keys()));
    if (!found.size) return { scanned: true, settled };

    // A payment that already paid (or was recorded for) an order never counts again.
    const hashes = [...found.keys()];
    const used = new Set(
      (await db.prepare(`SELECT hash FROM orders WHERE hash IN (${hashes.map(() => "?").join(", ")})`).bind(...hashes).all<{ hash: string }>()).results.map((r) => r.hash),
    );
    for (const [hash, amount] of found) {
      if (used.has(hash)) continue;
      const order = byAmount.get(amount);
      if (!order) continue;
      const info = await blockInfo(nodes, hash, o, now);
      if (!info) continue;
      const verdict = checkSend(info, address, order.amount, order.created_at);
      if (verdict.kind !== "paid") continue;
      const result = await settle(db, order, { hash, payer: verdict.payer, seenMs: verdict.seenMs }, now);
      if (result === "paid" || result === "paid_late") {
        settled.push({ id: order.id, status: result });
        byAmount.delete(amount);
      }
    }
    return { scanned: true, settled };
  } catch (e) {
    // Fail closed: nothing is credited when the nodes cannot be read. The next scan tries again.
    return { scanned: false, settled, error: e instanceof Error ? e.message : String(e) };
  }
}

/** For tests. */
export function forgetBlocks() {
  blockCache.clear();
}
