// The gems to collect. A plain gem is 1 point; every few gems a gold one comes, worth 5.
// Gem places are random, and that is fine here: rounds are free and win nothing. A look never changes a score.

import * as THREE from "three";
import { ISLAND_RADIUS, toon, type Collider } from "./world";

const PICK_RADIUS = 1.05;

type Gem = { mesh: THREE.Mesh; gold: boolean; pop: number; phase: number };

export class Gems {
  private readonly gems: Gem[] = [];
  private readonly plain: THREE.MeshToonMaterial;
  private readonly golden: THREE.MeshToonMaterial;
  private collected = 0;

  constructor(
    private readonly scene: THREE.Scene,
    ramp: THREE.Texture,
    private readonly colliders: Collider[],
    count: number,
    private readonly goldEvery: number,
  ) {
    this.plain = toon("#3ee6c1", ramp);
    this.plain.emissive.set("#0b6d5a");
    this.golden = toon("#ffd23f", ramp);
    this.golden.emissive.set("#8a5a00");
    const geo = new THREE.OctahedronGeometry(0.36, 0);
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, this.plain);
      scene.add(mesh);
      const gem = { mesh, gold: false, pop: 1, phase: Math.random() * 6 };
      this.gems.push(gem);
      this.place(gem, new THREE.Vector3(0, 0, 0));
    }
  }

  /** Puts all gems in new places for a new round. */
  reset(player: THREE.Vector3) {
    this.collected = 0;
    for (const g of this.gems) {
      g.gold = false;
      g.mesh.material = this.plain;
      this.place(g, player);
    }
  }

  private place(g: Gem, player: THREE.Vector3) {
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * (ISLAND_RADIUS - 1);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - player.x, z - player.z) < 3) continue;
      if (this.colliders.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 0.9)) continue;
      if (this.gems.some((o) => o !== g && Math.hypot(x - o.mesh.position.x, z - o.mesh.position.z) < 1.6)) continue;
      g.mesh.position.set(x, 0.75, z);
      break;
    }
    g.pop = 0;
  }

  /** Spins the gems, and returns the points of the gems the player touches now. */
  update(dt: number, t: number, player: THREE.Vector3): number {
    let points = 0;
    for (const g of this.gems) {
      g.pop = Math.min(1, g.pop + dt * 4);
      const s = (g.gold ? 1.3 : 1) * (1 - Math.pow(1 - g.pop, 3));
      g.mesh.scale.setScalar(s);
      g.mesh.rotation.y = t * 2 + g.phase;
      g.mesh.position.y = 0.75 + Math.sin(t * 3 + g.phase) * 0.12;
      const dx = g.mesh.position.x - player.x;
      const dz = g.mesh.position.z - player.z;
      if (g.pop > 0.5 && dx * dx + dz * dz < PICK_RADIUS * PICK_RADIUS && player.y < 1.6) {
        points += g.gold ? 5 : 1;
        this.collected += 1;
        g.gold = this.collected % this.goldEvery === 0;
        g.mesh.material = g.gold ? this.golden : this.plain;
        this.place(g, player);
      }
    }
    return points;
  }

  dispose() {
    for (const g of this.gems) this.scene.remove(g.mesh);
  }
}
