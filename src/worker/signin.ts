// Sign in with Nano, by Berry Wallet (or any wallet that reads "nano-signin-v1"), with @nano133/signin.
// No password, no email, no payment: the wallet signs a text that names this game's domain, and the Worker
// checks the signature. The Worker holds no key.
//
//   POST /api/signin/start        the browser starts a request (rate-limited; Turnstile when set)
//   GET  /api/signin/nano/:id     the wallet reads the request (no cookie, no Origin)
//   POST /api/signin/nano/:id     the wallet posts its signature: 204 with no body when accepted
//   POST /api/signin/check        the browser asks every 2 seconds; only the browser that started it signs in
//   POST /api/signout
//
// DO NOT CHANGE the checks in this file or in the package: they are what makes the admin page the creator's.

import {
  answerNanoSignin,
  checkNanoSignin,
  NANO_SIGNIN_ACCEPTED,
  nanoSigninRefusal,
  readNanoSignin,
  startNanoSignin,
  WalletRefused,
  type NanoSigninOptions,
  type RequestStore,
  type WalletRequest,
} from "@nano133/signin";
import { fail, json, randomHex, readCookie, setCookie, sha256Hex, tooLarge } from "./http";

export const SESSION_DAYS = 30;
const STARTER_MAX_AGE = 30 * 60;

type Row = { id: string; starter: string; status: string; expires_at: number; nonce: string | null; issued_at: number | null; account: string | null };

const toRequest = (r: Row): WalletRequest => ({
  id: r.id,
  starter: r.starter,
  status: r.status === "signedin" ? "signedin" : "waiting",
  expiresAt: r.expires_at,
  ...(r.nonce ? { nonce: r.nonce } : {}),
  ...(r.issued_at ? { issuedAt: r.issued_at } : {}),
  ...(r.account ? { account: r.account } : {}),
});

/** The signin package's RequestStore, in D1. `finish` is one atomic update: waiting → signed in, once. */
export function d1Requests(db: D1Database): RequestStore {
  const get = async (id: string) => {
    const r = await db.prepare("SELECT * FROM signin_requests WHERE id = ?").bind(id).first<Row>();
    return r ? toRequest(r) : null;
  };
  return {
    async create(key, r) {
      await db
        .prepare("INSERT INTO signin_requests (id, starter, status, expires_at, nonce, issued_at) VALUES (?, ?, 'waiting', ?, ?, ?)")
        .bind(key, r.starter, r.expiresAt, r.nonce ?? null, r.issuedAt ?? null)
        .run();
    },
    get,
    async find(id) {
      const request = await get(id);
      return request ? { key: id, request } : null;
    },
    async finish(key, account) {
      const r = await db.prepare("UPDATE signin_requests SET status = 'signedin', account = ? WHERE id = ? AND status = 'waiting'").bind(account, key).run();
      return r.meta.changes === 1;
    },
  };
}

/** The sign-in options for this request's site: the domain and page come from the address the player opened. */
export function berry(db: D1Database, req: Request, now?: () => number): { options: NanoSigninOptions; requestUrl: (id: string) => string } {
  const url = new URL(req.url);
  return {
    options: { domain: url.host, uri: `${url.origin}/`, store: d1Requests(db), ...(now ? { now } : {}) },
    requestUrl: (id: string) => `${url.origin}/api/signin/nano/${id}`,
  };
}

export async function startSignin(db: D1Database, req: Request, now?: () => number): Promise<Response> {
  const starter = randomHex(32);
  const { options, requestUrl } = berry(db, req, now);
  const s = await startNanoSignin(options, { starter: await sha256Hex(starter), requestUrl });
  return json({ id: s.id, link: s.link, walletLink: s.walletLink, expiresAt: s.expiresAt }, 200, { "Set-Cookie": setCookie(req, "starter", starter, STARTER_MAX_AGE) });
}

/** The wallet's GET and POST. They come from the wallet app, so there is no cookie and no Origin to check. */
export async function walletRoute(db: D1Database, req: Request, id: string, now?: () => number): Promise<Response> {
  const { options, requestUrl } = berry(db, req, now);
  if (req.method === "GET") {
    const request = await readNanoSignin(options, id, requestUrl);
    return request ? json(request) : json(nanoSigninRefusal("This sign-in expired."), 404);
  }
  let body: Record<string, unknown>;
  try {
    if (tooLarge(req)) throw new Error("too large");
    const text = await req.text();
    if (text.length > 8192) throw new Error("too large");
    body = JSON.parse(text);
  } catch {
    return json(nanoSigninRefusal("This answer is not readable."), 401);
  }
  try {
    await answerNanoSignin(options, id, body, requestUrl);
    // Berry Wallet shows its success screen only for a 204 with no body.
    return new Response(null, { status: NANO_SIGNIN_ACCEPTED });
  } catch (e) {
    if (e instanceof WalletRefused) return json(nanoSigninRefusal(e.message), 401);
    throw e;
  }
}

/**
 * The browser's check. When its request is signed and this browser started it ("mine"), a NEW session is
 * made, once per request, and its cookie is set.
 */
export async function checkSignin(db: D1Database, req: Request, id: unknown, nowMs = Date.now()): Promise<Response> {
  if (typeof id !== "string") return fail(400, "no request id");
  const starter = readCookie(req, "starter");
  const r = await checkNanoSignin({ store: d1Requests(db), now: () => nowMs }, id, starter ? await sha256Hex(starter) : undefined);
  if (r.status !== "signedin") return json({ status: r.status });
  if (!r.mine || !r.account) return json({ status: "elsewhere" });
  // Deliver once: a second check of the same request makes no second session.
  const once = await db.prepare("UPDATE signin_requests SET delivered = 1 WHERE id = ? AND delivered = 0 AND status = 'signedin'").bind(id).run();
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
