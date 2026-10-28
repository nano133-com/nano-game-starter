// Which character the page draws for the visitor (main.ts, dress()). Pure, so that a test can pin it.

import type { NanoterraPlayer } from "../game/character";
import type { Config, Me } from "./api";

/**
 * The Nanoterra character to draw for this visitor, or null for the island's first character.
 *
 * A player who signed in from Nanoterra brings the character they picked there, but ONLY while "Players can sign in with Nanoterra" is On in /admin (the "Game"
 * card). With it Off, every player plays as the island's first character, a player who signed in from Nanoterra before the switch went Off included: Off means Off.
 * When the page does not know the switch (`/api/config` did not answer), nothing changes.
 */
export function nanoterraPlayerOf(me: Me, config: Pick<Config, "nanoterraSignin">): NanoterraPlayer | null {
  if (config.nanoterraSignin === false) return null;
  return me.via === "nanoterra" ? { look: me.look ?? null, record: me.record ?? null } : null;
}
