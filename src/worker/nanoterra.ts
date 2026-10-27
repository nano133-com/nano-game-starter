// Sign in from Nanoterra (README, "Sign in from Nanoterra"). A player who is signed in at nano133.com and agreed on its card
// presses Play and arrives at GET /nanoterra/start on THIS site. The start route makes a STATE (random text), keeps it in a cookie of
// THIS browser and sends the browser to nano133.com's authorize address with the client id and the state. Nanoterra answers with a
// redirect to GET /nanoterra/callback?code=...&state=... (the code is good for 60 seconds, once, and was made for that state). The
// callback accepts the state ONLY when it equals this browser's cookie: a link that someone else made carries a state that is not in
// the victim's cookie, so it is refused before anything is traded (login CSRF). The Worker then trades the code for the player's
// details with a call from the server, with its client id, its client secret (NANOTERRA_SECRET) and the state, and makes its own
// session for the address that Nanoterra named. The state cookie works once: every answer of the callback after the state matched drops it.
//
// The callback does NOT sign the player in by itself. Anyone can send a victim a callback link that holds the attacker's own
// code, and a victim who opens it would land signed in as the attacker (login CSRF). So the callback only shows a screen:
// "Sign in as <name>? Continue / Not me". A session is made only when the player presses Continue (POST /nanoterra/confirm),
// and that press must carry the cookie the callback set in THIS browser (signed, 5 minutes, SameSite=Lax: another site's
// form cannot send it) from the same origin, and the `bind` field of THIS screen (so a second callback that replaced the cookie
// after the screen was drawn is not signed in by the press on the old screen). A pending cookie works once. "Not me"
// (POST /nanoterra/cancel) drops the cookie and uses the token up.
//
// What this proves: Nanoterra says this player is signed in there and agreed to this game. It proves no key and no payment, so
// a session made here (`via: "nanoterra"`) never opens /admin (admin.ts). The secret stays in the Worker: never put it in a
// page, a log or a message. DO NOT CHANGE the checks in this file.

import { unpackRecord } from "@nano133/nanoterra/character/record";
import { validAddress } from "@nano133/signin/verify";
import { nanoterraOn, setting, type Env } from "./env";
import { json, randomHex, readCookie, sameOrigin, setCookie, sha256Hex, tooLarge } from "./http";
import { d1Limit, LIMITS, memoryLimit } from "./ratelimit";
import { createSession, SESSION_DAYS } from "./signin";

const NANOTERRA = "https://nano133.com";
/** A code is 32 random bytes in base64url. */
const CODE = /^[A-Za-z0-9_-]{43}$/;
const LOOK_PARTS = ["skin", "hair", "shirt", "pants", "shoes"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ANSWER_MAX = 4096;
const CALLBACK_LIMIT = { limit: 20, windowMs: 60_000 };
/** The cookie that holds the state this browser started with, and how long the player has to come back (10 minutes). */
const STATE_COOKIE = "nanoterra-state";
const STATE_SECONDS = 600;
/** A state is random text of our own making, or the same shape from Nanoterra's redirect: 16 to 128 letters, digits, "-" or "_". */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** The cookie that waits for the player's Continue, and how long it lives (the player has 5 minutes to press it). */
const PENDING_COOKIE = "nanoterra-pending";
const PENDING_SECONDS = 300;
/** A pending cookie is used once: its id is counted in D1 (`hits`, cleared by the sweep in this window's unit) in the window of its own deadline. */
const ONCE_WINDOW_MS = LIMITS.order.windowMs;
/** Put in front of what is signed, so a signature made here is good for nothing else. */
const PENDING_LABEL = "nano-game-starter: a Nanoterra sign-in waits for Continue, v1";
const text = new TextEncoder();

export type Look = Record<(typeof LOOK_PARTS)[number], string>;
/** The player's whole character as Nanoterra sends it: the two numbers of `packRecord`, each a whole number on the closed lists (`unpackRecord` reads them). */
export type PackedRecord = [number, number];
/** What Nanoterra sends for a signed-in player. `playerId` is the address now: use the address. `record`: null for a sign-in from before Nanoterra sent it, or one that is not whole. */
export type Player = { username: string; address: string; look: Look; record: PackedRecord | null; items: string[] };

/** The answer of Nanoterra's token call, read strictly: anything of another shape is null. */
export function readPlayer(v: unknown): Player | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const { username, address, playerId, character } = o as { username?: unknown; address?: unknown; playerId?: unknown; character?: unknown };
  if (typeof username !== "string" || !username.trim() || username.length > 60) return null;
  if (typeof address !== "string" || !validAddress(address) || playerId !== address) return null;
  const c = character as { v?: unknown; look?: unknown; record?: unknown; items?: unknown } | null;
  if (!c || c.v !== 1 || !c.look || typeof c.look !== "object" || !Array.isArray(c.items)) return null;
  const look = {} as Look;
  for (const part of LOOK_PARTS) {
    const colour = (c.look as Record<string, unknown>)[part];
    if (typeof colour !== "string" || !HEX.test(colour)) return null;
    look[part] = colour;
  }
  const items = c.items.slice(0, 64).filter((id): id is string => typeof id === "string" && id.length <= 48 && /^[a-z0-9.-]+$/.test(id));
  return { username: username.trim(), address, look, record: packedOf(c.record), items };
}

