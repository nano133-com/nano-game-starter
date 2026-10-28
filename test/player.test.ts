// Which character the page draws (src/client/ui/player.ts). "Off means Off": with sign-in from Nanoterra Off in /admin, every player plays as the island's first character,
// a player who signed in from Nanoterra before the switch went Off included.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nanoterraPlayerOf } from "../src/client/ui/player";
import type { Me } from "../src/client/ui/api";

const LOOK = { skin: "#f2c9a0", hair: "#3b2a1a", shirt: "#4aa8ff", pants: "#2b3a67", shoes: "#222222" };
const fromNanoterra: Me = { address: "nano_1x", owned: [], admin: false, via: "nanoterra", username: "ann", look: LOOK, record: { v: 2, k: [5, 9] } };
const wallet: Me = { address: "nano_1y", owned: [], admin: false, via: "wallet" };
const guest: Me = { address: null, owned: [], admin: false };

describe("which Nanoterra character the page draws", () => {
  it("with sign-in On, a player who signed in from Nanoterra brings the look and the record they picked there", () => {
    expect(nanoterraPlayerOf(fromNanoterra, { nanoterraSignin: true })).toEqual({ look: LOOK, record: { v: 2, k: [5, 9] } });
  });

  it("with sign-in Off, nobody brings a character: the island's first character for every player, a Nanoterra session of before included", () => {
    expect(nanoterraPlayerOf(fromNanoterra, { nanoterraSignin: false })).toBeNull();
    expect(nanoterraPlayerOf(wallet, { nanoterraSignin: false })).toBeNull();
    expect(nanoterraPlayerOf(guest, { nanoterraSignin: false })).toBeNull();
  });

  it("a wallet player and a guest never bring a Nanoterra character, On or Off", () => {
    for (const nanoterraSignin of [true, false, undefined]) {
      expect(nanoterraPlayerOf(wallet, { nanoterraSignin })).toBeNull();
      expect(nanoterraPlayerOf(guest, { nanoterraSignin })).toBeNull();
    }
  });

  it("when the page does not know the switch (the config did not answer), nothing changes", () => {
    expect(nanoterraPlayerOf(fromNanoterra, {})).toEqual({ look: LOOK, record: { v: 2, k: [5, 9] } });
    expect(nanoterraPlayerOf(fromNanoterra, { nanoterraSignin: undefined })).not.toBeNull();
  });

  it("a Nanoterra player whose Nanoterra sent no look and no record still gets a (default) player, not a fault", () => {
    const bare: Me = { address: "nano_1z", owned: [], admin: false, via: "nanoterra" };
    expect(nanoterraPlayerOf(bare, { nanoterraSignin: true })).toEqual({ look: null, record: null });
  });

  it("the page draws through this function and never from the session directly (a pin on src/client/main.ts)", () => {
    const main = readFileSync(new URL("../src/client/main.ts", import.meta.url), "utf8");
    expect(main).toContain("game.setNanoterra(nanoterraPlayerOf(me, config))");
    expect(main).not.toMatch(/setNanoterra\(me\.via/);
  });
});
