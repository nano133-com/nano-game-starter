// Sign in from Nanoterra (README, "Sign in from Nanoterra"). A player who is signed in at nano133.com and agreed on its card
// presses Play and arrives at GET /nanoterra/callback?code=... on THIS site. The browser carries only that one-time code (60
// seconds, used once). This Worker trades it for the player's details with a call from the server, with its client id and its
// client secret (NANOTERRA_SECRET), and makes its own session for the address that Nanoterra named.
//
// The callback does NOT sign the player in by itself. Anyone can send a victim a callback link that holds the attacker's own
// code, and a victim who opens it would land signed in as the attacker (login CSRF). So the callback only shows a screen:
// "Sign in as <name>? Continue / Not me". A session is made only when the player presses Continue (POST /nanoterra/confirm),
// and that press must carry the cookie the callback set in THIS browser (signed, 5 minutes, SameSite=Lax: another site's
// form cannot send it) from the same origin. "Not me" (POST /nanoterra/cancel) drops the cookie.
//
// What this proves: Nanoterra says this player is signed in there and agreed to this game. It proves no key and no payment, so
// a session made here (`via: "nanoterra"`) never opens /admin (admin.ts). The secret stays in the Worker: never put it in a
// page, a log or a message. DO NOT CHANGE the checks in this file.

import { validAddress } from "@nano133/signin/verify";
import { nanoterraOn, setting, type Env } from "./env";
import { json, readCookie, sameOrigin, setCookie } from "./http";
import { memoryLimit } from "./ratelimit";
import { createSession, SESSION_DAYS } from "./signin";

const NANOTERRA = "https://nano133.com";
/** A code is 32 random bytes in base64url. */
const CODE = /^[A-Za-z0-9_-]{43}$/;
const LOOK_PARTS = ["skin", "hair", "shirt", "pants", "shoes"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ANSWER_MAX = 4096;
const CALLBACK_LIMIT = { limit: 20, windowMs: 60_000 };
/** The cookie that waits for the player's Continue, and how long it lives (the player has 5 minutes to press it). */
const PENDING_COOKIE = "nanoterra-pending";
const PENDING_SECONDS = 300;
/** Put in front of what is signed, so a signature made here is good for nothing else. */
const PENDING_LABEL = "nano-game-starter: a Nanoterra sign-in waits for Continue, v1";
const text = new TextEncoder();

export type Look = Record<(typeof LOOK_PARTS)[number], string>;
/** What Nanoterra sends for a signed-in player. `playerId` is the address now: use the address. */
export type Player = { username: string; address: string; look: Look; items: string[] };

/** The answer of Nanoterra's token call, read strictly: anything of another shape is null. */
export function readPlayer(v: unknown): Player | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const { username, address, playerId, character } = o as { username?: unknown; address?: unknown; playerId?: unknown; character?: unknown };
  if (typeof username !== "string" || !username.trim() || username.length > 60) return null;
  if (typeof address !== "string" || !validAddress(address) || playerId !== address) return null;
  const c = character as { v?: unknown; look?: unknown; items?: unknown } | null;
  if (!c || c.v !== 1 || !c.look || typeof c.look !== "object" || !Array.isArray(c.items)) return null;
  const look = {} as Look;
  for (const part of LOOK_PARTS) {
    const colour = (c.look as Record<string, unknown>)[part];
    if (typeof colour !== "string" || !HEX.test(colour)) return null;
    look[part] = colour;
  }
  const items = c.items.slice(0, 64).filter((id): id is string => typeof id === "string" && id.length <= 48 && /^[a-z0-9.-]+$/.test(id));
  return { username: username.trim(), address, look, items };
}

