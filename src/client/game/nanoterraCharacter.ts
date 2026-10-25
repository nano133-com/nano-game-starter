// The Nanoterra island character (the package @nano133/character) as this game's player. See character.ts for what the game needs of it.
//
// Whose colours it has:
//  - a player who signed in from Nanoterra plays in the look they have there (`setNanoterra`: skin, hair, shirt, trousers, shoes);
//    any other player has the island's first look (`defaultLook()`);
//  - a look of THIS game's shop (looks.json) that costs something paints the shirt with its body colour, and any look that has a hat puts
//    it on. The free look (the one every player starts with) leaves the colours alone, so it never hides the look that a player brought.
// The character's worn items (Nanoterra's cosmetics) are not drawn: the package does not draw them yet.

import * as THREE from "three";
import { createCharacter, defaultLook, isLook, type Character as NanoterraBody, type Look as NanoterraLook } from "@nano133/character";
import type { Look } from "../../shared/looks";
import type { Avatar } from "./character";
import { buildHat, disposeHat } from "./hat";

/** The island's avatar is 2.29 m tall. This game's island and its collider are a little smaller. */
const SCALE = 0.9;
/** The head bone's rest place is 1.5 m up and the middle of the head is 1.8 m up: a hat sits 0.3 m above the bone, a little wider than the hair. */
const HAT_UP = 0.3;
const HAT_SCALE = 1.07;

export class NanoterraCharacter implements Avatar {
  private readonly body: NanoterraBody;
  readonly group: THREE.Object3D;
  readonly ground: THREE.Object3D;
  private readonly mount = new THREE.Group();
  private base: NanoterraLook = defaultLook();
  private shop: Look | null = null;

  constructor(private readonly ramp: THREE.Texture) {
    this.body = createCharacter({ look: this.base, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
    this.group = this.body.object;
    this.group.scale.setScalar(SCALE);
    this.ground = this.body.shadow;
    // The hat rides the head bone, so it nods with the walk and the jump.
    this.mount.position.y = HAT_UP;
    this.mount.scale.setScalar(HAT_SCALE);
    (this.group.getObjectByName("head") ?? this.group).add(this.mount);
  }

  wear(look: Look) {
    this.shop = look;
    for (const old of [...this.mount.children]) disposeHat(old);
    const hat = buildHat(look, this.ramp);
    if (hat) this.mount.add(hat);
    this.paint();
  }

  setNanoterra(look: NanoterraLook | null) {
    this.base = look && isLook(look) ? { skin: look.skin, hair: look.hair, shirt: look.shirt, pants: look.pants, shoes: look.shoes } : defaultLook();
    this.paint();
  }

  private paint() {
    const paid = this.shop !== null && this.shop.priceUsd > 0;
    this.body.setLook({ ...this.base, shirt: paid ? this.shop!.change.body : this.base.shirt });
  }

  animate(dt: number, { speed, airborne, verticalSpeed }: { speed: number; airborne: boolean; verticalSpeed: number }) {
    // The package wants the numbers of a character of its own height: a smaller one is given speed / scale.
    this.body.update(dt, { speed: speed / SCALE, airborne, verticalSpeed: verticalSpeed / SCALE });
    this.ground.position.y = 0.02;
  }
}
