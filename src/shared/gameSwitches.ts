// The two switches of the "Game" card in /admin, and the words that say what each does. Both sides read this file: the Worker checks a press with
// `parsePatch`, the admin page draws the card from `SWITCHES`. A switch changes ONLY these two settings, kept in the database's `meta` table
// (src/worker/gameSettings.ts); never a look, a price or an order (AGENTS.md, "The Shelf never writes").

/** Which character the player is: Nanoterra's island character (in the look the player has there) or the game's own penguin. */
export type Character = "nanoterra" | "own";
/** How the game signs a Nanoterra player in: the code exchange, a signed ticket (a game with no server), or not at all. */
export type Signin = "exchange" | "ticket" | "none";
export type GameSettings = { character: Character; signin: Signin };
/** What a press can set: sign-in is on ("exchange": the starter has a server) or off ("none"). */
export type GamePatch = { character?: Character; signin?: "exchange" | "none" };

export const isCharacter = (v: unknown): v is Character => v === "nanoterra" || v === "own";
export const isSigninChoice = (v: unknown): v is "exchange" | "none" => v === "exchange" || v === "none";
/** The sign-in switch is on for any way but "none". */
export const signinOn = (s: Signin) => s !== "none";

/** A request body for POST /api/admin/game: only the two known words, at least one. Anything else is refused, with the reason in words. */
export function parsePatch(body: unknown): { ok: true; patch: GamePatch } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send an object with \"character\" or \"signin\"." };
  const entries = Object.entries(body as Record<string, unknown>);
  const patch: GamePatch = {};
  for (const [key, value] of entries) {
    if (key === "character" && isCharacter(value)) patch.character = value;
    else if (key === "signin" && isSigninChoice(value)) patch.signin = value;
    else if (key === "character") return { ok: false, error: '"character" must be "nanoterra" or "own".' };
    else if (key === "signin") return { ok: false, error: '"signin" must be "exchange" or "none".' };
    else return { ok: false, error: `"${key}" is not a game switch.` };
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'Send "character" or "signin".' };
  return { ok: true, patch };
}

/** One switch of the card: its title, and one plain sentence for each state. */
export type SwitchId = "character" | "signin";
export const SWITCHES: Record<SwitchId, { title: string; on: string; off: string }> = {
  character: {
    title: "Players use their Nanoterra character",
    on: "On: a player who signs in from Nanoterra plays as the character they picked there. Anyone else plays as the island's first character.",
    off: "Off: every player plays as this game's own character (the little penguin of character.ts).",
  },
  signin: {
    title: "Players can sign in with Nanoterra",
    on: "On: this game's listing file says players can sign in with Nanoterra, and the game accepts that sign-in.",
    off: "Off: the listing file says no sign-in, and the game refuses it: a link made before still signs nobody in.",
  },
};

/**
 * The character comes through the sign-in: only a player who signs in from Nanoterra brings one. So the character switch is shown with its dependency,
 * and with sign-in Off it says what a player gets now (a session made before the switch went Off still carries its character until it ends).
 */
export const CHARACTER_NEEDS_SIGNIN = "This needs “Players can sign in with Nanoterra” to be On: only a player who signs in from Nanoterra brings a character.";
export const CHARACTER_SIGNIN_OFF =
  "Sign-in from Nanoterra is Off, so no new player can bring a character: every new player plays as the island's first character. A player who signed in before keeps their character until that sign-in ends.";

/** What to tell the creator under the sign-in switch about Nanoterra's review. The starter cannot see that review: it says so. */
export const REVIEW_NOTE =
  "Your choice is saved here at once. The sign-in word is part of your listing file, and Nanoterra's review decides what Nanoterra shows for a game that is listed. This page cannot see that review. Check it on Nanoterra's launch page (step 6).";
export const REVIEW_LINK = "https://nano133.com/build/nanoterra/launch";

/** The state of a switch from the settings, and the patch that a press sends (the other state). */
export const stateOf = (id: SwitchId, s: GameSettings): boolean => (id === "character" ? s.character === "nanoterra" : signinOn(s.signin));
export const pressOf = (id: SwitchId, s: GameSettings): GamePatch => (id === "character" ? { character: s.character === "nanoterra" ? "own" : "nanoterra" } : { signin: signinOn(s.signin) ? "none" : "exchange" });
