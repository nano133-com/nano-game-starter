// Sign in from Nanoterra (README, "Sign in from Nanoterra"). A player who is signed in at nano133.com and agreed on its card
// presses Play and arrives at GET /nanoterra/callback?code=... on THIS site. The browser carries only that one-time code (60
// seconds, used once). This Worker trades it for the player's details with a call from the server, with its client id and its
// client secret (NANOTERRA_SECRET), and makes its own session for the address that Nanoterra named.
//
// What this proves: Nanoterra says this player is signed in there and agreed to this game. It proves no key and no payment, so
// a session made here (`via: "nanoterra"`) never opens /admin (admin.ts). The secret stays in the Worker: never put it in a
// page, a log or a message. DO NOT CHANGE the checks in this file.

import { validAddress } from "@nano133/signin/verify";
import { nanoterraOn, setting, type Env } from "./env";
import { json, setCookie } from "./http";
import { memoryLimit } from "./ratelimit";
import { createSession, SESSION_DAYS } from "./signin";

const NANOTERRA = "https://nano133.com";
/** A code is 32 random bytes in base64url. */
const CODE = /^[A-Za-z0-9_-]{43}$/;
const LOOK_PARTS = ["skin", "hair", "shirt", "pants", "shoes"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ANSWER_MAX = 4096;
const CALLBACK_LIMIT = { limit: 20, windowMs: 60_000 };

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
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><h1>${title}</h1><p>${words}</p><p><a href="/">Play as a guest</a></p>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/**
 * GET /nanoterra/callback?code=...: on success a session cookie and a redirect to the game's start page. A bad or missing code
 * is a 400 page, an unfinished setup a 503 page: each with a link to play as a guest.
 */
export async function callback(env: Env, req: Request, ip: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Not allowed." }, 405, { Allow: "GET" });
  if (!nanoterraOn(env)) return page(503, "Nanoterra sign-in is not set up", "This game has not finished setting up sign-in from Nanoterra yet.");
  if (!memoryLimit(`nanoterra|${ip}`, CALLBACK_LIMIT.limit, CALLBACK_LIMIT.windowMs, now)) return page(429, "Too many tries", "Wait a minute, then press Play in Nanoterra again.");
  const code = new URL(req.url).searchParams.get("code") ?? "";
  if (!CODE.test(code)) return page(400, "That sign-in did not work", "The sign-in code is missing or not valid. Press Play in Nanoterra again.");
  const player = await exchangeCode(env, code, fetcher);
  if (!player) return page(400, "That sign-in did not work", "The sign-in code was refused or has run out. Press Play in Nanoterra again.");
  await env.DB.prepare(
    "INSERT INTO nanoterra_players (address, username, look, items, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET username = excluded.username, look = excluded.look, items = excluded.items, updated_at = excluded.updated_at",
  )
    .bind(player.address, player.username, JSON.stringify(player.look), JSON.stringify(player.items), now)
    .run();
  const token = await createSession(env.DB, player.address, now, "nanoterra");
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": setCookie(req, "session", token, SESSION_DAYS * 86400), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
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
