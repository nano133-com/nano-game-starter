// Sign in with Nano, with @nano133/signin, by one of three wallet apps: Berry Wallet (or any wallet that reads
// "nano-signin-v1"), Nautilus (its "nanoauth" request) or NanChat (its "nanauth" request). No password, no email, no
// payment: the wallet signs a text that names this game's domain, and the Worker checks the signature. The Worker
// holds no key.
//
//   POST /api/signin/start          the browser starts a request: { way } (rate-limited; Turnstile when set)
//   GET  /api/signin/nano/:id       Berry Wallet reads the request (no cookie, no Origin)
//   POST /api/signin/nano/:id       Berry Wallet posts its signature: 204 with no body when accepted
//   POST /api/signin/nautilus?id=   Nautilus posts its signature: always 200 (Nautilus shows only a 200's words)
//   POST /api/signin/nanchat        NanChat's relay server posts the signature: always 200 (NanChat shows the words)
//   POST /api/signin/check          the browser asks every 2 seconds: { id, way }; only the browser that started it signs in
//   POST /api/signout
//
// Whichever wallet signs, the session is for the address that signed, and only RECEIVE_ADDRESS opens /admin.
// DO NOT CHANGE the checks in this file or in the package: they are what makes the admin page the creator's.

import {
  answerNanchat,
  answerNanoSignin,
  answerNautilus,
  checkNanchat,
  checkNanoSignin,
  checkNautilus,
  nanchatNonce,
  nanchatReply,
  NANO_SIGNIN_ACCEPTED,
  nanoSigninRefusal,
  nautilusReply,
  readNanoSignin,
  startNanchat,
  startNanoSignin,
  startNautilus,
  WalletRefused,
  type NanchatOptions,
  type NanoSigninOptions,
  type NautilusOptions,
  type RequestStore,
  type WalletRequest,
} from "@nano133/signin";
import { EXAMPLE_ADDRESS, receiveAddress, type Env } from "./env";
import { fail, json, randomHex, readCookie, setCookie, sha256Hex, tooLarge } from "./http";
import { d1Limit, LIMITS, memoryLimit } from "./ratelimit";

export const SESSION_DAYS = 30;
const STARTER_MAX_AGE = 30 * 60;

/** The wallet apps a player can sign in with. The sign-in sheet shows them in this order. */
export const WAYS = ["berry", "nanchat", "nautilus"] as const;
export type Way = (typeof WAYS)[number];

/** The way a call names; Berry Wallet when it names none. Null for anything else. */
export const wayOf = (v: unknown): Way | null => (v === undefined ? "berry" : WAYS.find((w) => w === v) ?? null);

type Row = { id: string; rid: string | null; starter: string; status: string; expires_at: number; nonce: string | null; issued_at: number | null; label: string | null; account: string | null };

const toRequest = (r: Row): WalletRequest => ({
  id: r.rid ?? r.id,
  starter: r.starter,
  status: r.status === "signedin" ? "signedin" : "waiting",
  expiresAt: r.expires_at,
  ...(r.label ? { label: r.label } : {}),
  ...(r.nonce ? { nonce: r.nonce } : {}),
  ...(r.issued_at ? { issuedAt: r.issued_at } : {}),
  ...(r.account ? { account: r.account } : {}),
});

/**
 * The signin package's RequestStore for one wallet app, in D1. A row's `id` is its key (NanChat's: the hash of its
 * nonce) and `rid` the browser's id. `finish` is one atomic update: waiting → signed in, once.
 */
export function d1Requests(db: D1Database, way: Way): RequestStore {
  const get = async (key: string) => {
    const r = await db.prepare("SELECT * FROM signin_requests WHERE id = ? AND way = ?").bind(key, way).first<Row>();
    return r ? toRequest(r) : null;
  };
  return {
    async create(key, r) {
      await db
        .prepare("INSERT INTO signin_requests (id, rid, way, starter, status, expires_at, nonce, issued_at, label) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?)")
        .bind(key, r.id, way, r.starter, r.expiresAt, r.nonce ?? null, r.issuedAt ?? null, r.label ?? null)
        .run();
    },
    get,
    async find(id) {
      const r = await db.prepare("SELECT * FROM signin_requests WHERE rid = ? AND way = ?").bind(id, way).first<Row>();
      return r ? { key: r.id, request: toRequest(r) } : null;
    },
    async finish(key, account) {
      const r = await db.prepare("UPDATE signin_requests SET status = 'signedin', account = ? WHERE id = ? AND way = ? AND status = 'waiting'").bind(account, key, way).run();
      return r.meta.changes === 1;
    },
  };
}

