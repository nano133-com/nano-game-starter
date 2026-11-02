// Per-visitor limits. Two layers:
// 1. A counter in this Worker's memory: free and fast, but each Cloudflare location (and each copy of the
//    Worker) counts on its own. It takes the floods first, so they never reach the database.
// 2. A counter in D1 for the calls that matter (sign-in start, a new order): one count for the whole game. It is the package's
//    (`d1Limit` and `visitorKey` from @nano133/nanoterra/shop/d1: the table `hits`, and the salt in `meta`); the shop and the
//    two sign-ins count there with their own limits (SHOP_LIMITS, PLAYER_SIGNIN_LIMITS, ADMIN_SIGNIN_LIMITS: the numbers this game always had).
// Cloudflare's Rate Limiting binding was not used: its docs name no plans, and a binding that a Free account
// cannot use would break the Deploy button.

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

/**
 * The limits of this game's own routes: calls per window. (The two sign-ins keep their own: the player's PLAYER_SIGNIN_LIMITS and the admin's
 * ADMIN_SIGNIN_LIMITS, the numbers this game always had: 20 starts in 10 minutes per visitor in D1, one count for both; the wallet apps' calls 30 a minute.)
 */
export const LIMITS = {
  /** The browser's checks (sign-in every 2 s, payment every 5 s), per visitor (memory). */
  poll: { limit: 90, windowMs: 60_000 },
  /** Everything else under /api, per visitor (memory). */
  other: { limit: 120, windowMs: 60_000 },
};
