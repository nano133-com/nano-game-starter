// The creator's admin (/admin): the package's handler (@nano133/nanoterra/admin) and the package's admin sign-in (@nano133/nanoterra/admin-signin, on its one
// fixed route /api/admin-signin), on THIS game's own D1 tables and status. Only the creator's own address (RECEIVE_ADDRESS), signed in with a wallet
// (or with a passkey that this wallet linked) less than ADMIN_SESSION_MS ago, can read or change anything here.
//
// The guard is the package's `adminAccess`, and the sign-in that makes admin logins is the package's too: DO NOT copy either back into this file and DO NOT
// loosen them. What this file must get right is the part that is the game's own: the owner (receiveAddress), the session (the admin sign-in's: the admin
// cookie only), the limits and the person check. test/adminConformance.test.ts runs the package's conformance suites against exactly that chain.

import { createAdminHandler, loadGameSettings, type AdminHandler, type AdminStatus, type AdminStore, type Friends, type GameSettings, type StoreSummary } from "@nano133/nanoterra/admin";
import { createD1Store } from "@nano133/nanoterra/admin/d1";
import { ADMIN_SESSION_MS, createAdminSignin, type AdminSignin } from "@nano133/nanoterra/admin-signin";
import { createD1AdminSignin } from "@nano133/nanoterra/admin-signin/d1";
import { d1Limit, visitorKey } from "@nano133/nanoterra/shop/d1";
import { turnstileCheck } from "@nano133/nanoterra/shop/worker";
import { CONFIG } from "../shared/config";
import { lookById } from "../shared/looks";
import { githubRepo, receiveAddress, type Env } from "./env";
import { shopOf } from "./player";
import { memoryLimit } from "./ratelimit";

export { ADMIN_SESSION_MS };

/**
 * The ADMIN's sign-in (the package's): Berry Wallet or Nautilus on /api/admin-signin (`/start`, `/nano/:id`, `/nautilus?id=`, `/check`, `/signout`), with the
 * admin cookie `admin` (one day). It works on this game's own tables (`signin_requests` and `sessions` with scope 'admin', and `admin_logins`): no migration,
 * and an admin who was signed in before it stays signed in. Only RECEIVE_ADDRESS makes an admin login (null while none is set: then nobody does).
 * NanChat stays off (the package's default): its text cannot name the admin. The starts count with the player's in D1 (`signin|<visitor>`: 20 in 10
 * minutes), after the person check (Turnstile, when the game has its keys).
 *
 * The owner's passkeys are on (`passkeys: true`, kit 0.12.0; the tables of migrations/0009_admin_passkeys.sql): `/passkey/link` and `/passkey/unlink`
 * need a live WALLET admin login of RECEIVE_ADDRESS, and a linked passkey's own signature of "ADMIN of <host>: sign in as ..." makes an admin login
 * (`via: "passkey"`) at `/passkey`. `session()` reads the link on every request with the CURRENT owner: a removed link or a new RECEIVE_ADDRESS ends
 * that login at the next request. A player's passkey signature (it names the host alone) never opens /admin. A passkey cannot move money.
 */
export function adminSigninOf(env: Env, now = Date.now()): AdminSignin {
  return createAdminSignin({
    store: createD1AdminSignin(env.DB),
    owner: receiveAddress(env),
    limit: (key, limit, windowMs, at) => d1Limit(env.DB, key, limit, windowMs, at),
    visitor: (req) => visitorKey(env.DB, req),
    personCheck: (token, req) => turnstileCheck(env, token, req.headers.get("CF-Connecting-IP")),
    passkeys: true,
    now: () => now,
    onError: (e) => console.error("admin sign-in failed", e instanceof Error ? e.message : String(e)),
  });
}

/** What the two switches are until /admin sets them: game.config.json's words. The friends list and the emotes are not named: the package's defaults ("nanoterra", "on") hold until /admin sets them. */
export const gameDefaults = { character: CONFIG.character, signin: CONFIG.signin } as const;

/**
 * The admin's store: this game's D1 tables (meta, orders, owned). It writes the "Game" card's settings (character, sign-in, friends list, emotes). The sign-in
 * list (`recentLogins`, the table admin_logins) and "Sign out everywhere" (`signOutEverywhere`: it deletes every admin session and no player's, and ends every
 * admin request that was not delivered) are the admin sign-in's own, on the same tables.
 */
export function gameStore(env: Env): AdminStore {
  const signin = createD1AdminSignin(env.DB);
  return { ...createD1Store(env.DB), recentLogins: (limit) => signin.recentLogins(limit), signOutEverywhere: () => signin.signOutEverywhere() };
}

/**
 * The settings now: the "Game" card of /admin (the two switches, the friends list, "Allow Nanoterra emotes" and "Free play"), or game.config.json's words when
 * /admin has set none (the friends list and the emotes: the package's defaults, "nanoterra" and "on"). A database fault gives the defaults: the listing and the game's page must not break
 * because a setting could not be read. This is the ONE place the Worker reads them.
 */
export async function settingsOf(env: Env): Promise<Required<GameSettings>> {
  const { character, signin, friends, emotes, freePlay } = await loadGameSettings(gameStore(env), gameDefaults);
  return { character, signin, friends, emotes, freePlay };
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
    // Only the ADMIN login (its own cookie, made by a wallet signature started from /admin, or by a passkey the owner's wallet linked): a login made for
    // the game, even the owner's own, is not one.
    session: (req, at) => adminSigninOf(env, now).session(req, at),
    status: async (_at, s) => adminStatus(env, s, (await settingsOf(env)).friends),
    lookName: (id) => lookById(id)?.name,
    check: (at) => shopOf(env, now).scan(at),
    limit: (key, limit, windowMs, at) => memoryLimit(`${key}|${ip}`, limit, windowMs, at),
    now: () => now,
    onError: (e) => console.error("admin failed", e instanceof Error ? e.message : String(e)),
  });
}
