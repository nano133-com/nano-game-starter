// The game's own friends list (the admin's friends setting "own"): the package's handler (@nano133/nanoterra/friends) on this game's D1
// tables (friend_edges, friend_presence, friend_prefs: migrations/0007_friends.sql), with THIS game's players and its PLAYER sign-in.
//
// A player here is a Nano address: the one the session names (a wallet sign-in, or a sign-in from Nanoterra). A player who came from Nanoterra
// also has a username (the `nanoterra_players` table). The browser never gets a full address from these routes: a row shows the username, or
// else a short address, and an opaque edge id.

import { createFriendsHandler, type PlayerDirectory } from "@nano133/nanoterra/friends";
import { createD1Friends } from "@nano133/nanoterra/friends/d1";
import type { Env } from "./env";
import { memoryLimit } from "./ratelimit";

export const FRIENDS_BASE = "/api/friends";

/** The same short form as the account button (src/client/ui/dom.ts). */
const shortAddress = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

/**
 * An address with or without its "nano_" (or "xrb_") prefix: a whole nano_ address is 65 characters, and the package's handler takes a name of up
 * to 80 (FRIENDS_LIMITS.nameMax, since 0.6.1).
 */
const ADDRESS = /^(?:(?:nano|xrb)_)?([13][13456789abcdefghijkmnopqrstuwxyz]{59})$/;

/** A player of this game: someone who signed in to play (a session of the game's scope), came from Nanoterra, or owns a look. */
async function isPlayer(db: D1Database, address: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM nanoterra_players WHERE address = ?1 UNION ALL SELECT 1 FROM sessions WHERE address = ?1 AND scope = 'play' UNION ALL SELECT 1 FROM owned WHERE player = ?1 LIMIT 1",
    )
    .bind(address)
    .first();
  return Boolean(row);
}

/**
 * The game's players for the friends list. `byName` takes a Nanoterra username (any case: the newest sign-in with that name wins) or the
 * address of a player of this game (see ADDRESS); `names` gives the username, or else a short address.
 */
export function directory(db: D1Database): PlayerDirectory {
  return {
    async byName(name) {
      const text = name.trim();
      const lower = text.toLowerCase();
      const key = ADDRESS.exec(lower)?.[1];
      if (key) {
        const address = `nano_${key}`;
        return (await isPlayer(db, address)) ? address : null;
      }
      const row = await db.prepare("SELECT address FROM nanoterra_players WHERE username = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1").bind(text).first<{ address: string }>();
      return row?.address ?? null;
    },
    async names(ids) {
      const out = new Map<string, string>();
      for (const id of ids) out.set(id, shortAddress(id));
      if (!ids.length) return out;
      // D1 takes at most 100 bound values in one statement; a list holds at most 100 rows (FRIEND_LIMIT).
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        const rows = await db.prepare(`SELECT address, username FROM nanoterra_players WHERE address IN (${part.map(() => "?").join(", ")})`).bind(...part).all<{ address: string; username: string }>();
        for (const r of rows.results) out.set(r.address, r.username);
      }
      return out;
    },
  };
}

/** The store of the friends tables: the routes use it, and so would a "Delete my data" (`store.forget(address)`). */
export const friendsStore = (env: Env) => createD1Friends(env.DB);

/**
 * The routes under /api/friends. `player` is the address of the request's PLAYER session (the `session` cookie), never the admin cookie.
 * The handler checks the origin itself (a POST from the game's own page, no read from another page) and counts 30 calls a minute for each
 * player; this limit also counts per visitor, as the rest of the API does.
 */
export function friendsHandler(env: Env, now: number, ip: string, player: string | null) {
  return createFriendsHandler({
    store: friendsStore(env),
    directory: directory(env.DB),
    player: async () => player,
    base: FRIENDS_BASE,
    limit: (key, limit, windowMs, at) => memoryLimit(key, limit, windowMs, at) && memoryLimit(`friends|${ip}`, limit * 2, windowMs, at),
    now: () => now,
    onError: (e) => console.error("friends failed", e instanceof Error ? e.message : String(e)),
  });
}
