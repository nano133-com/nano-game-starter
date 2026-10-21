// npm run bench:signin — times one Sign in with Nano check (Berry Wallet's nano-signin-v1) inside workerd,
// the runtime of Cloudflare Workers, on this computer. Workers Free allows 10 ms of CPU per request.
// It starts the bench Worker (bench/wrangler.jsonc) on 127.0.0.1:8793, runs the jobs and stops it again.
// The key is made from a fixed test text: it is nobody's wallet. No network beyond this computer.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { eddsa } from "@noble/curves/abstract/edwards.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { nanoSigninMessage, nanoSigninRequest, signinMessage } from "@nano133/signin";
import * as nanoNs from "nanocurrency-web";

const PORT = 8793;
const URL_ = `http://127.0.0.1:${PORT}/`;
const nanoWeb = nanoNs.default ?? nanoNs;
const clamp = (b) => ((b[0] &= 248), (b[31] &= 127), (b[31] |= 64), b);
const nanoEd = eddsa(ed25519.Point, (m) => blake2b(m, { dkLen: 64 }), { adjustScalarBytes: clamp });

const NOW = 1_800_000_000_000;
const id = "0123456789abcdef0123456789abcdef";
const account = nanoWeb.wallet.legacyAccounts(createHash("sha256").update("nano-game-starter bench key (test only)").digest("hex"), 0, 0)[0];
const request = nanoSigninRequest({ domain: "game.example", uri: "https://game.example/" }, { id, nonce: "b".repeat(64), issuedAt: NOW, expiresAt: NOW + 300_000 }, (i) => `https://game.example/api/signin/nano/${i}`);
const message = nanoSigninMessage(request, account.address);
const digest = new Uint8Array(createHash("sha256").update(message, "utf8").digest());
const berry = { protocol: "nano-signin-v1", requestId: id, address: account.address, signatureType: "nano-ed25519-blake2b-sha256", message, signature: Buffer.from(nanoEd.sign(digest, Buffer.from(account.privateKey, "hex"))).toString("hex").toUpperCase() };
const purse = { address: account.address, at: NOW, signature: nanoWeb.tools.sign(account.privateKey, Buffer.from(signinMessage("game.example", account.address, NOW), "utf8").toString("hex")) };

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function job(n, way = "berry") {
  const t0 = performance.now();
  const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n, way, berry, purse }) });
  const out = await res.json();
  if (out.ok !== n) throw new Error(`a check failed: ${JSON.stringify(out)}`);
  return { wallMs: performance.now() - t0, insideMs: out.insideMs };
}

// `npm run bench:signin -- warm` measures the Worker with the start-up warm-up (src/worker/warm.ts).
const CONFIG = process.argv[2] === "warm" ? "bench/wrangler.warm.jsonc" : "bench/wrangler.jsonc";
const worker = spawn("npx", ["wrangler", "dev", "-c", CONFIG, "--ip", "127.0.0.1", "--port", String(PORT)], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
const stop = () => {
  try {
    process.kill(-worker.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);
try {
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("the bench Worker did not start in 60 s")), 60_000);
    worker.stdout.on("data", (d) => /Ready on/.test(String(d)) && (clearTimeout(timer), ok()));
    worker.on("exit", (code) => fail(new Error(`wrangler stopped (${code})`)));
  });

  const coldEmpty = await job(0); // the first request of a fresh isolate, with no check
  const cold = await job(1); // then the first check: the curve code's first use
  const empty = [];
  const one = [];
  const many = [];
  for (let i = 0; i < 15; i++) empty.push((await job(0)).wallMs);
  for (let i = 0; i < 25; i++) one.push((await job(1)).wallMs);
  for (let i = 0; i < 5; i++) many.push(await job(200));
  const purseMany = [];
  for (let i = 0; i < 5; i++) purseMany.push(await job(200, "purse"));
  const base = median(empty);
  const perManyWall = (median(many.map((m) => m.wallMs)) - base) / 200;
  const perManyInside = median(many.map((m) => m.insideMs)) / 200;
  const perPurse = (median(purseMany.map((m) => m.wallMs)) - base) / 200;
  console.log(
    JSON.stringify(
      {
        worker: CONFIG,
        machine: `${process.platform} ${process.arch}, load ${(await import("node:os")).loadavg().map((x) => x.toFixed(1)).join(" ")}`,
        firstRequestNoCheckWallMs: +coldEmpty.wallMs.toFixed(2),
        berryColdFirstCheck: { wallMs: +(cold.wallMs - base).toFixed(2), insideMs: +cold.insideMs.toFixed(2) },
        berryWarmOneCheck: { wallMs: +(median(one) - base).toFixed(2) },
        berryWarmPerCheckOf200: { wallMs: +perManyWall.toFixed(3), insideMs: +perManyInside.toFixed(3) },
        purseWarmPerCheckOf200: { wallMs: +perPurse.toFixed(3) },
        emptyRequestWallMs: +base.toFixed(2),
      },
      null,
      2,
    ),
  );
} finally {
  stop();
}
