// The player's character: toon shapes, and a look (a body colour and a hat) from looks.json.

import * as THREE from "three";
import type { Look } from "../../shared/looks";
import { toon } from "./world";

export class Character {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly arms: THREE.Mesh[] = [];
  private readonly feet: THREE.Mesh[] = [];
  private readonly hat = new THREE.Group();
  private readonly shadow: THREE.Mesh;
  private readonly bodyMat: THREE.MeshToonMaterial;
  private step = 0;

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
    inner.add(this.body, belly, head, beak, this.hat, ...this.arms, ...this.feet);
    this.group.add(inner);

    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20), new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.22, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
  }

  /** The blob shadow lives in the world (it stays on the ground when the character jumps). */
  get ground(): THREE.Mesh {
    return this.shadow;
  }

  wear(look: Look) {
    this.bodyMat.color.set(look.change.body);
    for (const m of this.hat.children as THREE.Mesh[]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.hat.clear();
    const color = look.change.hatColor ?? "#333333";
    const mat = toon(color, this.ramp);
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, m: THREE.Material = mat) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      this.hat.add(mesh);
      return mesh;
    };
    switch (look.change.hat) {
      case "cap": {
        add(new THREE.SphereGeometry(0.45, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.66, 0).scale.set(1, 0.7, 1);
        add(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 18), 0, 1.68, 0.36).scale.set(1.15, 1, 0.9);
        break;
      }
      case "beanie": {
        add(new THREE.SphereGeometry(0.46, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.62, 0);
        add(new THREE.TorusGeometry(0.42, 0.07, 8, 24), 0, 1.66, 0).rotation.x = Math.PI / 2;
        add(new THREE.SphereGeometry(0.12, 12, 8), 0, 2.1, 0, toon("#ffffff", this.ramp));
        break;
      }
      case "crown": {
        add(new THREE.CylinderGeometry(0.31, 0.29, 0.22, 12), 0, 1.98, 0);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          add(new THREE.ConeGeometry(0.07, 0.2, 6), Math.sin(a) * 0.27, 2.18, Math.cos(a) * 0.27);
        }
        break;
      }
      case "tophat": {
        add(new THREE.CylinderGeometry(0.52, 0.52, 0.05, 24), 0, 1.86, 0);
        add(new THREE.CylinderGeometry(0.3, 0.32, 0.56, 20), 0, 2.15, 0);
        add(new THREE.CylinderGeometry(0.325, 0.325, 0.09, 20), 0, 1.94, 0, toon("#e0457b", this.ramp));
        break;
      }
    }
  }

  /** A waddle while walking, and a stretch in the air. */
  animate(dt: number, speed: number, airborne: boolean) {
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
