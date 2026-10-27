// The two game switches of /admin ("Game" card; src/shared/gameSwitches.ts): which character the players are and whether they can sign in
// with Nanoterra. They live in the `meta` table (two rows, keys with the prefix `setting:` so they never meet the price or the salt) and the Worker
// reads them at run time, so a creator changes them in /admin with no push and no deploy. With no row a switch has the value that
// game.config.json gives (its default). Only the admin routes write them (index.ts, behind adminGuard).

import { CONFIG } from "../shared/config";
import { isCharacter, isSigninChoice, type GamePatch, type GameSettings } from "../shared/gameSwitches";

const CHARACTER_KEY = "setting:character";
const SIGNIN_KEY = "setting:signin";

/** The settings as they are now: a row from /admin where there is one, else game.config.json's word. `fromAdmin`: which ones /admin has set. */
export async function readGameSettings(db: D1Database): Promise<GameSettings & { fromAdmin: { character: boolean; signin: boolean } }> {
  const rows = (await db.prepare("SELECT key, value FROM meta WHERE key IN (?, ?)").bind(CHARACTER_KEY, SIGNIN_KEY).all<{ key: string; value: string }>()).results;
  const row = (key: string) => rows.find((r) => r.key === key)?.value;
  const character = row(CHARACTER_KEY);
  const signin = row(SIGNIN_KEY);
  return {
    character: isCharacter(character) ? character : CONFIG.character,
    signin: isSigninChoice(signin) ? signin : CONFIG.signin,
    fromAdmin: { character: isCharacter(character), signin: isSigninChoice(signin) },
  };
}

/** Saves what a press asked for (already checked by `parsePatch`): one write for each switch, then the new settings. */
export async function saveGameSettings(db: D1Database, patch: GamePatch, now = Date.now()) {
  const write = (key: string, value: string) => db.prepare("INSERT INTO meta (key, value, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at").bind(key, value, now);
  const batch: D1PreparedStatement[] = [];
  if (patch.character) batch.push(write(CHARACTER_KEY, patch.character));
  if (patch.signin) batch.push(write(SIGNIN_KEY, patch.signin));
  if (batch.length) await db.batch(batch);
  return readGameSettings(db);
}
