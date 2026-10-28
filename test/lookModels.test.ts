// The looks' 3D models (public/looks/*.glb, src/client/game/worn.ts): every model passes the kit's cosmetic check for its slot, every
// model that looks.json names is there, and a model loads once, is shared, and is freed when the last wearer takes it off.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { COSMETIC_LIMITS, checkModel, modelSummary } from "@nano133/nanoterra/model";
import { checkLooks } from "@nano133/nanoterra/looks";
import list from "../looks.json" with { type: "json" };
import { loadedModels, modelsOf, wearModel, type ModelSlot } from "../src/client/game/worn";

const DIR = join(import.meta.dirname, "..", "public", "looks");
const files = readdirSync(DIR).filter((f) => f.endsWith(".glb"));
const LOOKS = checkLooks(list);
/** The slot of each model: the slot that a look names it in (a model in no look is checked as a hand item). */
const slotOf = (name: string): ModelSlot => LOOKS.flatMap((l) => modelsOf(l)).find((m) => m.name === name)?.slot ?? "hand";

/**
 * Rules that a model may fail for now, each with its reason. WAITING FOR A DECISION (2026-10-28): the shovel is 0.52 m wide and hangs 1.0 m
 * below its grip_R, so it is outside the hand zone that the kit's HAND_ITEM gives (0.4 x 0.4 m, from 0.3 m below the grip). Wes chooses a
 * larger hand zone, a smaller shovel, or this exception. Its grip_L (on the T-handle, 0.31 m from grip_R) is outside that zone too. Every
 * other rule (size, triangles, textures, draws, the other markers, motion) holds for it.
 */
const EXCEPTIONS: Record<string, readonly { rule: string; fix: RegExp }[]> = {
  shovel: [
    { rule: "zone", fix: /^Your hand item reaches/ },
    { rule: "markers", fix: /^grip_L stands at .* outside the zone/ },
  ],
};

describe("the looks' models", () => {
  it("public/looks has the models", () => {
    expect(files).toContain("shovel.glb");
  });

  for (const file of files) {
    const name = file.slice(0, -4);
    it(`${file} passes the kit's cosmetic check for its slot (${slotOf(name)})`, () => {
      const bytes = new Uint8Array(readFileSync(join(DIR, file)));
      const r = checkModel(bytes, COSMETIC_LIMITS[slotOf(name)]);
      const allowed = EXCEPTIONS[name] ?? [];
      const left = r.problems.filter((p) => !allowed.some((a) => a.rule === p.rule && a.fix.test(p.fix)));
      expect(left, `${file}: ${modelSummary(r.facts)}`).toEqual([]);
      // An exception must still be needed: when the model or the limits change, it goes.
      for (const a of allowed) expect(r.problems.some((p) => p.rule === a.rule && a.fix.test(p.fix)), `${file}: the exception "${a.rule}" is no longer needed`).toBe(true);
      expect(r.facts.draws).toBeLessThanOrEqual(2);
    });
  }

  it("the shovel: 646 triangles, 1 draw, no texture, its grip_R marker is its attach point", () => {
    const r = checkModel(new Uint8Array(readFileSync(join(DIR, "shovel.glb"))), COSMETIC_LIMITS.hand);
    expect(r.facts.triangles).toBe(646);
    expect(r.facts.draws).toBe(1);
    expect(r.facts.textures).toEqual([]);
    expect(r.facts.anchor?.map((v) => Math.round(v * 1000) / 1000)).toEqual([-0.153, 0.99, 0]);
    expect(r.facts.bytes).toBeLessThan(300 * 1024);
  });

  it("every model that looks.json names is in public/looks", () => {
    for (const look of LOOKS) for (const m of modelsOf(look)) expect(files, `${look.id}: ${m.slot} = ${m.name}`).toContain(`${m.name}.glb`);
  });

  it("modelsOf reads only the three model slots, and only words", () => {
    expect(modelsOf({ slots: { hand: "shovel", back: "#ff0000", wings: "ember", head: "cap" } })).toEqual([
      { slot: "head", name: "cap" },
      { slot: "hand", name: "shovel" },
    ]);
    expect(modelsOf({})).toEqual([]);
  });
});

describe("worn.ts: a model loads once, is shared and is freed", () => {
  const bytes = readFileSync(join(DIR, "shovel.glb"));
  const fetch = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ramp = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);

  it("two wearers share one load and its geometry; the last release frees the geometry and materials, and the ramp stays", async () => {
    let loads = 0;
    const counted = async () => {
      loads++;
      return fetch();
    };
    const [a, b] = await Promise.all([wearModel("shovel", "hand", ramp, { fetch: counted, scale: 1 / 0.9 }), wearModel("shovel", "hand", ramp, { fetch: counted })]);
    expect(loads).toBe(1);
    expect(loadedModels()).toBe(1);
    const meshes = (o: THREE.Object3D) => {
      const out: THREE.Mesh[] = [];
      o.traverse((x) => {
        if ((x as THREE.Mesh).isMesh) out.push(x as THREE.Mesh);
      });
      return out;
    };
    const ma = meshes(a.object);
    const mb = meshes(b.object);
    // The shovel and its ink outline: 2 draws.
    expect(ma.length).toBe(2);
    expect(ma.map((m) => m.geometry)).toEqual(mb.map((m) => m.geometry));
    expect((ma[0]!.material as THREE.Material).type).toBe("MeshToonMaterial");
    expect(a.object.scale.x).toBeCloseTo(1 / 0.9);
    // grip_R is on the holder's origin.
    const grip = a.object.getObjectByName("grip_R")!;
    a.object.updateMatrixWorld(true);
    const at = new THREE.Vector3().setFromMatrixPosition(grip.matrixWorld);
    expect(at.length()).toBeLessThan(1e-6);

    const freed = new Set<unknown>();
    for (const m of ma) {
      m.geometry.addEventListener("dispose", () => freed.add(m.geometry));
      (m.material as THREE.Material).addEventListener("dispose", () => freed.add(m.material));
    }
    let rampFreed = false;
    ramp.addEventListener("dispose", () => (rampFreed = true));
    const holder = new THREE.Group();
    holder.add(a.object, b.object);
    a.release();
    expect(a.object.parent).toBe(null);
    expect(freed.size).toBe(0);
    expect(loadedModels()).toBe(1);
    b.release();
    b.release();
    expect(freed.size).toBe(4);
    expect(loadedModels()).toBe(0);
    expect(rampFreed).toBe(false);
  });

  it("a model that is not there fails, and the next try loads again", async () => {
    await expect(wearModel("nothing", "hand", ramp, { fetch: async () => new ArrayBuffer(8) })).rejects.toThrow();
    expect(loadedModels()).toBe(0);
    const m = await wearModel("shovel", "hand", ramp, { fetch });
    expect(loadedModels()).toBe(1);
    m.release();
    expect(loadedModels()).toBe(0);
  });
});
