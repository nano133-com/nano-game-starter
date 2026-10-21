// Test helpers. No real network and no real money: a real D1 database (SQLite in workerd, through
// Miniflare), a mock Nano node on 127.0.0.1, and keys made in each test run.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { ed25519 } from "@noble/curves/ed25519.js";
import { eddsa } from "@noble/curves/abstract/edwards.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import * as nanoNs from "nanocurrency-web";

const MIGRATIONS = ["migrations/0001_init.sql"];

/** A fresh, empty D1 database with the game's tables. */
export async function makeDb(): Promise<{ db: D1Database; close: () => Promise<void> }> {
  // Miniflare 5 (the one in wrangler 4.149) reads its older option form through convertV4MiniflareOptions.
  const mf = new Miniflare(
    convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-10-01", script: "export default { fetch() { return new Response('') } }", d1Databases: { DB: `test-${randomUUID()}` } }),
  );
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const file of MIGRATIONS) {
    const sql = readFileSync(file, "utf8").replace(/--[^\n]*/g, "");
    for (const stmt of sql.split(";")) if (stmt.trim()) await db.prepare(stmt).run();
  }
  return { db, close: () => mf.dispose() };
}

// ---- keys: made fresh in the test, never a real wallet ----

const nanoWeb = ((nanoNs as unknown as { default?: typeof nanoNs }).default ?? nanoNs) as typeof nanoNs;

/** A new random Nano account for this test run only. */
export function testAccount(): { address: string; privateKey: string } {
  const a = nanoWeb.wallet.legacyAccounts(randomBytes(32).toString("hex"), 0, 0)[0]!;
  return { address: a.address, privateKey: a.privateKey };
}

const clamp = (b: Uint8Array) => {
  b[0]! &= 248;
  b[31]! &= 127;
  b[31]! |= 64;
  return b;
};
const nanoEd = eddsa(ed25519.Point, (m: Uint8Array) => blake2b(m, { dkLen: 64 }), { adjustScalarBytes: clamp });

/** Signs bytes as a Nano wallet signs a block hash (Ed25519 with BLAKE2b), the way Berry Wallet signs its sign-in. */
export function signBytes(privateKey: string, bytes: Uint8Array): string {
  return Buffer.from(nanoEd.sign(bytes, Buffer.from(privateKey, "hex"))).toString("hex").toUpperCase();
}

/** What Berry Wallet posts for a request it read: the exact text, signed over its SHA-256. */
export function berryAnswer(request: Record<string, string>, account: { address: string; privateKey: string }, message: string) {
  const digest = new Uint8Array(createHash("sha256").update(message, "utf8").digest());
  return { protocol: "nano-signin-v1", requestId: request.requestId, address: account.address, signatureType: "nano-ed25519-blake2b-sha256", message, signature: signBytes(account.privateKey, digest) };
}

export const hash64 = () => randomBytes(32).toString("hex").toUpperCase();

// ---- a mock Nano node ----

export type Send = { hash: string; from: string; to: string; amount: string; seenMs: number; confirmed: boolean; received?: boolean };
export type NodeMode = "ok" | "down" | "http500" | "error" | "slow" | "garbage";

/** A Nano node on 127.0.0.1 that answers receivable, account_history and block_info from a list of sends. */
export class MockNode {
  server: Server;
  url = "";
  mode: NodeMode = "ok";
  sends: Send[] = [];
  calls: { action: string; headers: IncomingMessage["headers"] }[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const call = JSON.parse(body || "{}");
        this.calls.push({ action: call.action, headers: req.headers });
        if (this.mode === "down") return req.socket.destroy();
        if (this.mode === "slow") return setTimeout(() => res.end("{}"), 3000);
        if (this.mode === "http500") return res.writeHead(500).end("oops");
        if (this.mode === "garbage") return res.writeHead(200).end("<html>");
        res.setHeader("Content-Type", "application/json");
        if (this.mode === "error") return res.end(JSON.stringify({ error: "Internal server error" }));
        res.end(JSON.stringify(this.answer(call)));
      });
    });
  }

  async start() {
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    return this;
  }

  stop() {
    return new Promise<void>((ok) => this.server.close(() => ok()));
  }

  answer(call: Record<string, string>): unknown {
    if (call.action === "receivable") {
      const list = this.sends.filter((s) => s.to === call.account && !s.received && BigInt(s.amount) >= BigInt(call.threshold ?? "1"));
      if (!list.length) return { blocks: "" };
      return { blocks: Object.fromEntries(list.map((s) => [s.hash, call.source === "true" ? { amount: s.amount, source: s.from } : s.amount])) };
    }
    if (call.action === "account_history") {
      const list = this.sends.filter((s) => s.to === call.account && s.received);
      if (!list.length) return { error: "Account not found" };
      return { account: call.account, history: list.map((s) => ({ type: "state", subtype: "receive", account: s.from, amount: s.amount, link: s.hash, hash: hash64(), local_timestamp: String(Math.floor(s.seenMs / 1000) + 5), confirmed: "true" })) };
    }
    if (call.action === "block_info") {
      const s = this.sends.find((x) => x.hash === call.hash);
      if (!s) return { error: "Block not found" };
      return {
        block_account: s.from,
        amount: s.amount,
        local_timestamp: String(Math.floor(s.seenMs / 1000)),
        confirmed: s.confirmed ? "true" : "false",
        subtype: "send",
        contents: { type: "state", account: s.from, link_as_account: s.to },
      };
    }
    return { error: "Unknown command" };
  }
}