/**
 * The sign-in options of each wallet app for this request's site: the domain and page come from the address the
 * player opened. Nautilus also names a Nano address of the site's own: the creator's RECEIVE_ADDRESS (only named
 * in the request and in the signed text; no key, no payment), or the example address while none is set.
 */
export function wallets(env: Env, req: Request, now?: () => number) {
  const url = new URL(req.url);
  const at = now ? { now } : {};
  return {
    berry: { domain: url.host, uri: `${url.origin}/`, store: d1Requests(env.DB, "berry"), ...at } satisfies NanoSigninOptions,
    nautilus: { site: url.host, siteAddress: receiveAddress(env) ?? EXAMPLE_ADDRESS, store: d1Requests(env.DB, "nautilus"), ...at } satisfies NautilusOptions,
    nanchat: { host: url.host, store: d1Requests(env.DB, "nanchat"), ...at } satisfies NanchatOptions,
    requestUrl: (id: string) => `${url.origin}/api/signin/nano/${id}`,
    nautilusUrl: (id: string) => `${url.origin}/api/signin/nautilus?id=${id}`,
    nanchatUrl: `${url.origin}/api/signin/nanchat`,
  };
}

export async function startSignin(env: Env, req: Request, way: Way, now?: () => number): Promise<Response> {
  const starter = randomHex(32);
  const hash = await sha256Hex(starter);
  const w = wallets(env, req, now);
  let out: Record<string, unknown>;
  if (way === "nautilus") {
    const s = await startNautilus(w.nautilus, { starter: hash, answerUrl: w.nautilusUrl });
    out = { way, id: s.id, link: s.link, code: s.code, expiresAt: s.expiresAt };
  } else if (way === "nanchat") {
    const s = await startNanchat(w.nanchat, { starter: hash, answerUrl: w.nanchatUrl });
    out = { way, id: s.id, link: s.link, expiresAt: s.expiresAt };
  } else {
    const s = await startNanoSignin(w.berry, { starter: hash, requestUrl: w.requestUrl });
    out = { way, id: s.id, link: s.link, walletLink: s.walletLink, expiresAt: s.expiresAt };
  }
  return json(out, 200, { "Set-Cookie": setCookie(req, "starter", starter, STARTER_MAX_AGE) });
}

/** A wallet app's JSON body (at most 8 KB), or null when it is not one readable object. */
async function walletBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    if (tooLarge(req)) return null;
    const text = await req.text();
    if (text.length > 8192) return null;
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Berry Wallet's GET and POST. They come from the wallet app, so there is no cookie and no Origin to check. */
export async function walletRoute(env: Env, req: Request, id: string, now?: () => number): Promise<Response> {
  const { berry, requestUrl } = wallets(env, req, now);
  if (req.method === "GET") {
    const request = await readNanoSignin(berry, id, requestUrl);
    return request ? json(request) : json(nanoSigninRefusal("This sign-in expired."), 404);
  }
  const body = await walletBody(req);
  if (!body) return json(nanoSigninRefusal("This answer is not readable."), 401);
  try {
    await answerNanoSignin(berry, id, body, requestUrl);
    // Berry Wallet shows its success screen only for a 204 with no body.
    return new Response(null, { status: NANO_SIGNIN_ACCEPTED });
  } catch (e) {
    if (e instanceof WalletRefused) return json(nanoSigninRefusal(e.message), 401);
    throw e;
  }
}

/** Nautilus's answer. It comes from the app: no cookie, no Origin. Nautilus shows the words only with HTTP 200. */
export async function nautilusRoute(env: Env, req: Request, now?: () => number): Promise<Response> {
  const { nautilus } = wallets(env, req, now);
  const body = await walletBody(req);
  if (!body) return json(nautilusReply(nautilus.site, "That answer could not be read."));
  try {
    await answerNautilus(nautilus, new URL(req.url).searchParams.get("id") ?? "", body);
    return json(nautilusReply(nautilus.site));
  } catch (e) {
    if (e instanceof WalletRefused) return json(nautilusReply(nautilus.site, e.message));
    throw e;
  }
}

