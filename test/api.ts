// A small fake browser for the API tests: it keeps cookies and sends the Origin of the game's own page.

import { nanoSigninMessage } from "@nano133/signin";
import { handleApi } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Way } from "../src/worker/signin";
import { berryAnswer, nanauthOf, nanchatAnswer, nanoauthItem, nautilusAnswer } from "./helpers";

export const ORIGIN = "http://game.test";

export class Browser {
  jar = new Map<string, string>();
  /** The page's origin: http by default, https to see the `__Host-` cookies. */
  constructor(public base: string = ORIGIN) {}

  async call(env: Env, path: string, o: { method?: string; body?: unknown; origin?: string | null; now?: number } = {}) {
    const headers = new Headers({ "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" });
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
export const walletFrom = { ip: "198.51.100.9" };

/** The wallet app: no cookies, no Origin. */
export async function walletCall(env: Env, path: string, body?: unknown, now = Date.now()) {
  const req = new Request(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": walletFrom.ip }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleApi(req, env, now);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

type Account = { address: string; privateKey: string };

/** Plays wallet app `way` for a request the browser started (`start`): reads it, signs it as `account`, posts the answer. */
export async function walletAnswer(env: Env, way: Way, start: Record<string, any>, account: Account, now = Date.now()) {
  if (way === "nautilus") {
    const item = nanoauthItem(start.link);
    return walletCall(env, item.method.url.slice(ORIGIN.length), nautilusAnswer(item, account, now), now);
  }
  if (way === "nanchat") {
    const { message, url } = nanauthOf(start.link);
    return walletCall(env, url.slice(ORIGIN.length), nanchatAnswer(message, account), now);
  }
  const request = (await walletCall(env, `/api/signin/nano/${start.id}`, undefined, now)).body;
  return walletCall(env, `/api/signin/nano/${start.id}`, berryAnswer(request, account, nanoSigninMessage(request, account.address)), now);
}

/** A new browser, signed in as `account` by wallet app `way`, through the game's own routes. `scope` "admin" makes the /admin login (its own cookie). */
export async function signedInWith(env: Env, way: Way, account: Account, scope: "play" | "admin" = "play", browser = new Browser()) {
  const start = await browser.call(env, "/api/signin/start", { body: { way, scope } });
  if (start.status !== 200) throw new Error(`start: ${start.status} ${JSON.stringify(start.body)}`);
  await walletAnswer(env, way, start.body, account);
  const check = await browser.call(env, "/api/signin/check", { body: { id: start.body.id, way, scope } });
  if (check.body?.status !== "signedin") throw new Error(`check: ${JSON.stringify(check.body)}`);
  return browser;
}
