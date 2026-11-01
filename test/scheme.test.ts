// The passkey scheme (src/shared/scheme.ts) is FROZEN: a passkey player's account, and so their looks, lies at the address its texts give.
// These two vectors were made once from the scheme and must never change after the first player. When you set your domain in the
// scheme (once, before the first player), this test fails and prints the new seed and address of each vector: write those in, once.

import { checkScheme, schemeVector } from "@nano133/nanoterra/player-signin";
import { describe, expect, it } from "vitest";
import { SCHEME } from "../src/shared/scheme";

const VECTORS = [
  {
    prf: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    seed: "E7597BABA99088604FAE4C1001E534A92AA9F2B081514B0D1CBD438F00B35F0C",
    address: "nano_399eqw1f3fzxw84688g4knk1gz9i1jsbabkshmz5p14aygoaxmozg1msish7",
  },
  {
    prf: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    seed: "09CA85A9F5D20F258675BCAE4954445EA26200FA8F0F9A07B46B864F6484731B",
    address: "nano_35967whhzp5wnou6i8yxi9awjfywf8fbm77rza19xdtnmqqdj1hyfgcrtkhr",
  },
];

describe("the passkey scheme", () => {
  it("is a whole scheme", () => {
    expect(checkScheme(SCHEME)).toBe(SCHEME);
  });

  for (const v of VECTORS) {
    it(`gives the same account as on the first day (PRF ${v.prf.slice(0, 8)}…)`, async () => {
      expect(await schemeVector(SCHEME, v.prf), "the scheme changed: see src/shared/scheme.ts").toEqual({ seed: v.seed, address: v.address });
    });
  }
});
