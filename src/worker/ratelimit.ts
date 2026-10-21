// Per-visitor limits. Two layers:
// 1. A counter in this Worker's memory: free and fast, but each Cloudflare location (and each copy of the
//    Worker) counts on its own. It takes the floods first, so they never reach the database.
// 2. A counter in D1 for the calls that matter (sign-in start, a new order): one count for the whole game.
// Cloudflare's Rate Limiting binding was not used: its docs name no plans, and a binding that a Free account
// cannot use would break the Deploy button.

import { sha256Hex, visitorIp } from "./http";

const memory = new Map<string, { count: number; until: number }>();

/** True while `key` has made at most `limit` calls in this window (memory only). */
export function memoryLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const hit = memory.get(key);
  if (!hit || hit.until <= now) {
    if (memory.size > 5000) for (const [k, v] of memory) if (v.until <= now) memory.delete(k);
    memory.set(key, { count: 1, until: now + windowMs });
    return true;
  }
  hit.count += 1;
  return hit.count <= limit;
}

/** True while `key` has made at most `limit` calls in this fixed window (D1, shared by every location). */
export async function d1Limit(db: D1Database, key: string, limit: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const win = Math.floor(now / windowMs);
  const row = await db
    .prepare("INSERT INTO hits (key, win, count) VALUES (?, ?, 1) ON CONFLICT (key, win) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(key, win)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** A random value made once per game and kept in D1: visitors' IP addresses are only stored as keyed hashes. */
export async function salt(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'salt'").first<{ value: string }>();
  if (row) return row.value;
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT OR IGNORE INTO meta (key, value, at) VALUES ('salt', ?, ?)").bind(fresh, Date.now()).run();
  return (await db.prepare("SELECT value FROM meta WHERE key = 'salt'").first<{ value: string }>())!.value;
}

/** The visitor's key: a hash of the salt and the IP address, never the address itself. */
export async function visitorKey(db: D1Database, req: Request): Promise<string> {
  return (await sha256Hex(`${await salt(db)}|${visitorIp(req)}`)).slice(0, 32);
}

/** The limits of each route: calls per window. */
export const LIMITS = {
  /** A sign-in start, per visitor (D1). */
  signinStart: { limit: 20, windowMs: 10 * 60_000 },
  /** A new order, per visitor (D1). */
  order: { limit: 10, windowMs: 10 * 60_000 },
  /** The wallet app's calls (Berry Wallet's GET and POST, Nautilus's answer), per visitor (memory). */
  wallet: { limit: 30, windowMs: 60_000 },
  /**
   * NanChat's answers all come from NanChat's one relay server, so a limit per visitor would be one limit for every
   * NanChat user. Its limits are totals: the whole route (memory), the answers of the right shape (D1), and the
   * tries for one sign-in, by its nonce (D1).
   */
  nanchatRoute: { limit: 120, windowMs: 60_000 },
  nanchatAll: { limit: 600, windowMs: 10 * 60_000 },
  nanchatNonce: { limit: 5, windowMs: 10 * 60_000 },
  /** The browser's checks (sign-in every 2 s, payment every 5 s), per visitor (memory). */
  poll: { limit: 90, windowMs: 60_000 },
  /** Everything else under /api, per visitor (memory). */
  other: { limit: 120, windowMs: 60_000 },
};
