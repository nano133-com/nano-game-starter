import { describe, expect, it } from "vitest";
import { isClean, isRaw, nanoUri, plusSteps, priceRaw, rawFromSteps, stepsFromUsd, xnoText } from "../src/shared/amount";

const XNO = (s: string) => {
  const [w, f = ""] = s.split(".");
  return (BigInt(w!) * 10n ** 30n + BigInt((f + "0".repeat(30)).slice(0, 30))).toString();
};

describe("clean amounts", () => {
  it("rounds the price UP to 0.0001 XNO, never down", () => {
    expect(xnoText(priceRaw(0.25, 1)!)).toBe("0.25");
    expect(xnoText(priceRaw(0.25, 0.9)!)).toBe("0.2778"); // 0.27777… goes up
    expect(xnoText(priceRaw(1, 3)!)).toBe("0.3334"); // 0.3333… goes up
    expect(xnoText(priceRaw(0.01, 0.5)!)).toBe("0.02"); // float noise (200.00000000000003 steps) adds no step
    expect(xnoText(priceRaw(0.000001, 1)!)).toBe("0.0001"); // the smallest amount is one step
  });

  it("has at most four decimals, so a wallet that shortens amounts still pays it exactly", () => {
    for (const [usd, rate] of [[0.25, 0.8731], [0.5, 1.2345], [1, 0.0712], [9.99, 3.3333], [0.07, 77.7]] as const) {
      const raw = priceRaw(usd, rate)!;
      expect(isClean(raw)).toBe(true);
      expect(raw.endsWith("0".repeat(26))).toBe(true);
      expect((xnoText(raw).split(".")[1] ?? "").length).toBeLessThanOrEqual(4);
      // The creator never gets less than the price.
      expect(Number(xnoText(raw)) * rate).toBeGreaterThanOrEqual(usd - 1e-12);
    }
  });

  it("refuses a price or a rate it cannot trust", () => {
    expect(stepsFromUsd(0, 1)).toBeNull();
    expect(stepsFromUsd(-1, 1)).toBeNull();
    expect(stepsFromUsd(20_000, 1)).toBeNull();
    expect(stepsFromUsd(1, 0.01)).toBeNull(); // below the sane range: a broken feed
    expect(stepsFromUsd(1, 500)).toBeNull();
    expect(stepsFromUsd(1, Number.NaN)).toBeNull();
  });

  it("adds whole steps of 0.0001 XNO with BigInt, never floats", () => {
    expect(xnoText(plusSteps(XNO("0.25"), 1))).toBe("0.2501");
    expect(xnoText(plusSteps(XNO("1"), 99))).toBe("1.0099");
    expect(() => plusSteps("123", 1)).toThrow(); // not a clean amount
    expect(rawFromSteps(1)).toBe("1" + "0".repeat(26));
  });

  it("reads and writes raw amounts strictly", () => {
    expect(isRaw("0")).toBe(false);
    expect(isRaw("01")).toBe(false);
    expect(isRaw("1".repeat(40))).toBe(false);
    expect(isClean(XNO("0.00001"))).toBe(false);
    expect(xnoText("1")).toBe("0.000000000000000000000000000001");
    expect(nanoUri("nano_abc", "2500000000000000000000000000000")).toBe("nano:nano_abc?amount=2500000000000000000000000000000");
  });
});
