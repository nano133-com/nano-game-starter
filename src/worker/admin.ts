// The creator's admin (/admin): the package's handler (@nano133/nanoterra/admin) with THIS game's own admin session, its D1 store and its status.
// Only the creator's own address (RECEIVE_ADDRESS), signed in with a wallet less than ADMIN_SESSION_MS ago, can read or change anything here.
//
// The guard is the package's `adminAccess`: DO NOT copy it back into this file and DO NOT loosen it. What this file must get right is the part that is
// the game's own: the owner (receiveAddress), and the session (adminSession: the admin cookie only). test/adminConformance.test.ts runs
// the package's conformance suite against exactly that chain.

import { createAdminHandler, loadGameSettings, type AdminHandler, type AdminStatus, type Friends, type GameSettings, type StoreSummary } from "@nano133/nanoterra/admin";
import { createD1Store } from "@nano133/nanoterra/admin/d1";
import { CONFIG } from "../shared/config";
import { lookById } from "../shared/looks";
import { githubRepo, receiveAddress, type Env } from "./env";
import { shopOf } from "./player";
import { memoryLimit } from "./ratelimit";
import { ADMIN_SESSION_MS, adminSession } from "./signin";

export { ADMIN_SESSION_MS };

/** What the two switches are until /admin sets them: game.config.json's words. The friends list and the emotes are not named: the package's defaults ("nanoterra", "on") hold until /admin sets them. */
export const gameDefaults = { character: CONFIG.character, signin: CONFIG.signin } as const;

/** The admin's store: this game's D1 tables (meta, orders, owned, and admin_logins for the sign-in list). It writes the "Game" card's settings (character, sign-in, friends list, emotes), and deletes the admin sessions for "Sign out everywhere". */
export const gameStore = (env: Env) => createD1Store(env.DB, { logins: true });

/**
 * The settings now: the "Game" card of /admin (the two switches, the friends list and "Allow Nanoterra emotes"), or game.config.json's words when
 * /admin has set none (the friends list and the emotes: the package's defaults, "nanoterra" and "on"). A database fault gives the defaults: the listing and the game's page must not break
 * because a setting could not be read. This is the ONE place the Worker reads them.
 */
export async function settingsOf(env: Env): Promise<Required<GameSettings>> {
  const { character, signin, friends, emotes } = await loadGameSettings(gameStore(env), gameDefaults);
  return { character, signin, friends, emotes };
}

/** What only this game knows: its address, test mode, the nodes and what is still off (the shop's status), and its own warnings. The counts come from the store. */
function adminStatus(env: Env, s: StoreSummary, friends: Friends): AdminStatus {
  const shop = shopOf(env).status();
  const warnings = [...shop.warnings];
  if (s.counts.paid_late === 1) warnings.push('1 payment came late. Send it back by hand from your wallet (see "Paid late").');
  if (s.counts.paid_late > 1) warnings.push(`${s.counts.paid_late} payments came late. Send each one back by hand from your wallet (see "Paid late").`);
  // Nanoterra's friends window needs the game's id there; until it is set the game draws no Friends key.
  if (friends === "nanoterra" && !CONFIG.nanoterraId) warnings.push('Friends list: add "nanoterraId" to game.config.json (your game\'s id on Nanoterra) after Nanoterra lists your game.');
  return { address: shop.address, testMode: shop.testMode, turnstile: shop.turnstile, nodes: shop.nodes, repo: githubRepo(env), warnings };
}

/** The admin routes (GET summary, GET and POST game, POST check) behind the package's guard. `ip` keeps the limit of presses per visitor, as it always was. */
export function adminHandler(env: Env, now: number, ip: string): AdminHandler {
  return createAdminHandler({
    store: gameStore(env),
    defaults: gameDefaults,
    owner: receiveAddress(env),
    // Only the ADMIN login (its own cookie, made by a wallet signature started from /admin): a login made for the game, even the owner's own, is not one.
    session: (req, at) => adminSession(env.DB, req, at),
    status: async (_at, s) => adminStatus(env, s, (await settingsOf(env)).friends),
    lookName: (id) => lookById(id)?.name,
    check: (at) => shopOf(env, now).scan(at),
    limit: (key, limit, windowMs, at) => memoryLimit(`${key}|${ip}`, limit, windowMs, at),
    now: () => now,
    onError: (e) => console.error("admin failed", e instanceof Error ? e.message : String(e)),
  });
}
