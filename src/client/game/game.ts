// The game loop: a round of collecting gems against the clock. Change the rules here (speed, jump, the
// round's length in game.config.json), the level in world.ts, the character in character.ts (or nanoterraCharacter.ts).

import * as THREE from "three";
import { CONFIG } from "../../shared/config";
import type { Look } from "../../shared/looks";
import { makeAvatar, type Avatar, type NanoterraPlayer } from "./character";
import { Controls } from "./controls";
import { Gems } from "./gems";
import { buildWorld, ISLAND_RADIUS, toonRamp, type Collider } from "./world";

const SPEED = 6.5;
const ACCEL = 14;
const JUMP_SPEED = 7.6;
const GRAVITY = 22;
const PLAYER_RADIUS = 0.45;
const CAMERA_DISTANCE = 8.5;

export type GameState = "ready" | "playing" | "over";

export type GameEvents = {
  score: (score: number) => void;
  time: (secondsLeft: number) => void;
  over: (score: number, best: number, isBest: boolean) => void;
};

const BEST_KEY = "gem-island.best";
const readBest = () => {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
};

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  /** The player's character. `setCharacter` replaces it when the switch of /admin differs from the bundled word (game.config.json). */
  character: Avatar;
  private characterKind: "nanoterra" | "own" = CONFIG.character;
  private readonly ramp: THREE.Texture;
  readonly controls: Controls;
  private readonly gems: Gems;
  private readonly colliders: Collider[];
  private readonly updateWorld: (t: number) => void;
  private readonly player = new THREE.Vector3(0, 0, 3);
  private readonly velocity = new THREE.Vector3();
  private vy = 0;
  private yaw = 0;
  private pitch = 0.42;
  private facing = Math.PI;
  private readonly camTarget = new THREE.Vector3();
  // Reused every frame, so a phone's garbage collector has less to do.
  private readonly want = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly nowhere = new THREE.Vector3(999, 999, 999);
  private readonly clock = new THREE.Clock();
  private t = 0;
  state: GameState = "ready";
  /** True while a round runs (not before the first Play, not after the end card). */
  get playing() {
    return this.state === "playing";
  }
  /** True while a sheet (looks, sign-in, pay) is open: the clock and the character stop. */
  paused = false;
  score = 0;
  best = readBest();
  timeLeft: number = CONFIG.round.seconds;
  private lastShownSecond = -1;

  constructor(
    private readonly view: HTMLElement,
    hud: { stick: HTMLElement; knob: HTMLElement; jump: HTMLElement },
    private readonly on: GameEvents,
  ) {
    const touch = matchMedia("(pointer: coarse)").matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    // A phone screen has many pixels: 1.75 is sharp enough and keeps a mid-range phone smooth.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touch ? 1.75 : 2));
    view.appendChild(this.renderer.domElement);
    const ramp = toonRamp();
    this.ramp = ramp;
    const world = buildWorld(this.scene, ramp);
    this.colliders = world.colliders;
    this.updateWorld = world.update;
    this.character = makeAvatar(ramp);
    this.scene.add(this.character.group, this.character.ground);
    this.gems = new Gems(this.scene, ramp, this.colliders, CONFIG.round.gems, CONFIG.round.goldEvery);
    this.controls = new Controls(view, hud.stick, hud.knob, hud.jump);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(view);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.renderer.setAnimationLoop(null);
      else this.loop();
    });
    this.loop();
    // For automated checks (tests read it; the game never needs it).
    (window as unknown as { __gemIsland: unknown }).__gemIsland = {
      snapshot: () => ({ state: this.state, score: this.score, x: this.player.x, z: this.player.z, yaw: this.yaw, pitch: this.pitch, pixelRatio: this.renderer.getPixelRatio() }),
    };
  }

  wear(look: Look) {
    this.character.wear(look);
  }

  /**
   * The game's character for `kind` (the "Game" card of /admin, read from /api/config): the same one stays, or it is replaced. The new one is
   * put where the old one stood; the caller dresses it (the shop's look and the Nanoterra character) as at the start.
   */
  setCharacter(kind: "nanoterra" | "own") {
    if (kind === this.characterKind) return;
    const old = this.character;
    // The look's models first: they are shared, so worn.ts frees them, not the loop below.
    old.release();
    this.scene.remove(old.group, old.ground);
    for (const node of [old.group, old.ground]) {
      node.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
      });
    }
    this.character = makeAvatar(this.ramp, kind);
    this.characterKind = kind;
    this.scene.add(this.character.group, this.character.ground);
  }

  /** The character that the player has in Nanoterra (they signed in from there), or null. */
  setNanoterra(player: NanoterraPlayer | null) {
    this.character.setNanoterra(player);
  }

  start() {
    this.score = 0;
    this.timeLeft = CONFIG.round.seconds;
    this.lastShownSecond = -1;
    this.player.set(0, 0, 3);
    this.velocity.set(0, 0, 0);
    this.gems.reset(this.player);
    this.state = "playing";
    this.on.score(0);
    this.clock.getDelta();
  }

  private loop() {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize() {
    const w = this.view.clientWidth || window.innerWidth;
    const h = this.view.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // A tall phone sees more of the island with a wider view.
    this.camera.fov = w < h ? 64 : 55;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    const dt = this.paused ? 0 : Math.min(0.05, this.clock.getDelta());
    if (this.paused) this.clock.getDelta();
    this.t += dt;
    const input = this.controls.read();
    this.yaw -= input.lookX;
    this.pitch = Math.min(1.15, Math.max(0.05, this.pitch + input.lookY));

    const playing = this.state === "playing";
    // Movement is relative to the camera: "forward" is away from it.
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const want = this.want.set(fx * input.y + Math.cos(this.yaw) * input.x, 0, fz * input.y - Math.sin(this.yaw) * input.x).multiplyScalar(this.state === "over" ? 0 : SPEED);
    this.velocity.lerp(want, Math.min(1, ACCEL * dt));
    this.player.addScaledVector(this.velocity, dt);
    const onGround = this.player.y <= 0;
    if (input.jump && onGround) this.vy = JUMP_SPEED;
    this.vy -= GRAVITY * dt;
    this.player.y = Math.max(0, this.player.y + this.vy * dt);
    if (this.player.y === 0 && this.vy < 0) this.vy = 0;
    this.collide();

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed > 0.3) {
      const target = Math.atan2(this.velocity.x, this.velocity.z);
      let d = target - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 12);
    }
    this.character.group.position.copy(this.player);
    this.character.group.rotation.y = this.facing;
    this.character.animate(dt, { speed, airborne: this.player.y > 0.02, verticalSpeed: this.vy });

    if (playing) {
      const points = this.gems.update(dt, this.t, this.player);
      if (points) {
        this.score += points;
        this.on.score(this.score);
      }
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      const s = Math.ceil(this.timeLeft);
      if (s !== this.lastShownSecond) {
        this.lastShownSecond = s;
        this.on.time(s);
      }
      if (this.timeLeft <= 0) this.finish();
    } else this.gems.update(dt, this.t, this.nowhere);

    this.updateWorld(this.t);
    this.camTarget.lerp(this.look.set(this.player.x, this.player.y * 0.5 + 1.2, this.player.z), Math.min(1, dt * 10));
    const c = this.camera.position;
    c.set(
      this.camTarget.x + Math.sin(this.yaw) * Math.cos(this.pitch) * CAMERA_DISTANCE,
      this.camTarget.y + Math.sin(this.pitch) * CAMERA_DISTANCE,
      this.camTarget.z + Math.cos(this.yaw) * Math.cos(this.pitch) * CAMERA_DISTANCE,
    );
    this.camera.lookAt(this.camTarget);
    this.renderer.render(this.scene, this.camera);
  }

  private collide() {
    const p = this.player;
    for (const c of this.colliders) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const min = c.r + PLAYER_RADIUS;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-9) {
        const d = Math.sqrt(d2);
        p.x = c.x + (dx / d) * min;
        p.z = c.z + (dz / d) * min;
      }
    }
    const r = Math.hypot(p.x, p.z);
    if (r > ISLAND_RADIUS) {
      p.x *= ISLAND_RADIUS / r;
      p.z *= ISLAND_RADIUS / r;
    }
  }

  private finish() {
    this.state = "over";
    const isBest = this.score > this.best;
    if (isBest) {
      this.best = this.score;
      try {
        localStorage.setItem(BEST_KEY, String(this.best));
      } catch {
        // Private windows may refuse storage: the best score then lasts for this visit only.
      }
    }
    this.on.over(this.score, this.best, isBest);
  }
}
