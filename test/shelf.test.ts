import { describe, expect, it } from "vitest";
import { diffLooks, looksJson, type Look } from "@nano133/nanoterra/looks";
import { aiPrompt, centsOf, changeText, ownedIds, shelfStats, soldText } from "../src/shared/shelf";

const look = (id: string, priceUsd = 0.25): Look => ({ id, name: id, priceUsd, change: { body: "#336699" } });

describe("the Shelf's numbers", () => {
  const orders = [
    { lookId: "sunset", status: "paid", usd: "0.25" },
    { lookId: "sunset", status: "paid", usd: "0.25" },
    { lookId: "sunset", status: "paid_late", usd: "0.25" },
    { lookId: "royal", status: "paid", usd: "1.10" },
    { lookId: "royal", status: "open", usd: "1.10" },
    { lookId: "royal", status: "expired", usd: "1.10" },
  ];
  const players = [
    { looks: [{ id: "sunset" }, { id: "royal" }] },
    { looks: [{ id: "sunset" }, { id: "sunset" }] },
    { looks: [] },
  ];

  it("counts paid orders and their dollars, late payments apart, and the players who own a look once each", () => {
    const s = shelfStats(orders, players);
    expect(s.get("sunset")).toEqual({ owners: 2, paid: 2, paidCents: 50, late: 1 });
    expect(s.get("royal")).toEqual({ owners: 1, paid: 1, paidCents: 110, late: 0 });
    expect(s.get("none")).toBeUndefined();
  });

  it("says what a look has done, in plain words", () => {
    const s = shelfStats(orders, players);
    expect(soldText(s.get("sunset"))).toBe("2 sold, $0.50, 2 owners");
    expect(soldText(s.get("royal"))).toBe("1 sold, $1.10, 1 owner");
    expect(soldText(undefined)).toBe("Not sold yet");
    expect(soldText({ owners: 0, paid: 0, paidCents: 0, late: 1 })).toBe("Not sold yet");
  });

  it("reads cents from a dollar text the way the order stores it", () => {
    expect(["0.25", "1.10", "0.07", "1", "0.29", "x"].map(centsOf)).toEqual([25, 110, 7, 100, 29, 0]);
  });

  it("lists every owned look id once", () => {
    expect([...ownedIds(players)].sort()).toEqual(["royal", "sunset"]);
  });
});

describe("the prompt for an AI assistant", () => {
  const before = [look("free", 0), look("a"), look("b")];
  const after = [look("free", 0), { ...look("a"), priceUsd: 0.5 }, look("c")];
  const text = looksJson(after);
  const prompt = aiPrompt(text, diffLooks(before, after), ["a"], before);

  it("holds the new file, the change and the owned ids, and says what must stay", () => {
    expect(changeText(diffLooks(before, after))).toBe("1 added, 1 changed, 1 removed");
    expect(prompt).toContain("The change: 1 added, 1 changed, 1 removed.");
    expect(prompt).toContain('Added: "c".');
    expect(prompt).toContain('Removed: "b".');
    expect(prompt).toContain('Changed: "a".');
    expect(prompt).toContain('must stay in the file with the same id: "a".');
    expect(prompt).toContain(text.trimEnd());
    expect(prompt).toContain("npm run check");
  });

  it("holds no address, no order and no secret", () => {
    expect(prompt).not.toMatch(/nano_[13]/);
    expect(prompt).not.toMatch(/secret|seed|session|cookie/i);
  });

  it("says 'none yet' when no player owns a look", () => {
    expect(aiPrompt(text, diffLooks(before, before), [], before)).toContain("must stay in the file with the same id: none yet.");
  });
});