/** Trades the code for the player's details: one call from this server. Null for every refusal and every fault. */
export async function exchangeCode(env: Env, code: string, fetcher: typeof fetch = fetch): Promise<Player | null> {
  const origin = setting(env.NANOTERRA_ORIGIN) ?? NANOTERRA;
  try {
    const res = await fetcher(`${origin}/api/nanoterra/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: setting(env.NANOTERRA_CLIENT_ID), client_secret: setting(env.NANOTERRA_SECRET), code }),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) {
      console.warn("Nanoterra sign-in: the exchange was refused", res.status);
      return null;
    }
    const text = await res.text();
    if (text.length > ANSWER_MAX) return null;
    return readPlayer(JSON.parse(text));
  } catch {
    console.warn("Nanoterra sign-in: the exchange failed");
    return null;
  }
}

/** A plain page for a sign-in that did not work, with a way into the game as a guest. */
function page(status: number, title: string, words: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/nanoterra.css"><title>${title}</title><h1>${title}</h1><p>${words}</p><p><a href="/">Play as a guest</a></p>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (v: string) => Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const pendingKey = (env: Env, usage: ("sign" | "verify")[]) => crypto.subtle.importKey("raw", text.encode(setting(env.NANOTERRA_SECRET) ?? ""), { name: "HMAC", hash: "SHA-256" }, false, usage);

/** The cookie value that waits for Continue: the address that Nanoterra named and a deadline, signed with a key made from the secret. */
export async function pendingToken(env: Env, address: string, now: number): Promise<string> {
  const payload = b64url(text.encode(JSON.stringify({ a: address, exp: now + PENDING_SECONDS * 1000 })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await pendingKey(env, ["sign"]), text.encode(`${PENDING_LABEL}\n${payload}`)));
  return `${payload}.${b64url(sig)}`;
}

/** The address in this browser's pending cookie, if the cookie is signed with this game's secret and has not run out; null for anything else. */
export async function pendingAddress(env: Env, req: Request, now: number): Promise<string | null> {
  const token = readCookie(req, PENDING_COOKIE);
  if (!token || token.length > 512) return null;
  const [payload, sig, more] = token.split(".");
  if (!payload || !sig || more !== undefined) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await pendingKey(env, ["verify"]), unb64url(sig), text.encode(`${PENDING_LABEL}\n${payload}`)))) return null;
    const v = JSON.parse(new TextDecoder().decode(unb64url(payload))) as { a?: unknown; exp?: unknown };
    if (typeof v.a !== "string" || !validAddress(v.a) || typeof v.exp !== "number" || v.exp < now) return null;
    return v.a;
  } catch {
    return null;
  }
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** An address as the player can compare it: the start and the end. */
const shortAddress = (a: string) => `${a.slice(0, 11)}\u2026${a.slice(-6)}`;

/** The screen between the callback and the session. The name comes from another site: it is escaped. */
function confirmPage(req: Request, player: Player, token: string): Response {
  const name = escapeHtml(player.username);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="stylesheet" href="/nanoterra.css"><title>Sign in as ${name}?</title><h1>Sign in as ${name}?</h1><p>Nanoterra says you are <strong>${name}</strong>, with the address <code>${shortAddress(player.address)}</code>.</p><p>Press <strong>Continue</strong> only if you just pressed Play in Nanoterra yourself. If someone sent you this link, press <strong>Not me</strong>.</p><form method="post" action="/nanoterra/confirm"><button type="submit" class="primary">Continue as ${name}</button></form><form method="post" action="/nanoterra/cancel"><button type="submit">Not me</button></form>`;
  // "same-origin", not "no-referrer": with no-referrer a browser sends `Origin: null` on the form's POST, and confirm() would refuse
  // the player's own press. Another site still gets no Referer from this page, and its own POST here still carries its own Origin.
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin" });
  headers.append("Set-Cookie", setCookie(req, PENDING_COOKIE, token, PENDING_SECONDS));
  return new Response(html, { status: 200, headers });
}

/**
 * GET /nanoterra/callback?code=...: trades the code for the player's details, keeps them, and shows the confirm screen with a
 * cookie that waits for Continue. It makes NO session. A bad or missing code is a 400 page, an unfinished setup a 503 page: each
 * with a link to play as a guest.
 */
export async function callback(env: Env, req: Request, ip: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Not allowed." }, 405, { Allow: "GET" });
  if (!nanoterraOn(env)) return page(503, "Nanoterra sign-in is not set up", "This game has not finished setting up sign-in from Nanoterra yet.");
  if (!memoryLimit(`nanoterra|${ip}`, CALLBACK_LIMIT.limit, CALLBACK_LIMIT.windowMs, now)) return page(429, "Too many tries", "Wait a minute, then press Play in Nanoterra again.");
  const code = new URL(req.url).searchParams.get("code") ?? "";
  if (!CODE.test(code)) return page(400, "That sign-in did not work", "The sign-in code is missing or not valid. Press Play in Nanoterra again.");
  const player = await exchangeCode(env, code, fetcher);
  if (!player) return page(400, "That sign-in did not work", "The sign-in code was refused or has run out. Press Play in Nanoterra again.");
  // What Nanoterra says about this address is kept now (it is that address's own data, and the exchange proved the code and the secret).
  await env.DB.prepare(
    "INSERT INTO nanoterra_players (address, username, look, items, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET username = excluded.username, look = excluded.look, items = excluded.items, updated_at = excluded.updated_at",
  )
    .bind(player.address, player.username, JSON.stringify(player.look), JSON.stringify(player.items), now)
    .run();
  return confirmPage(req, player, await pendingToken(env, player.address, now));
}

/**
 * POST /nanoterra/confirm: the player pressed Continue. Needs the pending cookie of THIS browser (signed, not run out) and a
 * request from this game's own page. Makes the session and drops the pending cookie.
 */
export async function confirm(env: Env, req: Request, ip: string, now = Date.now()): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Not allowed." }, 405, { Allow: "POST" });
  if (!nanoterraOn(env)) return page(503, "Nanoterra sign-in is not set up", "This game has not finished setting up sign-in from Nanoterra yet.");
  if (!sameOrigin(req)) return page(403, "That sign-in did not work", "The request did not come from this game's own page. Press Play in Nanoterra again.");
  if (!memoryLimit(`nanoterra-confirm|${ip}`, CALLBACK_LIMIT.limit, CALLBACK_LIMIT.windowMs, now)) return page(429, "Too many tries", "Wait a minute, then press Play in Nanoterra again.");
  const address = await pendingAddress(env, req, now);
  if (!address) return page(400, "That sign-in has run out", "It is more than 5 minutes since you pressed Play, or it did not start in this browser. Press Play in Nanoterra again.");
  const token = await createSession(env.DB, address, now, "nanoterra");
  const headers = new Headers({ Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", setCookie(req, "session", token, SESSION_DAYS * 86400));
  headers.append("Set-Cookie", setCookie(req, PENDING_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}

/** POST /nanoterra/cancel: the player pressed "Not me". Drops the pending cookie, makes no session, and goes to the game as a guest. */
export function cancel(req: Request): Response {
  if (req.method !== "POST") return json({ error: "Not allowed." }, 405, { Allow: "POST" });
  const headers = new Headers({ Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", setCookie(req, PENDING_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}

/** The name and the character kept from the player's last Nanoterra sign-in, for the game's own screens (`/api/me`). */
export async function playerOf(db: D1Database, address: string): Promise<{ username: string; look: Look; items: string[] } | null> {
  const row = await db.prepare("SELECT username, look, items FROM nanoterra_players WHERE address = ?").bind(address).first<{ username: string; look: string; items: string }>();
  if (!row) return null;
  try {
    return { username: row.username, look: JSON.parse(row.look) as Look, items: JSON.parse(row.items) as string[] };
  } catch {
    return null;
  }
}
