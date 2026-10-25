// Small helpers for answers, cookies and hashes. Web APIs only (they run in Workers and in Node tests).

import { securityHeaders } from "../shared/security";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

export const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

/** Adds the security headers to an answer of the Worker, and no-store to every API answer. */
export function secure(res: Response, api: boolean): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(securityHeaders())) if (!out.headers.has(k)) out.headers.set(k, v);
  if (api && !out.headers.has("Cache-Control")) out.headers.set("Cache-Control", "no-store");
  return out;
}

/**
 * True when the browser says the request comes from this game's own pages. A call that changes something
 * (sign-in, an order) must pass this, so another site cannot make a visitor's browser do it.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (origin !== null) return origin === new URL(req.url).origin;
  return req.headers.get("Sec-Fetch-Site") === "same-origin";
}

/** Only a space or a tab around a name or a value is dropped: JS `trim()` also drops U+00A0, U+3000 and other Unicode spaces, which would let a name that a browser sees as another name (" __Host-session") pass for the real one. */
const trimAscii = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");

export function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && trimAscii(part.slice(0, i)) === name) {
      try {
        return decodeURIComponent(trimAscii(part.slice(i + 1)));
      } catch {
        // A value that is not valid percent-coding is not ours: look at the next cookie.
      }
    }
  }
  return null;
}

/** A cookie for this site only. On https it gets the __Host- prefix and Secure. */
export function setCookie(req: Request, name: string, value: string, maxAgeSec: number): string {
  const https = new URL(req.url).protocol === "https:";
  return `${https ? "__Host-" : ""}${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${https ? "; Secure" : ""}`;
}

export function readCookie(req: Request, name: string): string | null {
  return cookie(req, new URL(req.url).protocol === "https:" ? `__Host-${name}` : name);
}

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The visitor's IP address as Cloudflare saw it; an IPv6 address by its /64 (one home network). */
export function visitorIp(req: Request): string {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip;
}

/** True when the request says its body is larger than `maxBytes` (checked before the body is read). */
export const tooLarge = (req: Request, maxBytes = 8192) => Number(req.headers.get("Content-Length") ?? 0) > maxBytes;

export async function readJson(req: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (tooLarge(req, maxBytes)) throw new RangeError("too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new RangeError("too large");
  if (!text) return {};
  const v = JSON.parse(text);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
