// The island: grass, a beach, water, trees, rocks and clouds. Simple shapes with a toon look: no downloaded
// models, so the first load stays small. To change the level, change the lists below.

import * as THREE from "three";

export type Collider = { x: number; z: number; r: number };

/** The player can walk up to this distance from the middle. */
export const ISLAND_RADIUS = 12.4;

/** Three light levels: the "toon" look. */
export function toonRamp(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export const toon = (color: THREE.ColorRepresentation, ramp: THREE.Texture) => new THREE.MeshToonMaterial({ color, gradientMap: ramp });

const TREES: [number, number, number][] = [
  [-6, -5, 1.1],
  [7, -6, 1],
  [-8, 4, 1.25],
  [3, 8, 0.95],
  [9, 3, 1.15],
  [-2, -9.5, 0.9],
  [-10, -1, 0.85],
];
const ROCKS: [number, number, number][] = [
  [4.5, -2.5, 0.9],
  [-4, 6.5, 0.7],
  [10.2, -2.2, 0.6],
  [-7.5, -8, 0.75],
];

export function buildWorld(scene: THREE.Scene, ramp: THREE.Texture): { colliders: Collider[]; update: (t: number) => void } {
  const sky = new THREE.Color("#8fd8ff");
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 34, 80);
  scene.add(new THREE.HemisphereLight("#d9f3ff", "#5b8f4f", 1.25));
  const sun = new THREE.DirectionalLight("#fff1d0", 1.9);
  sun.position.set(8, 14, 6);
  scene.add(sun);

  // Water and the island.
  const water = new THREE.Mesh(new THREE.CircleGeometry(90, 48), toon("#3cb4e6", ramp));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.9;
  scene.add(water);
  const beach = new THREE.Mesh(new THREE.CylinderGeometry(15.2, 15.6, 0.7, 48), toon("#f5dea0", ramp));
  beach.position.y = -0.7;
  scene.add(beach);
  const cliff = new THREE.Mesh(new THREE.CylinderGeometry(13.4, 14.6, 1.6, 40), toon("#c99a62", ramp));
  cliff.position.y = -0.85;
  scene.add(cliff);
  const grass = new THREE.Mesh(new THREE.CylinderGeometry(13.2, 13.4, 0.3, 40), toon("#7ad35a", ramp));
  grass.position.y = -0.15;
  scene.add(grass);

  const colliders: Collider[] = [];
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1.6, 8);
  const leafGeo = new THREE.ConeGeometry(1.25, 2.1, 9);
  const trunkMat = toon("#8a5a33", ramp);
  const leafMat = toon("#2f9e57", ramp);
  const leafMat2 = toon("#45b968", ramp);
  for (const [x, z, s] of TREES) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.8;
    const low = new THREE.Mesh(leafGeo, leafMat);
    low.position.y = 2.2;
    const high = new THREE.Mesh(leafGeo, leafMat2);
    high.position.y = 3.1;
    high.scale.setScalar(0.72);
    tree.add(trunk, low, high);
    tree.position.set(x, 0, z);
    tree.scale.setScalar(s);
    scene.add(tree);
    colliders.push({ x, z, r: 0.55 * s });
  }
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = toon("#9aa3ad", ramp);
  for (const [x, z, s] of ROCKS) {
    const rock = new THREE.Mesh(rockGeo, rockMat);
    rock.position.set(x, 0.25 * s, z);
    rock.scale.set(s, s * 0.75, s);
    rock.rotation.y = x * 1.7;
    scene.add(rock);
    colliders.push({ x, z, r: 0.95 * s });
  }

  // Clouds drift slowly around the island.
  const cloudGeo = new THREE.SphereGeometry(1, 12, 8);
  const cloudMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const clouds = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const c = new THREE.Group();
    for (const [dx, dy, s] of [[0, 0, 1.6], [1.6, -0.2, 1.2], [-1.5, -0.3, 1.1]] as const) {
      const puff = new THREE.Mesh(cloudGeo, cloudMat);
      puff.position.set(dx, dy, 0);
      puff.scale.setScalar(s);
      c.add(puff);
    }
    const a = (i / 6) * Math.PI * 2;
    c.position.set(Math.cos(a) * 34, 11 + (i % 3) * 2.5, Math.sin(a) * 34);
    c.lookAt(0, c.position.y, 0);
    clouds.add(c);
  }
  scene.add(clouds);

  return {
    colliders,
    update: (t: number) => {
      clouds.rotation.y = t * 0.01;
    },
  };
}
