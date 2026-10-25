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
  /** The client id that Nanoterra gave this game (the launch page, "Sign in from Nanoterra"). A setting, not a secret. */
  NANOTERRA_CLIENT_ID?: string;
  /** Secret: the client secret that Nanoterra showed once. Add it with `npx wrangler secret put NANOTERRA_SECRET`. */
  NANOTERRA_SECRET?: string;
  /** Tests only: where the exchange goes instead of https://nano133.com. */
  NANOTERRA_ORIGIN?: string;
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

/**
 * An optional setting or secret (NODE_API_KEY, TURNSTILE_SECRET, TURNSTILE_SITE_KEY): its value without spaces
 * around it, or undefined when it is not set. The "Deploy to Cloudflare" setup page needs a value in every
 * field, so "none", "skip", "off" and "-" (in any case) also mean "not set".
 */
export function setting(v?: string): string | undefined {
  const s = (v ?? "").trim();
  return s && !/^(none|skip|off|-)$/i.test(s) ? s : undefined;
}

/** Whether Nanoterra sign-in is set up: the client id and the secret are both set. */
export function nanoterraOn(env: Env): boolean {
  return Boolean(setting(env.NANOTERRA_CLIENT_ID) && setting(env.NANOTERRA_SECRET));
}

export function turnstileOn(env: Env): boolean {
  return Boolean(setting(env.TURNSTILE_SECRET) && setting(env.TURNSTILE_SITE_KEY));
}
