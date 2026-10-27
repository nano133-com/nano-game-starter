// The looks (cosmetics) a player can wear, from looks.json at the top of the project.
// A look only changes how the character looks. It is never random, and it never changes a score.
// The rules of the file (what a good look is, the price ladder, what a change does to players who own a look) are in the
// package @nano133/looks, so the game and the Shelf screen in /admin check the same words.

import list from "../../looks.json" with { type: "json" };
import { checkLooks, HATS, usdText, type Hat, type Look } from "@nano133/nanoterra/looks";

export { checkLooks, HATS, usdText };
export type { Hat, Look };

export const LOOKS: Look[] = checkLooks(list);
export const FREE_LOOK: Look = LOOKS.find((l) => l.priceUsd === 0)!;
export const lookById = (id: unknown): Look | undefined => LOOKS.find((l) => l.id === id);
