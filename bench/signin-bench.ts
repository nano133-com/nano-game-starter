// Times one Berry Wallet sign-in check (answerNanoSignin from @nano133/signin: the exact text, SHA-256,
// Ed25519-BLAKE2b verify, the address checksum) inside workerd. The key is made from a fixed test text: it is
// nobody's wallet. A POSTed job runs the check n times in one request and reports the time.
//
// Workers Free allows 10 ms of CPU per request. The Worker's clock may stand still during pure computation
// (a Spectre defence), so bench/run.mjs also times the requests from outside: n=0 against n=1 and n=200.

import { answerNanoSignin, checkSignatureSignin, type NanoSigninOptions } from "@nano133/signin";
import { memoryOnce, memoryRequests } from "@nano133/signin/memory";

const NOW = 1_800_000_000_000;
const id = "0123456789abcdef0123456789abcdef";
const requestUrl = (i: string) => `https://game.example/api/signin/nano/${i}`;

// The signed answers come from bench/run.mjs (signed in Node), so nothing in this Worker warms the curve
// code before the first timed check: the first request measures a cold check.
type Job = { n: number; way: "berry" | "purse"; berry: Record<string, unknown>; purse: { address: string; at: number; signature: string } };

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("POST a job", { status: 405 });
    const job = (await req.json()) as Job;
    const store = memoryRequests();
    await store.create(id, { id, starter: "a".repeat(64), status: "waiting", expiresAt: NOW + 300_000, nonce: "b".repeat(64), issuedAt: NOW });
    const options: NanoSigninOptions = { domain: "game.example", uri: "https://game.example/", store, now: () => NOW };
    const t0 = performance.now();
    let ok = 0;
    for (let i = 0; i < job.n; i++) {
      if (job.way === "berry") ok += (await answerNanoSignin(options, id, job.berry, requestUrl)) === job.berry.address ? 1 : 0;
      else ok += (await checkSignatureSignin({ domain: "game.example", useOnce: memoryOnce(), now: () => NOW }, job.purse)) === job.purse.address ? 1 : 0;
    }
    const ms = performance.now() - t0;
    return Response.json({ way: job.way, n: job.n, ok, insideMs: ms });
  },
};
