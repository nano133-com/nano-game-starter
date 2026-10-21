// Node failover, against mock nodes on 127.0.0.1. No real network.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forgetNodeHealth, KEYED_NODE, NodeDown, nodesFor, PUBLIC_NODES, rpc } from "../src/worker/nodes";
import { MockNode, type NodeMode } from "./helpers";

const a = new MockNode();
const b = new MockNode();
const c = new MockNode();
beforeAll(async () => {
  await Promise.all([a.start(), b.start(), c.start()]);
});
afterAll(async () => {
  await Promise.all([a.stop(), b.stop(), c.stop()]);
});
beforeEach(() => {
  forgetNodeHealth();
  for (const n of [a, b, c]) (n.mode = "ok"), (n.calls = []);
});

const list = () => [
  { name: "a", url: a.url, headers: { "nodes-api-key": "test-key-not-real" } },
  { name: "b", url: b.url },
  { name: "c", url: c.url },
];
const call = { action: "receivable", account: "nano_x", count: "50", threshold: "1", source: "true" };

describe("node failover", () => {
  for (const mode of ["down", "http500", "error", "slow", "garbage"] as NodeMode[]) {
    it(`asks the next node when the first one is ${mode}`, async () => {
      a.mode = mode;
      const r = await rpc(list(), call, { timeoutMs: 500 });
      expect(r.node).toBe("b");
      expect(r.answer).toEqual({ blocks: "" });
    });
  }

  it("goes down the whole list, and throws when no node answers", async () => {
    a.mode = "down";
    b.mode = "http500";
    expect((await rpc(list(), call, { timeoutMs: 500 })).node).toBe("c");
    forgetNodeHealth();
    c.mode = "error";
    await expect(rpc(list(), call, { timeoutMs: 500 })).rejects.toBeInstanceOf(NodeDown);
  });

  it('takes "not found" as a real answer (no failover): an account with no history', async () => {
    const r = await rpc(list(), { action: "account_history", account: "nano_x", count: "50", raw: "true" });
    expect(r).toEqual({ node: "a", answer: null });
    expect(b.calls).toHaveLength(0);
  });

  it("asks a node that just failed last, for a while", async () => {
    a.mode = "down";
    await rpc(list(), call, { timeoutMs: 500 });
    a.mode = "ok";
    a.calls = [];
    expect((await rpc(list(), call)).node).toBe("b");
    expect(a.calls).toHaveLength(0);
  });

  it("sends the API key only to the keyed node", async () => {
    a.mode = "down";
    await rpc(list(), call, { timeoutMs: 500 });
    expect(a.calls[0]!.headers["nodes-api-key"]).toBe("test-key-not-real");
    expect(b.calls[0]!.headers["nodes-api-key"]).toBeUndefined();
  });
});

describe("the node list", () => {
  it("puts the keyed provider first only when its secret is set, and never writes a key in the code", () => {
    expect(nodesFor({})).toEqual(PUBLIC_NODES);
    const withKey = nodesFor({ NODE_API_KEY: " k-from-secret " });
    expect(withKey[0]).toEqual({ name: KEYED_NODE.name, url: KEYED_NODE.url, headers: { [KEYED_NODE.keyHeader]: "k-from-secret" } });
    expect(withKey.slice(1)).toEqual(PUBLIC_NODES);
    expect(PUBLIC_NODES.every((n) => !n.headers)).toBe(true);
  });

  it("takes the creator's own list: https, or http only on this computer", () => {
    const own = nodesFor({ NANO_NODES: "https://node.example.com/rpc, http://evil.example.com, http://127.0.0.1:8792, ftp://x" });
    expect(own.map((n) => n.url)).toEqual(["https://node.example.com/rpc", "http://127.0.0.1:8792"]);
  });
});
