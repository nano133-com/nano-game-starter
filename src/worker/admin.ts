// The creator's admin (/admin): the package's handler (@nano133/nanoterra/admin) with THIS game's own admin session, its D1 store and its status.
// Only the creator's own address (RECEIVE_ADDRESS), signed in with a wallet less than ADMIN_SESSION_MS ago, can read or change anything here.
//
// The guard is the package's `adminAccess`: DO NOT copy it back into this file and DO NOT loosen it. What this file must get right is the part that is
// the game's own: the owner (receiveAddress), and the session (sessionOf with the "admin" scope, the admin cookie only). test/adminConformance.test.ts runs
// the package's conformance suite against exactly that chain.

import { createAdminHandler, type AdminHandler, type AdminStatus, type StoreSummary } from "@nano133/nanoterra/admin";
import { createD1Store } from "@nano133/nanoterra/admin/d1";
import { CONFIG } from "../shared/config";
import { lookById } from "../shared/looks";
import { githubRepo, receiveAddress, setting, testMode, turnstileOn, type Env } from "./env";
import { memoryLimit } from "./ratelimit";
import { nodesFor } from "./nodes";
import { ADMIN_SESSION_MS, sessionOf } from "./signin";
import { sweep } from "./sweep";

export { ADMIN_SESSION_MS };

/** What the two switches are until /admin sets them: game.config.json's words. */
export const gameDefaults = { character: CONFIG.character, signin: CONFIG.signin } as const;

/** The admin's store: this game's D1 tables (meta, orders, owned). The only thing it writes is the two settings. */
export const gameStore = (env: Env) => createD1Store(env.DB);

/** What only this game knows: its address, test mode and what is still off. The counts come from the store. */
function adminStatus(env: Env, s: StoreSummary): AdminStatus {
  const warnings: string[] = [];
  if (testMode(env)) warnings.push(receiveAddress(env) ? "Test mode is on (TEST_MODE). Pay screens say TEST MODE: DO NOT PAY." : "Test mode: no receive address is set.");
  if (!turnstileOn(env))
    warnings.push(
      setting(env.TURNSTILE_SECRET) || setting(env.TURNSTILE_SITE_KEY)
        ? "Turnstile is OFF: set both TURNSTILE_SITE_KEY and the secret TURNSTILE_SECRET."
        : "Turnstile is OFF: sign-in and orders are not checked for bots. Add a free Turnstile widget (see README).",
    );
  if (!setting(env.NODE_API_KEY)) warnings.push("No NODE_API_KEY: payments are checked on public Nano nodes only, which promise no uptime.");
  if (s.counts.paid_late === 1) warnings.push('1 payment came late. Send it back by hand from your wallet (see "Paid late").');
  if (s.counts.paid_late > 1) warnings.push(`${s.counts.paid_late} payments came late. Send each one back by hand from your wallet (see "Paid late").`);
  return {
    address: receiveAddress(env),
    testMode: testMode(env),
    turnstile: turnstileOn(env),
    nodes: nodesFor(env).map((n) => n.name),
    repo: githubRepo(env),
    warnings,
  };
}

/** The admin routes (GET summary, GET and POST game, POST check) behind the package's guard. `ip` keeps the limit of presses per visitor, as it always was. */
export function adminHandler(env: Env, now: number, ip: string): AdminHandler {
  return createAdminHandler({
    store: gameStore(env),
    defaults: gameDefaults,
    owner: receiveAddress(env),
    // Only the ADMIN login (its own cookie, made by a wallet signature started from /admin): a login made for the game, even the owner's own, is not one.
    session: (req, at) => sessionOf(env.DB, req, at, "admin"),
    status: (_at, s) => adminStatus(env, s),
    lookName: (id) => lookById(id)?.name,
    check: (at) => sweep(env, { at }),
    limit: (key, limit, windowMs, at) => memoryLimit(`${key}|${ip}`, limit, windowMs, at),
    now: () => now,
    onError: (e) => console.error("admin failed", e instanceof Error ? e.message : String(e)),
  });
}
