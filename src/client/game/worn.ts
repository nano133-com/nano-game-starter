// The looks' own 3D models. A look in looks.json may name a model in one of three slots, "head", "hand" or "back":
//   { "id": "shovel", ..., "slots": { "hand": "shovel" } }  ->  public/looks/shovel.glb, held in the right hand.
// The model is loaded (three's GLTFLoader, fetched only when someone wears such a look), painted in the game's toon light with a
// thin ink outline, and shared: every player who wears it draws the same geometry. When the last one takes it off, its geometry
// and materials are freed. test/lookModels.test.ts checks every model in public/looks against the kit's cosmetic limits.
//
// Where a model sits: the Nanoterra character hangs it on its socket (`socket("hand")`, @nano133/nanoterra/character), the
// penguin on its own arm or head. A hand model is held at its `grip_R` marker (an empty node where the right hand holds it).

import * as THREE from "three";

export const MODEL_SLOTS = ["head", "hand", "back"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

/** A slot's value names a file in public/looks: a word of lowercase letters, digits and dashes (the looks rules allow no other word). */
const NAME = /^[a-z0-9-]{1,40}$/;
export const modelUrl = (name: string) => `/looks/${name}.glb`;

/** The models a look wears: each slot of MODEL_SLOTS whose value is a model's name (a colour value is not a model). */
export function modelsOf(look: { slots?: Record<string, string> }): { slot: ModelSlot; name: string }[] {
  const out: { slot: ModelSlot; name: string }[] = [];
  for (const slot of MODEL_SLOTS) {
    const v = look.slots?.[slot];
    if (typeof v === "string" && NAME.test(v)) out.push({ slot, name: v });
  }
  return out;
}

/**
 * How a model is held, beyond its socket: a turn (radians, about the socket's own axes). The hand socket points a thing's +Y forward.
 * The shovel's grips are on the T-handle at its top and its blade is at its foot (its -Y), so it is turned half a turn to point forward
 * from the hand, a little down (HOLD_UP). Its grip_L (a second hand on the T-handle) is not used: the character's arms swing free, with no
 * pose that puts the left hand there.
 *
 * In a run the elbow bends more (the package's pose: 0.12 rad at rest, 0.32 in a walk, up to 1.02 in a run) and the arm swings further
 * forward, and both lift a thing that points forward up in front of the face. `hold(bend, swing)` turns the thing down again in a run
 * (Wes, 2026-10-28: "hold it lower in a run"): by RUN_LOWER of how far the forearm points up past the rest (the bend, and the swing
 * forward), times how much of a run it is (the bend past the walk's, over the run's 0.7). A walk and a stand keep the plain hold, and
 * the arm's back swing is never lowered (the blade would reach the ground).
 */
const HOLD_UP = -0.1;
export const HOLDS: Record<string, { turn: readonly [number, number, number] }> = {
  shovel: { turn: [Math.PI + HOLD_UP, 0, 0] },
};
/** The elbow's bend at rest and in a walk, and what a run adds, in the package's pose (radians). */
export const REST_BEND = 0.12;
export const WALK_BEND = 0.32;
export const RUN_BEND = 0.7;
/** How much of the forearm's lift a hand thing is turned down again in a full run. */
export const RUN_LOWER = 0.8;

/** The turn down (radians) for an elbow's bend and the upper arm's swing (`upperarm_R.rotation.x`: negative is forward). */
export function runLower(bend: number, swing: number): number {
  if (!Number.isFinite(bend) || !Number.isFinite(swing)) return 0;
  const run = Math.min(1, Math.max(0, (bend - WALK_BEND) / RUN_BEND));
  return RUN_LOWER * run * Math.max(0, bend - swing - REST_BEND);
}

/** The ink outline's colour and width (metres): the island's. */
const INK = "#1d1530";
const INK_WIDTH = 0.016;

type Template = { scene: THREE.Group; grip: THREE.Vector3; things: (THREE.BufferGeometry | THREE.Material)[] };
type Entry = { users: number; ready: Promise<Template> };
const cache = new Map<string, Entry>();

/**
 * What `wearModel` gives: the object to hang (a copy that shares the model's geometry), `hold` (each frame, for a hand thing: the elbow's
 * bend, `-forearm_R.rotation.x`, and the upper arm's swing, `upperarm_R.rotation.x`) and `release` to take it off.
 */
export type WornModel = { object: THREE.Group; hold(bend: number, swing?: number): void; release(): void };

/** The bytes of a model; a test gives its own. */
export type FetchBytes = (url: string) => Promise<ArrayBuffer>;
const fetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
};

