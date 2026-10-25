// The game's public settings, from game.config.json at the top of the project.

import raw from "../../game.config.json" with { type: "json" };

export type GameConfig = {
  name: string;
  line: string;
  creator: { name: string };
  art: { wide: string; tall: string };
  multiplayer: boolean;
  regions: string[];
  ages: string;
  /** How the game signs a Nanoterra player in: "exchange" (the Worker trades a one-time code), "ticket" or "none". */
  signin: "exchange" | "ticket" | "none";
  /** Which character the player is: "nanoterra" (the Nanoterra island character, in the look the player has there) or "own" (the penguin of character.ts). */
  character: "nanoterra" | "own";
  round: { seconds: number; gems: number; goldEvery: number };
};

function check(c: any): GameConfig {
  const text = (v: unknown, what: string, max: number) => {
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`game.config.json: "${what}" must be 1 to ${max} characters`);
    return v;
  };
  const path = (v: unknown, what: string) => {
    if (typeof v !== "string" || !/^\/[A-Za-z0-9._\/-]+$/.test(v)) throw new Error(`game.config.json: "${what}" must be a path that starts with "/"`);
    return v;
  };
  const n = (v: unknown, what: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`game.config.json: "${what}" must be a whole number from ${min} to ${max}`);
    return v;
  };
  if (!Array.isArray(c?.regions) || !c.regions.every((r: unknown) => typeof r === "string")) throw new Error('game.config.json: "regions" must be a list of words, for example ["Global"]');
  return {
    name: text(c.name, "name", 60),
    line: text(c.line, "line", 140),
    creator: { name: text(c.creator?.name, "creator.name", 60) },
    art: { wide: path(c.art?.wide, "art.wide"), tall: path(c.art?.tall, "art.tall") },
    multiplayer: c.multiplayer === true,
    regions: c.regions,
    ages: text(c.ages, "ages", 10),
    signin: c.signin === "ticket" || c.signin === "none" ? c.signin : "exchange",
    character: c.character === "own" ? "own" : "nanoterra",
    round: { seconds: n(c.round?.seconds, "round.seconds", 10, 600), gems: n(c.round?.gems, "round.gems", 1, 40), goldEvery: n(c.round?.goldEvery, "round.goldEvery", 2, 100) },
  };
}

export const CONFIG: GameConfig = check(raw);
