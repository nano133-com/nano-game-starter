// The player's settings (@nano133/nanoterra/options): one store for the whole page, kept in this browser. The game reads a value where it uses
// it (controls.ts: the camera speed, Invert look, the stick's side and the Jump key; game.ts: the quality; the characters: Less motion), and the
// Options key and panel (main.ts) change them. Only the settings the game really honours are here: the starter plays no sound, so it has no volumes.
//
// To add a setting: put its def in `defs` below (or `common("...")` for one of the kit's common settings), then read it with `options.get(key)`
// where the game uses it, and follow a change with `options.subscribe`. A setting changes how the game looks and is controlled, never a rule or a score.
// The emotes add their own three settings (Show the Emotes key, Show other players' emotes, the wheel's key) once the server says the wheel is on (main.ts).

import { common, createOptions, keyBinding, reflectOptions } from "@nano133/nanoterra/options";

/**
 * The name the browser keeps the settings and the emote wheel under (`n133-options:gem-island`, `n133-emotes:gem-island`), like the best score
 * (`gem-island.best`). Each game's site has its own storage, so the name only has to stay the same: not the game's Nanoterra id, which a
 * creator adds later and which would drop every player's settings.
 */
export const GAME_KEY = "gem-island";

export const options = createOptions({
  game: GAME_KEY,
  defs: [
    ...common("cameraSensitivity", "invertLook", "stickSide", "reducedMotion", "quality"),
    // A key on a keyboard is its place (KeyboardEvent.code): Space. The arrows and WASD stay the move keys.
    keyBinding("jump", "Jump", "Space"),
  ],
});

// <html data-n133-opt-reduced-motion="true|false" data-n133-opt-stick-side="left|right">: style.css calms the HUD and moves Jump to the other side.
reflectOptions(options, ["reducedMotion", "stickSide"]);