/** The character's record from Nanoterra's `{ v: 2, k: [a, b] }`, or null when it is not there or not whole (the game then uses the five colours): never trusted without the lists. */
export function packedOf(record: unknown): PackedRecord | null {
  const r = record as { v?: unknown; k?: unknown } | null;
  if (!r || typeof r !== "object" || r.v !== 2 || !Array.isArray(r.k) || r.k.length !== 2) return null;
  return unpackRecord(r.k[0], r.k[1]) ? [r.k[0] as number, r.k[1] as number] : null;
}

/** Trades the code for the player's details: one call from this server. Null for every refusal and every fault. */
export async function exchangeCode(env: Env, code: string, state: string, fetcher: typeof fetch = fetch): Promise<Player | null> {
  const origin = setting(env.NANOTERRA_ORIGIN) ?? NANOTERRA;
  try {
    const res = await fetcher(`${origin}/api/nanoterra/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: setting(env.NANOTERRA_CLIENT_ID), client_secret: setting(env.NANOTERRA_SECRET), code, state }),
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
function page(status: number, title: string, words: string, cookies: string[] = []): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/nanoterra.css"><title>${title}</title><h1>${title}</h1><p>${words}</p><p><a href="/">Play as a guest</a></p>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(html, { status, headers });
}

/** True when the two texts are the same: their hashes are compared with no early exit, so the time says nothing about where they differ. */
async function sameText(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * GET /nanoterra/start: where Nanoterra's Play key sends the player. It makes a STATE, keeps it in a cookie of THIS browser (HttpOnly,
 * SameSite=Lax, 10 minutes) and redirects to nano133.com's authorize address with the client id and the state. A new start in this
 * browser replaces the cookie, and only the last state can come back.
 */
export function start(env: Env, req: Request, ip: string, now = Date.now()): Response {
  if (req.method !== "GET") return json({ error: "Not allowed." }, 405, { Allow: "GET" });
  if (!nanoterraOn(env)) return page(503, "Nanoterra sign-in is not set up", "This game has not finished setting up sign-in from Nanoterra yet.");
  if (!memoryLimit(`nanoterra-start|${ip}`, CALLBACK_LIMIT.limit, CALLBACK_LIMIT.windowMs, now)) return page(429, "Too many tries", "Wait a minute, then press Play in Nanoterra again.");
  const state = randomHex(16);
  const to = new URL("/api/nanoterra/authorize", setting(env.NANOTERRA_ORIGIN) ?? NANOTERRA);
  to.searchParams.set("client_id", setting(env.NANOTERRA_CLIENT_ID)!);
  to.searchParams.set("state", state);
  const headers = new Headers({ Location: to.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", setCookie(req, STATE_COOKIE, state, STATE_SECONDS));
  return new Response(null, { status: 302, headers });
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (v: string) => Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const pendingKey = (env: Env, usage: ("sign" | "verify")[]) => crypto.subtle.importKey("raw", text.encode(setting(env.NANOTERRA_SECRET) ?? ""), { name: "HMAC", hash: "SHA-256" }, false, usage);

/** The cookie value that waits for Continue: the address that Nanoterra named, a deadline and an id, signed with a key made from the secret. */
export async function pendingToken(env: Env, address: string, now: number): Promise<string> {
  const payload = b64url(text.encode(JSON.stringify({ a: address, exp: now + PENDING_SECONDS * 1000, j: randomHex(12) })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await pendingKey(env, ["sign"]), text.encode(`${PENDING_LABEL}\n${payload}`)));
  return `${payload}.${b64url(sig)}`;
}

/** The field of the confirm screen that ties a press to the cookie the screen was made with. It is a hash: the token itself never goes into the page. */
export const bindOf = async (token: string): Promise<string> => (await sha256Hex(token)).slice(0, 32);

export type Pending = { address: string; id: string; exp: number; token: string };

/** This browser's pending cookie, if it is signed with this game's secret and has not run out; null for anything else. */
export async function readPending(env: Env, req: Request, now: number): Promise<Pending | null> {
  const token = readCookie(req, PENDING_COOKIE);
  if (!token || token.length > 512) return null;
  const [payload, sig, more] = token.split(".");
  if (!payload || !sig || more !== undefined) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await pendingKey(env, ["verify"]), unb64url(sig), text.encode(`${PENDING_LABEL}\n${payload}`)))) return null;
    const v = JSON.parse(new TextDecoder().decode(unb64url(payload))) as { a?: unknown; exp?: unknown; j?: unknown };
    if (typeof v.a !== "string" || !validAddress(v.a) || typeof v.exp !== "number" || v.exp < now || typeof v.j !== "string" || !/^[0-9a-f]{24}$/.test(v.j)) return null;
    return { address: v.a, id: v.j, exp: v.exp, token };
  } catch {
    return null;
  }
}

/** True for the first use of a pending cookie, false for every other (the counter is the one place that keeps it). */
const useOnce = (env: Env, p: Pending) => d1Limit(env.DB, `nanoterra-pending|${p.id}`, 1, ONCE_WINDOW_MS, p.exp);

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** An address as the player can compare it: the start and the end. */
const shortAddress = (a: string) => `${a.slice(0, 11)}\u2026${a.slice(-6)}`;

/** The screen between the callback and the session. The name comes from another site: it is escaped. */
async function confirmPage(req: Request, player: Player, token: string): Promise<Response> {
  const name = escapeHtml(player.username);
  const bind = await bindOf(token);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="stylesheet" href="/nanoterra.css"><title>Sign in as ${name}?</title><h1>Sign in as ${name}?</h1><p>Nanoterra says you are <strong>${name}</strong>, with the address <code>${shortAddress(player.address)}</code>.</p><p>Press <strong>Continue</strong> only if you just pressed Play in Nanoterra yourself. If someone sent you this link, press <strong>Not me</strong>.</p><form method="post" action="/nanoterra/confirm"><input type="hidden" name="bind" value="${bind}"><button type="submit" class="primary">Continue as ${name}</button></form><form method="post" action="/nanoterra/cancel"><button type="submit">Not me</button></form>`;
  // "same-origin", not "no-referrer": with no-referrer a browser sends `Origin: null` on the form's POST, and confirm() would refuse
  // the player's own press. Another site still gets no Referer from this page, and its own POST here still carries its own Origin.
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin" });
  headers.append("Set-Cookie", setCookie(req, PENDING_COOKIE, token, PENDING_SECONDS));
  // The state has done its work: it works once.
  headers.append("Set-Cookie", setCookie(req, STATE_COOKIE, "", 0));
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
  const params = new URL(req.url).searchParams;
  const code = params.get("code") ?? "";
  if (!CODE.test(code)) return page(400, "That sign-in did not work", "The sign-in code is missing or not valid. Press Play in Nanoterra again.");
  // The state of the link must be the state THIS browser started with (its cookie). A link that someone else made has a state that is not in this
  // browser's cookie, and nothing is traded for it. The cookie is dropped in every answer from here on: a state works once.
  const state = params.get("state") ?? "";
  const kept = readCookie(req, STATE_COOKIE) ?? "";
  const clear = [setCookie(req, STATE_COOKIE, "", 0)];
  if (!STATE.test(state) || !STATE.test(kept) || !(await sameText(state, kept))) return page(400, "That sign-in did not start here", "It did not start in this browser, or it started more than 10 minutes ago. Press Play in Nanoterra again.", clear);
  const player = await exchangeCode(env, code, state, fetcher);
  if (!player) return page(400, "That sign-in did not work", "The sign-in code was refused or has run out. Press Play in Nanoterra again.", clear);
  // What Nanoterra says about this address is kept now (it is that address's own data, and the exchange proved the code and the secret).
  await env.DB.prepare(
    "INSERT INTO nanoterra_players (address, username, look, record, items, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET username = excluded.username, look = excluded.look, record = excluded.record, items = excluded.items, updated_at = excluded.updated_at",
  )
    .bind(player.address, player.username, JSON.stringify(player.look), player.record ? JSON.stringify(player.record) : null, JSON.stringify(player.items), now)
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
  const pending = await readPending(env, req, now);
  if (!pending) return page(400, "That sign-in has run out", "It is more than 5 minutes since you pressed Play, or it did not start in this browser. Press Play in Nanoterra again.");
  // The press must be from the screen that this cookie made: a second callback in this browser has replaced the cookie since the screen was drawn.
  let bind = "";
  try {
    if (!tooLarge(req, 1024)) bind = String((await req.formData()).get("bind") ?? "");
  } catch {
    // No form: no bind.
  }
  if (bind !== (await bindOf(pending.token))) return page(400, "That sign-in changed", "Another sign-in started in this browser after this screen was shown. Press Play in Nanoterra again.");
  if (!(await useOnce(env, pending))) return page(400, "That sign-in was used", "This sign-in was used or cancelled already. Press Play in Nanoterra again.");
  const token = await createSession(env.DB, pending.address, now, "nanoterra");
  const headers = new Headers({ Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", setCookie(req, "session", token, SESSION_DAYS * 86400));
  headers.append("Set-Cookie", setCookie(req, PENDING_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}

/** POST /nanoterra/cancel: the player pressed "Not me". Uses the pending token up, drops the cookie, makes no session, and goes to the game as a guest. */
export async function cancel(env: Env, req: Request, now = Date.now()): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Not allowed." }, 405, { Allow: "POST" });
  const pending = await readPending(env, req, now);
  if (pending) await useOnce(env, pending);
  const headers = new Headers({ Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", setCookie(req, PENDING_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}

/** The name and the character kept from the player's last Nanoterra sign-in, for the game's own screens (`/api/me`). */
export async function playerOf(db: D1Database, address: string): Promise<{ username: string; look: Look; record: PackedRecord | null; items: string[] } | null> {
  const row = await db.prepare("SELECT username, look, record, items FROM nanoterra_players WHERE address = ?").bind(address).first<{ username: string; look: string; record: string | null; items: string }>();
  if (!row) return null;
  try {
    // Read again with the same care as at the sign-in: a stored value that is not whole is left out.
    const k = row.record ? (JSON.parse(row.record) as unknown) : null;
    return { username: row.username, look: JSON.parse(row.look) as Look, record: Array.isArray(k) ? packedOf({ v: 2, k }) : null, items: JSON.parse(row.items) as string[] };
  } catch {
    return null;
  }
}
