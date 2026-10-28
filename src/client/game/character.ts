// The player's character. Two are here, and game.config.json's "character" picks one:
//   "nanoterra"  the Nanoterra island character (nanoterraCharacter.ts, the package @nano133/nanoterra): a player who signed in from
//                Nanoterra plays as the character they picked there, and a look of this game's shop paints the shirt and puts its hat on.
//   "own"        the little penguin below: toon shapes, and a look (a body colour and a hat) from looks.json.
// Both do what `Avatar` says, so the game (game.ts) does not know which one it has.

import * as THREE from "three";
import type { Look as NanoterraLook } from "@nano133/nanoterra";
import { CONFIG } from "../../shared/config";
import type { Look } from "../../shared/looks";
import { HAND_HOLD } from "@nano133/nanoterra/character";
import { buildHat, disposeHat } from "./hat";
import { NanoterraCharacter } from "./nanoterraCharacter";
import { modelsOf, wearModel, type ModelSlot, type WornModel } from "./worn";
import { toon } from "./world";

/** The player's Nanoterra character as `/api/me` gives it: the five colours, and the whole record (two numbers on closed lists) when Nanoterra sent one. */
export type NanoterraPlayer = { look: NanoterraLook | null; record?: { v: 2; k: readonly [number, number] } | null };

/** What the game needs of a character. */
export interface Avatar {
  /** Put it in the scene, move it with `position`, turn it with `rotation.y` (it faces +z). */
  readonly group: THREE.Object3D;
  /** The blob shadow: put it in the scene too. (The Nanoterra character has its shadow in its body: this is empty for it.) */
  readonly ground: THREE.Object3D;
  /** The look of this game's shop (looks.json) that the player wears. */
  wear(look: Look): void;
  /** The character that the player has in Nanoterra, or null for a player who did not come from there. */
  setNanoterra(player: NanoterraPlayer | null): void;
  /** One frame. `group.position` is already where the character stands. `speed` is metres a second over the ground. */
  animate(dt: number, motion: { speed: number; airborne: boolean; verticalSpeed: number }): void;
  /** Takes off the look's models (worn.ts frees a model when nobody wears it). Call it before the character is thrown away. */
  release(): void;
  /** Waits until the models of the look that `wear` was given are on (or failed to load): the Shelf's picture waits for it. */
  ready(): Promise<void>;
}

/** The character for `kind`: the switch of /admin ("Game" card), which starts as game.config.json's word. */
export const makeAvatar = (ramp: THREE.Texture, kind: "nanoterra" | "own" = CONFIG.character): Avatar => (kind === "own" ? new Character(ramp) : new NanoterraCharacter(ramp));

export class Character implements Avatar {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly arms: THREE.Mesh[] = [];
  private readonly feet: THREE.Mesh[] = [];
  /** Where a hat sits: the middle of the head. */
  private readonly hat = new THREE.Group();
  private readonly shadow: THREE.Mesh;
  private readonly bodyMat: THREE.MeshToonMaterial;
  private step = 0;
  /** Where the look's models hang: the head (with the hat), the right flipper's tip and the back (worn.ts). */
  private readonly sockets: Record<ModelSlot, THREE.Object3D>;
  private models: WornModel[] = [];
  private dressing = 0;
  private loading: Promise<unknown>[] = [];

  constructor(private readonly ramp: THREE.Texture) {
    this.bodyMat = toon("#4aa8ff", ramp);
    const inner = new THREE.Group();
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.46, 0.5, 4, 14), this.bodyMat);
    this.body.position.y = 0.78;
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), toon("#ffffff", ramp));
    belly.position.set(0, 0.7, 0.3);
    belly.scale.set(1, 1.05, 0.62);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.43, 20, 14), this.bodyMat);
    head.position.y = 1.52;
    const eyeGeo = new THREE.SphereGeometry(0.075, 10, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: "#1b1d26" });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(0.15 * side, 1.58, 0.37);
      eye.scale.set(1, 1.35, 1);
      inner.add(eye);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.3, 3, 8), this.bodyMat);
      arm.position.set(0.52 * side, 0.82, 0);
      arm.rotation.z = 0.35 * side;
      this.arms.push(arm);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 8), toon("#ff9f43", ramp));
      foot.position.set(0.21 * side, 0.12, 0.06);
      foot.scale.set(1, 0.6, 1.45);
      this.feet.push(foot);
    }
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.16, 8), toon("#ff9f43", ramp));
    beak.position.set(0, 1.47, 0.43);
    beak.rotation.x = Math.PI / 2;
    this.hat.position.y = 1.52;
    inner.add(this.body, belly, head, beak, this.hat, ...this.arms, ...this.feet);
    this.group.add(inner);
    // The right flipper is the first (side -1: the character's right, facing +z). Its tip holds a hand model as the kit's hand socket does.
    const hand = new THREE.Group();
    hand.position.set(0, -0.3, 0);
    hand.quaternion.copy(HAND_HOLD);
    this.arms[0]!.add(hand);
    const back = new THREE.Group();
    back.position.set(0, 0.85, -0.44);
    inner.add(back);
    this.sockets = { head: this.hat, hand, back };

    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20), new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.22, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
  }

  /** The blob shadow lives in the world (it stays on the ground when the character jumps). */
  get ground(): THREE.Mesh {
    return this.shadow;
  }

  wear(look: Look) {
    this.bodyMat.color.set(look.change.body);
    // The models first (a head model hangs beside the hat): they are shared, so they are released, never disposed here.
    const turn = ++this.dressing;
    this.release();
    for (const old of [...this.hat.children]) disposeHat(old);
    const hat = buildHat(look, this.ramp);
    if (hat) this.hat.add(hat);
    this.loading = modelsOf(look).map(({ slot, name }) =>
      wearModel(name, slot, this.ramp)
        .then((m) => {
          if (turn !== this.dressing) return m.release();
          this.models.push(m);
          this.sockets[slot].add(m.object);
        })
        .catch((e) => console.warn(`The look's model ${name} did not load:`, e)),
    );
  }

  async ready() {
    await Promise.all(this.loading);
  }

  release() {
    for (const m of this.models) m.release();
    this.models = [];
  }

  /** The penguin has no Nanoterra look. */
  setNanoterra() {}

  /** A waddle while walking, and a stretch in the air. */
  animate(dt: number, { speed, airborne }: { speed: number; airborne: boolean; verticalSpeed: number }) {
    this.shadow.position.set(this.group.position.x, 0.02, this.group.position.z);
    this.shadow.scale.setScalar(1 / (1 + this.group.position.y * 0.35));
    this.step += dt * (4 + speed * 1.6);
    const swing = Math.min(1, speed / 6) * Math.sin(this.step * 2);
    this.feet[0]!.position.z = 0.06 + swing * 0.18;
    this.feet[1]!.position.z = 0.06 - swing * 0.18;
    this.arms[0]!.rotation.x = swing * 0.6;
    this.arms[1]!.rotation.x = -swing * 0.6;
    this.group.children[0]!.rotation.z = swing * 0.08;
    this.group.children[0]!.position.y = airborne ? 0 : Math.abs(swing) * 0.06;
    this.body.scale.set(1, airborne ? 1.08 : 1, 1);
  }
}
