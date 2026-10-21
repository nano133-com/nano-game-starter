// A small fake browser for the API tests: it keeps cookies and sends the Origin of the game's own page.

import { handleApi } from "../src/worker/index";
import type { Env } from "../src/worker/env";

export const ORIGIN = "http://game.test";

export class Browser {
  jar = new Map<string, string>();

  async call(env: Env, path: string, o: { method?: string; body?: unknown; origin?: string | null; now?: number } = {}) {
    const headers = new Headers({ "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" });
    const origin = o.origin === undefined ? ORIGIN : o.origin;
    if (origin) headers.set("Origin", origin);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "));
    const method = o.method ?? (o.body === undefined ? "GET" : "POST");
    const req = new Request(`${ORIGIN}${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(o.body ?? {}) });
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

/** The wallet app: no cookies, no Origin. */
export async function walletCall(env: Env, path: string, body?: unknown, now = Date.now()) {
  const req = new Request(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleApi(req, env, now);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
