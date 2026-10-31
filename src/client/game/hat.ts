// The hats of looks.json (`change.hat`: cap, beanie, crown, tophat), built round the middle of a head: the origin is the middle of the
// head, up is +y and the face is toward +z. Both characters wear them (character.ts: the penguin; nanoterraCharacter.ts: the Nanoterra
// character, on its head bone), so a hat is drawn once and sits on either head.

import * as THREE from "three";
import type { Outfit } from "../../shared/looks";
import { toon } from "./world";

/** The hat of a look, or null for a look with none. The caller puts it on a head and frees it with `disposeHat`. */
export function buildHat(look: Outfit, ramp: THREE.Texture): THREE.Group | null {
  if (!look.change.hat) return null;
  const group = new THREE.Group();
  const mat = toon(look.change.hatColor ?? "#333333", ramp);
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, m: THREE.Material = mat) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  switch (look.change.hat) {
    case "cap": {
      add(new THREE.SphereGeometry(0.45, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.14, 0).scale.set(1, 0.7, 1);
      add(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 18), 0, 0.16, 0.36).scale.set(1.15, 1, 0.9);
      break;
    }
    case "beanie": {
      add(new THREE.SphereGeometry(0.46, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.1, 0);
      add(new THREE.TorusGeometry(0.42, 0.07, 8, 24), 0, 0.14, 0).rotation.x = Math.PI / 2;
      add(new THREE.SphereGeometry(0.12, 12, 8), 0, 0.58, 0, toon("#ffffff", ramp));
      break;
    }
    case "crown": {
      add(new THREE.CylinderGeometry(0.31, 0.29, 0.22, 12), 0, 0.46, 0);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        add(new THREE.ConeGeometry(0.07, 0.2, 6), Math.sin(a) * 0.27, 0.66, Math.cos(a) * 0.27);
      }
      break;
    }
    case "tophat": {
      add(new THREE.CylinderGeometry(0.52, 0.52, 0.05, 24), 0, 0.34, 0);
      add(new THREE.CylinderGeometry(0.3, 0.32, 0.56, 20), 0, 0.63, 0);
      add(new THREE.CylinderGeometry(0.325, 0.325, 0.09, 20), 0, 0.42, 0, toon("#e0457b", ramp));
      break;
    }
  }
  return group;
}

/** Frees the geometries and materials of a hat and takes it off its head. */
export function disposeHat(hat: THREE.Object3D | null) {
  if (!hat) return;
  hat.removeFromParent();
  hat.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    (o.material as THREE.Material).dispose();
  });
}
