// The looks (cosmetics) a player can wear, from looks.json at the top of the project.
// A look only changes how the character looks. It is never random, and it never changes a score.
// The rules of the file (what a good look is, the price ladder, what a change does to players who own a look) are in the
// package @nano133/nanoterra (path /looks), so the game and the Shelf screen in /admin check the same words.

import list from "../../looks.json" with { type: "json" };
import { checkLooks, HATS, isOutfit, usdText, type Change, type Hat, type Look } from "@nano133/nanoterra/looks";

export { checkLooks, HATS, isOutfit, usdText };
export type { Hat, Look };

/** An outfit: a look the character wears (its body colour and hat, `change`). Every other look fills a wear slot of the game's own
 * ("wear": "shovel"); this starter lists and draws outfits only, and a game with items shows and draws them itself. */
export type Outfit = Look & { change: Change };

export const LOOKS: Look[] = checkLooks(list);
export const OUTFITS: Outfit[] = LOOKS.filter(isOutfit);
/** checkLooks makes sure that there is one free outfit: every player starts with it. */
export const FREE_LOOK: Outfit = OUTFITS.find((l) => l.priceUsd === 0)!;
export const lookById = (id: unknown): Look | undefined => LOOKS.find((l) => l.id === id);
export const outfitById = (id: unknown): Outfit | undefined => OUTFITS.find((l) => l.id === id);
