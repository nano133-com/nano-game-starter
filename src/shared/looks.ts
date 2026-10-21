// The looks (cosmetics) a player can wear, from looks.json at the top of the project.
// A look only changes how the character looks. It is never random, and it never changes a score.

import list from "../../looks.json" with { type: "json" };

export const HATS = ["cap", "beanie", "crown", "tophat"] as const;
export type Hat = (typeof HATS)[number];

export type Look = {
  /** Lowercase letters, digits and dashes: "mint-cap". Never change the id of a look someone owns. */
  id: string;
  name: string;
  /** The price in US dollars, for example 0.25. 0 means free for everyone. */
  priceUsd: number;
  change: { body: string; hat?: Hat; hatColor?: string };
};

const COLOR = /^#[0-9a-f]{6}$/i;

/** Checks looks.json and explains the first mistake in plain words. */
export function checkLooks(raw: unknown): Look[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("looks.json must be a list with at least one look");
  const seen = new Set<string>();
  const looks = raw.map((l: any, i: number): Look => {
    const where = `looks.json, look ${i + 1}`;
    if (typeof l?.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(l.id)) throw new Error(`${where}: "id" must be 1 to 40 lowercase letters, digits or dashes`);
    if (seen.has(l.id)) throw new Error(`${where}: the id "${l.id}" is used twice`);
    seen.add(l.id);
    if (typeof l.name !== "string" || !l.name.trim() || l.name.length > 40) throw new Error(`${where}: "name" must be 1 to 40 characters`);
    if (typeof l.priceUsd !== "number" || !Number.isFinite(l.priceUsd) || l.priceUsd < 0 || l.priceUsd > 1000) throw new Error(`${where}: "priceUsd" must be a number from 0 to 1000`);
    if (Math.round(l.priceUsd * 100) !== l.priceUsd * 100) throw new Error(`${where}: "priceUsd" can have at most 2 decimals (cents)`);
    if (!COLOR.test(l.change?.body ?? "")) throw new Error(`${where}: "change.body" must be a colour like "#4aa8ff"`);
    if (l.change.hat !== undefined && !HATS.includes(l.change.hat)) throw new Error(`${where}: "change.hat" must be one of ${HATS.join(", ")}`);
    if (l.change.hatColor !== undefined && !COLOR.test(l.change.hatColor)) throw new Error(`${where}: "change.hatColor" must be a colour like "#1c6e4f"`);
    return { id: l.id, name: l.name, priceUsd: l.priceUsd, change: { body: l.change.body, hat: l.change.hat, hatColor: l.change.hatColor } };
  });
  if (!looks.some((l) => l.priceUsd === 0)) throw new Error("looks.json needs at least one free look (priceUsd 0): every player starts with it");
  return looks;
}

export const LOOKS: Look[] = checkLooks(list);
export const FREE_LOOK: Look = LOOKS.find((l) => l.priceUsd === 0)!;
export const lookById = (id: unknown): Look | undefined => LOOKS.find((l) => l.id === id);

/** "$0.25" */
export const usdText = (usd: number) => `$${usd.toFixed(2)}`;
