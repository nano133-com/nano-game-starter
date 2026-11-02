// A small fake browser for the API tests: it keeps cookies and sends the Origin of the game's own page.

import { randomBytes } from "node:crypto";
import { nanoSigninMessage } from "@nano133/signin";
import { purseAddress, signinBody } from "@nano133/signin/purse";
import { adminLinkDomain, adminPasskeyDomain } from "@nano133/nanoterra/admin-signin";
import { handleApi } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Way } from "@nano133/nanoterra/player-signin";
import { berryAnswer, nanauthOf, nanchatAnswer, nanoauthItem, nautilusAnswer } from "./helpers";

export const ORIGIN = "http://game.test";

export class Browser {
  jar = new Map<string, string>();
  /** The page's origin: http by default, https to see the `__Host-` cookies. `headers`: more headers on every call of this browser (a country, a browser text). */
  constructor(
    public base: string = ORIGIN,
    public headers: Record<string, string> = {},
  ) {}

  async call(env: Env, path: string, o: { method?: string; body?: unknown; origin?: string | null; now?: number } = {}) {
    const headers = new Headers({ "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...this.headers });
    const origin = o.origin === undefined ? this.base : o.origin;
    if (origin) headers.set("Origin", origin);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "));
    const method = o.method ?? (o.body === undefined ? "GET" : "POST");
    const req = new Request(`${this.base}${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(o.body ?? {}) });
    const res = await handleApi(req, env, o.now ?? Date.now());
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = decodeURIComponent(pair!.slice(i + 1));
      if (/Max-Age=0/.test(c) || !value) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, res };
  }
}

/** Where the wallet app's calls come from. A test that makes many sign-ins moves it, so the wallet route's limit (kept in memory, per visitor) does not stop it. */
export const walletFrom: { ip: string; n?: number } = { ip: "198.51.100.9" };

/** The wallet app: no cookies, no Origin. */
export async function walletCall(env: Env, path: string, body?: unknown, now = Date.now()) {
  const req = new Request(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": walletFrom.ip }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleApi(req, env, now);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

type Account = { address: string; privateKey: string };

/** The two sign-ins' routes: the player's (the package's player sign-in) and the ADMIN's (the package's admin sign-in, on its own fixed route). */
export const SIGNIN = { play: "/api/signin", admin: "/api/admin-signin" } as const;

/** Berry Wallet's route for a request: the path of the `request_uri` in the start's link (the player's or the admin's sign-in). */
export const berryPath = (start: Record<string, any>): string => new URL(new URL(start.link).searchParams.get("request_uri")!).pathname;

/** Plays wallet app `way` for a request the browser started (`start`, from either sign-in): reads it, signs it as `account`, posts the answer. */
export async function walletAnswer(env: Env, way: Way, start: Record<string, any>, account: Account, now = Date.now()) {
  if (way === "nautilus") {
    const item = nanoauthItem(start.link);
    return walletCall(env, item.method.url.slice(ORIGIN.length), nautilusAnswer(item, account, now), now);
  }
  if (way === "nanchat") {
    const { message, url } = nanauthOf(start.link);
    return walletCall(env, url.slice(ORIGIN.length), nanchatAnswer(message, account), now);
  }
  const path = berryPath(start);
  const request = (await walletCall(env, path, undefined, now)).body;
  return walletCall(env, path, berryAnswer(request, account, nanoSigninMessage(request, account.address)), now);
}

/**
 * A new browser, signed in as `account` by wallet app `way`, through the game's own routes. `scope` "admin" makes the /admin login (its own cookie) on the
 * admin's sign-in, /api/admin-signin; "play" the player's, on /api/signin.
 */
export async function signedInWith(env: Env, way: Way, account: Account, scope: "play" | "admin" = "play", browser = new Browser()) {
  const start = await browser.call(env, `${SIGNIN[scope]}/start`, { body: { way } });
  if (start.status !== 200) throw new Error(`start: ${start.status} ${JSON.stringify(start.body)}`);
  await walletAnswer(env, way, start.body, account);
  const check = await browser.call(env, `${SIGNIN[scope]}/check`, { body: { id: start.body.id, way } });
  if (check.body?.status !== "signedin") throw new Error(`check: ${JSON.stringify(check.body)}`);
  return browser;
}

// ---- the owner's passkeys (kit 0.12.0): a passkey purse is a seed; the browser posts its signature of a text (the package's `signinBody`) ----

/** The host every passkey text names: the game's own (the host of ORIGIN). */
export const HOST = new URL(ORIGIN).host;

/** A passkey purse of this test run only: the seed a passkey would give, and its address. Never a real wallet. */
export function testPasskey(): { seed: string; address: string } {
  const seed = randomBytes(32).toString("hex").toUpperCase();
  return { seed, address: purseAddress(seed) };
}

let lastAt = 0;
/** A signing time that no other signature of this run used: each passkey signature counts once, and the signed text holds the time. */
export const freshAt = (now = Date.now()) => (lastAt = Math.max(now, lastAt + 1));

/** What the page posts for each passkey text: the ADMIN sign-in, the LINK, and the PLAYER's sign-in (the host alone). */
export const passkeyBody = {
  admin: (seed: string, at = freshAt()) => signinBody(adminPasskeyDomain(HOST), seed, at),
  link: (seed: string, at = freshAt()) => signinBody(adminLinkDomain(HOST), seed, at),
  player: (seed: string, at = freshAt()) => signinBody(HOST, seed, at),
};

/** Links the passkey of `seed` to the owner with `admin`'s login (it must be the owner's WALLET admin login): the answer of POST /passkey/link. */
export const linkPasskey = (env: Env, admin: Browser, seed: string) => admin.call(env, "/api/admin-signin/passkey/link", { body: passkeyBody.link(seed) });

/** A browser that signs in to /admin with the passkey of `seed` (it must be linked), on the real route POST /api/admin-signin/passkey. */
export async function signedInWithPasskey(env: Env, seed: string, browser = new Browser()) {
  const r = await browser.call(env, "/api/admin-signin/passkey", { body: passkeyBody.admin(seed) });
  if (r.body?.status !== "signedin") throw new Error(`passkey sign-in: ${r.status} ${JSON.stringify(r.body)}`);
  return browser;
}
