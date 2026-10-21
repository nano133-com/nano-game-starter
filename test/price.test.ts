// The price source: the median of the feeds, and what happens when they fail. Feeds are fake functions here.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFeeds, RATE_FRESH_MS, RATE_LAST_GOOD_MS, usdPerXno, type Fetch } from "../src/worker/price";
import { makeDb } from "./helpers";

let db: D1Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await makeDb()));
afterAll(() => close());
beforeEach(() => db.prepare("DELETE FROM meta").run());

const feeds = [
  { name: "one", url: "https://one.test/", read: (j: any) => j.usd },
  { name: "two", url: "https://two.test/", read: (j: any) => j.usd },
  { name: "three", url: "https://three.test/", read: (j: any) => j.usd },
];
/** A fake fetch: each feed answers this price, or fails when it is null. */
const answering =
  (prices: Record<string, number | null>): Fetch =>
  async (url) => {
    const p = prices[new URL(url).host.split(".")[0]!];
    if (p === null || p === undefined) throw new Error("network down");
    return new Response(JSON.stringify({ usd: p }), { status: 200 });
  };
const T = 1_800_000_000_000;

describe("the price", () => {
  it("is the median, so one wrong feed cannot move it", async () => {
    expect((await readFeeds(answering({ one: 0.9, two: 1.0, three: 75 }), feeds))!.usd).toBe(1.0);
    // Out of the sane range: a broken feed, left out.
    expect((await readFeeds(answering({ one: 0.9, two: 1.1, three: 9999 }), feeds))!.sources).toEqual(["one", "two"]);
  });

  it("is kept for 5 minutes", async () => {
    await usdPerXno(db, answering({ one: 1, two: 1, three: 1 }), T, feeds);
    const kept = await usdPerXno(db, answering({ one: 2, two: 2, three: 2 }), T + RATE_FRESH_MS - 1, feeds);
    expect(kept).toMatchObject({ usd: 1, stale: false });
    const fresh = await usdPerXno(db, answering({ one: 2, two: 2, three: 2 }), T + RATE_FRESH_MS + 1, feeds);
    expect(fresh).toMatchObject({ usd: 2, stale: false });
  });

  it("uses the last good price when every feed fails, for a limited time, then sells nothing", async () => {
    await usdPerXno(db, answering({ one: 1.2, two: 1.2, three: 1.2 }), T, feeds);
    const down = answering({ one: null, two: null, three: null });
    expect(await usdPerXno(db, down, T + 60 * 60_000, feeds)).toMatchObject({ usd: 1.2, stale: true });
    expect(await usdPerXno(db, down, T + RATE_LAST_GOOD_MS + 1, feeds)).toBeNull();
  });

  it("is null when no feed ever answered", async () => {
    expect(await usdPerXno(db, answering({ one: null, two: null, three: null }), T, feeds)).toBeNull();
  });
});
