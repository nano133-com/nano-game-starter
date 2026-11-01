// The PLAYER's sign-in and the shop. Both are the package's (@nano133/nanoterra, paths /player-signin and /shop), on this game's own D1 tables
// and settings; this file only gives them what is this game's: the database, the creator's address, the limits, the person check and the looks.
//
// The player's sign-in shares its paths with the ADMIN's sign-in (src/worker/signin.ts): `sharedPaths` leaves every call of the admin (`scope:
// "admin"` in the body, or a wallet's call for a request that the player store does not hold) to the admin's code. A player is a Nano address,
// whichever way they signed in (a passkey, a wallet app, or Nanoterra): the shop, /api/me and the friends list read it with `signin.player()` or
// `signin.session()`, never from a body and never from the admin cookie.

import { createPlayerSignin, type PlayerSignin } from "@nano133/nanoterra/player-signin";
import { createD1PlayerSignin } from "@nano133/nanoterra/player-signin/d1";
import { d1Limit, visitorKey } from "@nano133/nanoterra/shop/d1";
import { createShop, turnstileCheck, type Shop } from "@nano133/nanoterra/shop/worker";
import looks from "../../looks.json" with { type: "json" };
import { receiveAddress, type Env } from "./env";

/** The player's sign-in: the passkey and the three wallet apps, on /api/signin and /api/signout, with the session cookie `session`. */
export function playerSignin(env: Env, now = Date.now()): PlayerSignin {
  return createPlayerSignin({
    store: createD1PlayerSignin(env.DB),
    // Nautilus only NAMES this address in its request: no key, no payment. The example address while none is set.
    siteAddress: receiveAddress(env),
    sharedPaths: true,
    // One count for the whole game, in D1 (`hits`), on a keyed hash of the IP address: the rows the game counted in before.
    limit: (key, limit, windowMs, at) => d1Limit(env.DB, key, limit, windowMs, at),
    visitor: (req) => visitorKey(env.DB, req),
    personCheck: (token, req) => turnstileCheck(env, token, req.headers.get("CF-Connecting-IP")),
    now: () => now,
    onError: (e) => console.error("sign-in failed", e instanceof Error ? e.message : String(e)),
  });
}

/**
 * The shop: the order routes under /api/orders, the payment scan, and what the page and the admin need to know. It reads RECEIVE_ADDRESS,
 * TEST_MODE, NODE_API_KEY, NANO_NODES and the Turnstile keys itself. `player` is the PLAYER's sign-in (none for the cron and the admin's check).
 */
export function shopOf(env: Env, now = Date.now(), player: (req: Request) => Promise<string | null> = async () => null): Shop {
  return createShop(env, {
    catalogue: looks,
    player,
    now: () => now,
    onError: (e) => console.error("shop failed", e instanceof Error ? e.message : String(e)),
  });
}
