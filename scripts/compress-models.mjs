#!/usr/bin/env node
// Makes the game's models (.glb in public/) smaller to download: `npm run compress:models`.
//
// Cloudflare does not compress .glb files on the way to the player, so the size on disk is the size a phone downloads.
// This script, for each model:
//   - merges repeated data (dedup) and identical vertices (weld), and orders the triangles for a smaller, faster mesh (reorder);
//   - stores normals and texture coordinates as small whole numbers, and vertex colours as 8-bit (KHR_mesh_quantization).
// Positions stay 32-bit floats and node names, materials and markers (grip_R) stay as they are, so the game and the kit's
// cosmetic check (test/lookModels.test.ts) read the model as before. three.js reads KHR_mesh_quantization by itself: no decoder,
// no WebAssembly, so the Content Security Policy needs no change. (meshopt compression, EXT_meshopt_compression, is smaller still,
// but its decoder needs WebAssembly, which the game's policy does not allow, and the kit's cosmetic check refuses it.)
//
//   npm run compress:models                   every .glb in public/ (a file it already did is left alone)
//   npm run compress:models -- --dry          only print what it would save
//   npm run compress:models -- public/x.glb   one file
//
// Then run `npm test` (every look model must still pass its check) and look at the model in the game.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NodeIO, VertexLayout } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMeshQuantization } from "@gltf-transform/extensions";
import { dedup, quantize, reorder, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
/** Smaller than this share is not worth a change to the file. */
const MIN_GAIN = 0.05;

function glbs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...glbs(p));
    else if (name.toLowerCase().endsWith(".glb")) out.push(p);
  }
  return out;
}

const files = args.filter((a) => !a.startsWith("--")).map((f) => resolve(f));
const list = files.length ? files : glbs(join(ROOT, "public"));
if (!list.length) {
  console.log("No .glb files in public/.");
  process.exit(0);
}

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).setVertexLayout(VertexLayout.SEPARATE);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let saved = 0;

for (const file of list) {
  const name = relative(ROOT, file);
  const bytes = readFileSync(file);
  const doc = await io.readBinary(new Uint8Array(bytes));
  const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  if (used.includes("KHR_mesh_quantization") || used.includes("EXT_meshopt_compression") || used.includes("KHR_draco_mesh_compression")) {
    console.log(`${name}: already compressed, left as it is`);
    continue;
  }
  await doc.transform(
    dedup(),
    weld(),
    reorder({ encoder: MeshoptEncoder, target: "size" }),
    quantize({ pattern: /^(NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+)$/, quantizeNormal: 8, quantizeTexcoord: 12, quantizeColor: 8 }),
  );
  // Byte normals are KHR_mesh_quantization's: name it, so every reader knows (and this script leaves the file alone next time).
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const out = Buffer.from(await io.writeBinary(doc));
  const gain = 1 - out.length / bytes.length;
  if (gain < MIN_GAIN) {
    console.log(`${name}: ${kb(bytes.length)}, would save only ${Math.round(gain * 100)}%, left as it is`);
    continue;
  }
  saved += bytes.length - out.length;
  console.log(`${name}: ${kb(bytes.length)} -> ${kb(out.length)} (${Math.round(gain * 100)}% smaller)${dry ? ", not written (--dry)" : ""}`);
  if (!dry) writeFileSync(file, out);
}
if (saved) console.log(`\n${dry ? "Would save" : "Saved"} ${kb(saved)}. Now run \`npm test\`, and look at each model in the game.`);