/**
 * NanChat's answer. NanChat's relay server posts it, so it has no cookie and no Origin, and every answer comes from
 * the same address: the limits are totals (LIMITS.nanchat*), never per visitor. Only an answer of the right shape
 * counts: junk cannot use the total up. NanChat shows the words whatever they say: a refusal starts "NOT signed in".
 */
export async function nanchatRoute(env: Env, req: Request, now = Date.now()): Promise<Response> {
  const { nanchat } = wallets(env, req, () => now);
  const refuse = (words: string) => json(nanchatReply(nanchat.host, words));
  if (!memoryLimit("nanchat", LIMITS.nanchatRoute.limit, LIMITS.nanchatRoute.windowMs, now)) return refuse("too many sign-ins at once. Wait a minute.");
  const body = await walletBody(req);
  if (!body) return refuse("that answer could not be read.");
  const nonce = nanchatNonce(nanchat.host, body.message);
  if (nonce && typeof body.account === "string" && typeof body.signature === "string" && /^[0-9A-Fa-f]{128}$/.test(body.signature)) {
    if (!(await d1Limit(env.DB, "nanchat|all", LIMITS.nanchatAll.limit, LIMITS.nanchatAll.windowMs, now))) {
      // Nobody can sign in with NanChat while this holds: the creator sees it in Workers Logs.
      console.warn("Sign in with NanChat: the total of answers is full; new answers are refused for some minutes");
      return refuse("too many sign-ins at once. Wait a few minutes.");
    }
    if (!(await d1Limit(env.DB, `nanchat|${nonce}`, LIMITS.nanchatNonce.limit, LIMITS.nanchatNonce.windowMs, now))) return refuse(`too many tries for this sign-in. Start again on ${nanchat.host}.`);
  }
  try {
    await answerNanchat(nanchat, body);
    return json(nanchatReply(nanchat.host));
  } catch (e) {
    if (e instanceof WalletRefused) return refuse(e.message);
    throw e;
  }
}

/**
 * The browser's check. When its request is signed and this browser started it ("mine"), a NEW session is
 * made, once per request, and its cookie is set.
 */
export async function checkSignin(db: D1Database, req: Request, id: unknown, way: Way, nowMs = Date.now()): Promise<Response> {
  if (typeof id !== "string") return fail(400, "no request id");
  const cookie = readCookie(req, "starter");
  const starter = cookie ? await sha256Hex(cookie) : undefined;
  const o = { store: d1Requests(db, way), now: () => nowMs };
  const r = way === "nautilus" ? await checkNautilus(o, id, starter) : way === "nanchat" ? await checkNanchat(o, id, starter) : await checkNanoSignin(o, id, starter);
  if (r.status !== "signedin") return json({ status: r.status });
  if (!r.mine || !r.account) return json({ status: "elsewhere" });
  // Deliver once: a second check of the same request makes no second session.
  const once = await db.prepare("UPDATE signin_requests SET delivered = 1 WHERE id = ? AND way = ? AND delivered = 0 AND status = 'signedin'").bind(r.key ?? id, way).run();
  if (once.meta.changes !== 1) return json({ status: "used" });
  const token = await createSession(db, r.account, nowMs);
  return json({ status: "signedin", address: r.account }, 200, { "Set-Cookie": setCookie(req, "session", token, SESSION_DAYS * 86400) });
}

export async function createSession(db: D1Database, address: string, now = Date.now()): Promise<string> {
  const token = randomHex(32);
  await db
    .prepare("INSERT INTO sessions (id_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), address, now, now + SESSION_DAYS * 86_400_000)
    .run();
  return token;
}

export type Session = { address: string; createdAt: number };

export async function sessionOf(db: D1Database, req: Request, now = Date.now()): Promise<Session | null> {
  const token = readCookie(req, "session");
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db.prepare("SELECT address, created_at FROM sessions WHERE id_hash = ? AND expires_at > ?").bind(await sha256Hex(token), now).first<{ address: string; created_at: number }>();
  return row ? { address: row.address, createdAt: row.created_at } : null;
}

export async function signOut(db: D1Database, req: Request): Promise<Response> {
  const token = readCookie(req, "session");
  if (token) await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": setCookie(req, "session", "", 0) });
}
