// The creator's admin page data (/admin). Only the creator's own address (RECEIVE_ADDRESS), signed in with
// Nano less than ADMIN_SESSION_MS ago, can read it. Everything here stays in the creator's own database.
// DO NOT LOOSEN THE GUARD.

import { xnoText } from "../shared/amount";
import { lookById } from "../shared/looks";
import { githubRepo, receiveAddress, setting, testMode, turnstileOn, type Env } from "./env";
import { fail } from "./http";
import { nodesFor } from "./nodes";
import type { OrderRow } from "./orders";
import { ADMIN_SESSION_MS, sessionOf } from "./signin";

export { ADMIN_SESSION_MS };

/** Null when the request may read the admin data, else the refusal to send. */
export async function adminGuard(env: Env, req: Request, now = Date.now()): Promise<Response | null> {
  const owner = receiveAddress(env);
  if (!owner) return fail(403, "Set your own Nano address (RECEIVE_ADDRESS) first. Only that address can open this page.", { reason: "no_address" });
  // Only the admin login (its own cookie, made by a wallet signature started from /admin) opens this page: a login made for the game, even
  // the owner's own, does not.
  const session = await sessionOf(env.DB, req, now, "admin");
  if (!session) return fail(401, "Sign in with your Nano address.");
  // A sign-in from Nanoterra names an address but proves no key: only a wallet signature opens the admin page.
  if (session.via !== "wallet") return fail(403, "Sign in with your Nano wallet to open this page.", { reason: "nanoterra" });
  if (session.address !== owner) return fail(403, "Only the game's own address can open this page.", { signedInAs: session.address, reason: "other_address" });
  if (now - session.createdAt > ADMIN_SESSION_MS) return fail(401, "Sign in again: an admin sign-in counts for one day.");
  return null;
}

export async function adminSummary(env: Env, now = Date.now()) {
  const db = env.DB;
  const orders = (await db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500").all<OrderRow>()).results;
  const owned = (await db.prepare("SELECT player, look_id, order_id, granted_at FROM owned ORDER BY player, granted_at").all<{ player: string; look_id: string; order_id: string; granted_at: number }>()).results;
  const sums = (await db.prepare("SELECT status, amount, usd FROM orders WHERE status IN ('paid', 'paid_late')").all<{ status: string; amount: string; usd: string }>()).results;
  const counts = (await db.prepare("SELECT status, expires_at < ? AS past, COUNT(*) AS n FROM orders GROUP BY status, past").bind(now).all<{ status: string; past: number; n: number }>()).results;
  const rate = await db.prepare("SELECT value, at FROM meta WHERE key = 'rate'").first<{ value: string; at: number }>();

  const total = (status: string) => {
    let raw = 0n;
    let cents = 0;
    let n = 0;
    for (const s of sums) {
      if (s.status !== status) continue;
      raw += BigInt(s.amount);
      cents += Math.round(Number(s.usd) * 100);
      n++;
    }
    return { count: n, xno: xnoText(raw.toString()), usd: (cents / 100).toFixed(2) };
  };
  const count = { open: 0, paid: 0, expired: 0, paid_late: 0 };
  for (const c of counts) {
    const key = c.status === "open" && c.past ? "expired" : (c.status as keyof typeof count);
    if (key in count) count[key] += c.n;
  }

  const warnings: string[] = [];
  if (testMode(env)) warnings.push(receiveAddress(env) ? "Test mode is on (TEST_MODE). Pay screens say TEST MODE: DO NOT PAY." : "Test mode: no receive address is set.");
  if (!turnstileOn(env))
    warnings.push(
      setting(env.TURNSTILE_SECRET) || setting(env.TURNSTILE_SITE_KEY)
        ? "Turnstile is OFF: set both TURNSTILE_SITE_KEY and the secret TURNSTILE_SECRET."
        : "Turnstile is OFF: sign-in and orders are not checked for bots. Add a free Turnstile widget (see README).",
    );
  if (!setting(env.NODE_API_KEY)) warnings.push("No NODE_API_KEY: payments are checked on public Nano nodes only, which promise no uptime.");
  if (count.paid_late === 1) warnings.push('1 payment came late. Send it back by hand from your wallet (see "Paid late").');
  if (count.paid_late > 1) warnings.push(`${count.paid_late} payments came late. Send each one back by hand from your wallet (see "Paid late").`);

  const players = new Map<string, { player: string; looks: { id: string; name: string; at: number }[] }>();
  for (const o of owned) {
    const p = players.get(o.player) ?? { player: o.player, looks: [] };
    p.looks.push({ id: o.look_id, name: lookById(o.look_id)?.name ?? o.look_id, at: o.granted_at });
    players.set(o.player, p);
  }

  return {
    address: receiveAddress(env),
    testMode: testMode(env),
    turnstile: turnstileOn(env),
    nodes: nodesFor(env).map((n) => n.name),
    rate: rate ? { ...(JSON.parse(rate.value) as object), at: rate.at } : null,
    repo: githubRepo(env),
    warnings,
    counts: count,
    totals: { paid: total("paid"), paidLate: total("paid_late") },
    orders: orders.map((o) => ({
      id: o.id,
      player: o.player,
      lookId: o.look_id,
      look: lookById(o.look_id)?.name ?? o.look_id,
      usd: o.usd,
      xno: xnoText(o.amount),
      status: o.status === "open" && o.expires_at < now ? "expired" : o.status,
      createdAt: o.created_at,
      expiresAt: o.expires_at,
      paidAt: o.paid_at,
      payer: o.payer,
      hash: o.hash,
    })),
    players: [...players.values()],
  };
}
