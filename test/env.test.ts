// Optional settings and secrets. The "Deploy to Cloudflare" setup page needs a value in every field, so a
// creator who skips one types "none" (or leaves a space): each must mean "not set", never a real key.

import { describe, expect, it } from "vitest";
import { setting, turnstileOn, type Env } from "../src/worker/env";

const env = (o: Partial<Env>) => ({ DB: null as unknown as D1Database, ...o });

describe("an optional setting", () => {
  it("is not set when it is missing, empty, only spaces, or a word that says so", () => {
    for (const v of [undefined, "", " ", "  \t ", "none", "NONE", " None ", "skip", "Skip", "off", "OFF", "-", " - "]) expect(setting(v), JSON.stringify(v)).toBeUndefined();
  });

  it("is the value without spaces around it otherwise", () => {
    expect(setting(" test-key-not-real ")).toBe("test-key-not-real");
    expect(setting("nonesuch-not-real")).toBe("nonesuch-not-real");
    expect(setting("--")).toBe("--");
  });

  it("turns Turnstile on only when both of its keys are set", () => {
    expect(turnstileOn(env({ TURNSTILE_SITE_KEY: "test-site-not-real", TURNSTILE_SECRET: "test-secret-not-real" }))).toBe(true);
    expect(turnstileOn(env({ TURNSTILE_SITE_KEY: "test-site-not-real", TURNSTILE_SECRET: "none" }))).toBe(false);
    expect(turnstileOn(env({ TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET: "test-secret-not-real" }))).toBe(false);
    expect(turnstileOn(env({}))).toBe(false);
  });
});
