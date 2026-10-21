// What the Worker gets from Cloudflare: the database, the settings (wrangler.jsonc "vars") and the secrets.

import { validAddress } from "@nano133/signin/verify";

export interface Env {
  DB: D1Database;
  /** The creator's own Nano address: payments go here, and only it can open /admin. */
  RECEIVE_ADDRESS?: string;
  /** "on" keeps test mode even with a real address. */
  TEST_MODE?: string;
  TURNSTILE_SITE_KEY?: string;
  /** Secret. */
  TURNSTILE_SECRET?: string;
  /** Secret: a free Nanswap Nodes API key. Payments are checked there first. */
  NODE_API_KEY?: string;
  /** Optional: public Nano node addresses, separated by commas, instead of the built-in list. */
  NANO_NODES?: string;
}

/** The address that belongs to nobody (its key is all zeros): the example in wrangler.jsonc. */
export const EXAMPLE_ADDRESS = "nano_1111111111111111111111111111111111111111111111111111hifc8npp";

/** The creator's address when it is a real one, else null. */
export function receiveAddress(env: Env): string | null {
  const a = (env.RECEIVE_ADDRESS ?? "").trim().toLowerCase().replace(/^xrb_/, "nano_");
  if (!a || a === EXAMPLE_ADDRESS) return null;
  // validAddress checks the shape and the checksum (from @nano133/signin).
  return validAddress(a) ? a : null;
}

/**
 * Test mode: no real address, or TEST_MODE is "on". Every pay screen then says "TEST MODE: DO NOT PAY" and
 * shows no QR code, no address and no wallet link (the Worker does not even send them).
 */
export function testMode(env: Env): boolean {
  return receiveAddress(env) === null || /^(on|true|1|yes)$/i.test((env.TEST_MODE ?? "").trim());
}

export function turnstileOn(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET?.trim() && env.TURNSTILE_SITE_KEY?.trim());
}
