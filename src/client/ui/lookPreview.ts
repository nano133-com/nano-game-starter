// The Shelf's pictures in /admin: each look on this game's own character (the switch of the "Game" card, game.config.json's word), with
// its hat and its model, drawn once by the package's `createLookPreview` (one WebGL context for the whole Shelf). admin.ts loads this file
// only when the Shelf shows a look, so the admin page loads Three.js only then.

import * as THREE from "three";
import { createLookPreview } from "@nano133/nanoterra/character";
import type { Look } from "../../shared/looks";
import { makeAvatar } from "../game/character";
import { toonRamp } from "../game/world";

const ramp = toonRamp();

const preview = createLookPreview<Look>({
  body: () => {
    const avatar = makeAvatar(ramp);
    const object = new THREE.Group();
    object.add(avatar.group, avatar.ground);
    return {
      object,
      async dress(look) {
        avatar.wear(look);
        avatar.animate(0.016, { speed: 0, airborne: false, verticalSpeed: 0 });
        await avatar.ready();
      },
      dispose() {
        avatar.release();
        object.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
        });
      },
    };
  },
});

export const render = (look: Look) => preview.render(look);
