// Times one sign-in check of each way inside workerd: Berry Wallet (answerNanoSignin: the exact text, SHA-256,
// Ed25519-BLAKE2b verify, the address checksum), Nautilus (answerNautilus: the same verify over the text's bytes),
// NanChat (answerNanchat: the wallet library's verify of a text) and a purse (checkSignatureSignin: the same library
// verify). The key is made from a fixed test text: it is nobody's wallet. A POSTed job runs the check n times in one
// request and reports the time.
//
// Workers Free allows 10 ms of CPU per request. The Worker's clock may stand still during pure computation
// (a Spectre defence), so bench/run.mjs also times the requests from outside: n=0 against n=1 and n=200.

import { answerNanchat, answerNanoSignin, answerNautilus, checkSignatureSignin, nanchatKey, type NanoSigninOptions } from "@nano133/signin";
import { memoryOnce, memoryRequests } from "@nano133/signin/memory";

const NOW = 1_800_000_000_000;
const id = "0123456789abcdef0123456789abcdef";
const appId = "abcdefghijklmnopqrstuvwx"; // a Nautilus or NanChat request's id: 24 base64url characters
const starter = "a".repeat(64);
const requestUrl = (i: string) => `https://game.example/api/signin/nano/${i}`;

// The signed answers come from bench/run.mjs (signed in Node), so nothing in this Worker warms the curve
// code before the first timed check: the first request measures a cold check.
type Way = "berry" | "purse" | "nautilus" | "nanchat";
type Job = {
  n: number;
  way: Way;
  berry: Record<string, unknown>;
  purse: { address: string; at: number; signature: string };
  nautilus: { body: Record<string, unknown>; site: string; label: string };
  nanchat: { body: Record<string, unknown>; nonce: string };
};

/** One check of `job.way`; true when it signed in the expected account. Nautilus and NanChat take one answer per request, so each check gets a new request. */
async function once(job: Job, options: NanoSigninOptions): Promise<boolean> {
  if (job.way === "berry") return (await answerNanoSignin(options, id, job.berry, requestUrl)) === job.berry.address;
  if (job.way === "purse") return (await checkSignatureSignin({ domain: "game.example", useOnce: memoryOnce(), now: () => NOW }, job.purse)) === job.purse.address;
  const store = memoryRequests();
  if (job.way === "nautilus") {
    await store.create(appId, { id: appId, starter, status: "waiting", expiresAt: NOW + 300_000, label: job.nautilus.label });
    return (await answerNautilus({ site: "game.example", siteAddress: job.nautilus.site, store, now: () => NOW }, appId, job.nautilus.body)) === job.nautilus.body.account;
  }
  await store.create(nanchatKey(job.nanchat.nonce), { id: appId, starter, status: "waiting", expiresAt: NOW + 300_000 });
  return (await answerNanchat({ host: "game.example", store, now: () => NOW }, job.nanchat.body)) === job.nanchat.body.account;
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("POST a job", { status: 405 });
    const job = (await req.json()) as Job;
    const store = memoryRequests();
    await store.create(id, { id, starter, status: "waiting", expiresAt: NOW + 300_000, nonce: "b".repeat(64), issuedAt: NOW });
    const options: NanoSigninOptions = { domain: "game.example", uri: "https://game.example/", store, now: () => NOW };
    const t0 = performance.now();
    let ok = 0;
    for (let i = 0; i < job.n; i++) ok += (await once(job, options)) ? 1 : 0;
    const ms = performance.now() - t0;
    return Response.json({ way: job.way, n: job.n, ok, insideMs: ms });
  },
};