/** Toon materials and an ink hull for each mesh of a loaded model. Returns what must be freed. */
function toonify(scene: THREE.Object3D, ramp: THREE.Texture) {
  const things: (THREE.BufferGeometry | THREE.Material)[] = [];
  const ink = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  things.push(ink);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    const old = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
    const mats = old.map((m) => {
      const t = new THREE.MeshToonMaterial({ color: m.color ?? 0xffffff, map: m.map ?? null, vertexColors: !!mesh.geometry.attributes.color, gradientMap: ramp });
      things.push(t);
      m.dispose();
      return t;
    });
    mesh.material = Array.isArray(mesh.material) ? mats : mats[0]!;
    things.push(mesh.geometry);
    // The outline: the same shape pushed out along its normals, its back faces drawn in ink (one more draw).
    const n = mesh.geometry.attributes.normal;
    if (n) {
      const hull = mesh.geometry.clone();
      const p = hull.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + n.getX(i) * INK_WIDTH, p.getY(i) + n.getY(i) * INK_WIDTH, p.getZ(i) + n.getZ(i) * INK_WIDTH);
      hull.deleteAttribute("color");
      const outline = new THREE.Mesh(hull, ink);
      outline.name = `${mesh.name}-ink`;
      mesh.add(outline);
      things.push(hull);
    }
  }
  return things;
}

async function load(name: string, ramp: THREE.Texture, get: FetchBytes): Promise<Template> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const bytes = await get(modelUrl(name));
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  const scene = gltf.scene;
  const things = toonify(scene, ramp);
  scene.updateMatrixWorld(true);
  const marker = scene.getObjectByName("grip_R");
  const grip = marker ? new THREE.Vector3().setFromMatrixPosition(marker.matrixWorld) : new THREE.Vector3();
  return { scene, grip, things };
}

/**
 * A model to wear, loaded once and shared. `scale`: metres of the model to one unit of the place it hangs (the Nanoterra character's
 * socket is inside a group scaled by the game's SCALE). The promise fails when the file is missing or is not a model: the look then
 * shows without it.
 */
export async function wearModel(name: string, slot: ModelSlot, ramp: THREE.Texture, opts: { scale?: number; fetch?: FetchBytes } = {}): Promise<WornModel> {
  let entry = cache.get(name);
  if (!entry) {
    entry = { users: 0, ready: load(name, ramp, opts.fetch ?? fetchBytes) };
    cache.set(name, entry);
    entry.ready.catch(() => cache.delete(name));
  }
  entry.users++;
  let t: Template;
  try {
    t = await entry.ready;
  } catch (e) {
    entry.users--;
    throw e;
  }
  const holder = new THREE.Group();
  holder.name = `worn-${name}`;
  const copy = t.scene.clone(true);
  // The grip (a hand model's grip_R) on the socket's point.
  if (slot === "hand") copy.position.sub(t.grip);
  holder.add(copy);
  const turn = HOLDS[name]?.turn ?? [0, 0, 0];
  holder.rotation.set(turn[0], turn[1], turn[2]);
  holder.scale.setScalar(opts.scale ?? 1);
  let done = false;
  const e = entry;
  return {
    object: holder,
    hold(bend, swing = 0) {
      if (slot !== "hand") return;
      holder.rotation.x = turn[0] - runLower(bend, swing);
    },
    release() {
      if (done) return;
      done = true;
      holder.removeFromParent();
      if (--e.users > 0) return;
      cache.delete(name);
      for (const thing of t.things) thing.dispose();
    },
  };
}

/** How many models are loaded now (for the test). */
export const loadedModels = () => cache.size;
