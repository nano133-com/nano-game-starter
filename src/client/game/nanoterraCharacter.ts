// The Nanoterra island character (the package @nano133/nanoterra, path /character) as this game's player. See character.ts for what the game needs of it.
//
// Whose character it is:
//  - a player who signed in from Nanoterra plays as the character they picked there: the whole record (the base, the face, the hair, the clothes, the sizes
//    and the colours; `/api/me` gives it as two numbers, `unpackRecord` reads them and refuses a number off a list). A player whose Nanoterra sent no record
//    plays in their five colours on the Classic body; any other player has the island's first look;
//  - a look of THIS game's shop (looks.json) that costs something paints the shirt with its body colour (the body, for a character that wears no top: the
//    same rule as Nanoterra's own shirt dyes), and any look that has a hat puts it on, on the head of whatever body the player has. The free look (the one
//    every player starts with) leaves the colours alone, so it never hides the look that a player brought.
//  - a look whose slots name a model ("hand": "shovel", worn.ts) hangs that model on the character's socket (`socket("hand")`, the package's), so it
//    follows the hand on every base and stays on after the body is rebuilt.
// The character's worn items from Nanoterra (Nanoterra's cosmetics) are not drawn: the package does not carry the island's item art.
// The body is display only: the collider, the jump and the reach in game.ts are the same for every base and size.

import * as THREE from "three";
import { DEFAULT_RECORD, TOPS, createCharacter, fromLegacy, isLook, unpackRecord, type Character as NanoterraBody, type LookRecord } from "@nano133/nanoterra/character";
import type { Look } from "../../shared/looks";
import type { Avatar, NanoterraPlayer } from "./character";
import { buildHat, disposeHat } from "./hat";
import { modelsOf, wearModel, type ModelSlot, type WornModel } from "./worn";

/** The island's avatar is 2.29 m tall. This game's island and its collider are a little smaller. */
const SCALE = 0.9;
/** A hat sits a little below the head socket (the kit's hat frame), a little wider than the hair. */
const HAT_GAP = 0.03;
const HAT_SCALE = 1.07;

export class NanoterraCharacter implements Avatar {
  private readonly body: NanoterraBody;
  readonly group: THREE.Object3D;
  /** The blob shadow is a disc in the Nanoterra body (it stays on the ground in a jump by itself): nothing to put in the world. */
  readonly ground: THREE.Object3D = new THREE.Group();
  private readonly mount = new THREE.Group();
  private rec: LookRecord = DEFAULT_RECORD;
  private shop: Look | null = null;
  /** The look's models now, and a count that a slow load reads to see if the look changed meanwhile. */
  private models: { slot: ModelSlot; model: WornModel }[] = [];
  private dressing = 0;

  constructor(private readonly ramp: THREE.Texture) {
    this.body = createCharacter({ record: this.rec, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
    this.group = this.body.object;
    this.group.scale.setScalar(SCALE);
    this.body.socket("head").add(this.mount);
    this.seat();
  }

  wear(look: Look) {
    this.shop = look;
    for (const old of [...this.mount.children]) disposeHat(old);
    const hat = buildHat(look, this.ramp);
    if (hat) this.mount.add(hat);
    this.paint();
    this.dress(look);
  }

  /** The look's models on their sockets. A model that fails to load leaves the look without it. */
  private dress(look: Look) {
    const turn = ++this.dressing;
    this.release();
    for (const { slot, name } of modelsOf(look)) {
      // The model is in the game's metres; the socket is inside the character's group, scaled by SCALE.
      wearModel(name, slot, this.ramp, { scale: 1 / SCALE })
        .then((m) => {
          if (turn !== this.dressing) return m.release();
          this.models.push({ slot, model: m });
          this.body.setWorn(this.models.map((w) => ({ socket: w.slot, object: w.model.object })));
        })
        .catch((e) => console.warn(`The look's model ${name} did not load:`, e));
    }
  }

  release() {
    this.body.setWorn([]);
    for (const m of this.models) m.model.release();
    this.models = [];
  }

  setNanoterra(player: NanoterraPlayer | null) {
    const packed = player?.record ? unpackRecord(player.record.k[0], player.record.k[1]) : null;
    this.rec = packed ?? (player?.look && isLook(player.look) ? fromLegacy(player.look) : DEFAULT_RECORD);
    // Another base or clothes build new geometry and bones (the old are freed); the walk carries on.
    this.body.setLook(this.rec);
    this.seat();
    this.paint();
  }

  /**
   * The hat rides the head socket (on the head bone), so it nods with the walk and the jump. The socket sits at each base's hat frame and
   * scales with it and the head's size, and it moves to the new bones by itself when the body is rebuilt; the hat sits HAT_GAP below it
   * (in metres of the head bone, so the gap is divided by the socket's own height scale).
   */
  private seat() {
    const s = this.body.socket("head").scale;
    this.mount.position.set(0, -HAT_GAP / s.y, 0);
    this.mount.scale.setScalar(HAT_SCALE);
  }

  private paint() {
    const paid = this.shop !== null && this.shop.priceUsd > 0;
    if (!paid) return this.body.setColors(null);
    // A look of the shop paints the shirt; a character with no top has no shirt, so it paints the body (as Nanoterra's own shirt dyes do).
    this.body.setColors(TOPS[this.rec.top] === "none" ? { skin: this.shop!.change.body } : { shirt: this.shop!.change.body });
  }

  animate(dt: number, { speed, airborne, verticalSpeed }: { speed: number; airborne: boolean; verticalSpeed: number }) {
    // The package wants the numbers of a character of its own height: a smaller one is given speed / scale.
    this.body.update(dt, { speed: speed / SCALE, airborne, verticalSpeed: verticalSpeed / SCALE });
  }
}
