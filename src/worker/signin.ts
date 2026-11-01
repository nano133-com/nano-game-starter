// The ADMIN's sign-in (/admin), with @nano133/signin, by Berry Wallet (or any wallet that reads "nano-signin-v1") or Nautilus (its "nanoauth"
// request). No password, no email, no payment: the wallet signs a text that names this game's domain AND the admin, and the Worker checks the
// signature. The Worker holds no key.
//
// The PLAYER's sign-in is the package's (@nano133/nanoterra/player-signin, made in src/worker/player.ts) on the same paths. It answers every call
// of the game's own scope and leaves the admin's to this file: a call whose body says `scope: "admin"`, and a wallet's call for a request that the
// player store does not hold (an admin request).
//
//   POST /api/signin/start          { way, scope: "admin" }: the browser starts an admin request (rate-limited; Turnstile when set)
//   GET  /api/signin/nano/:id       Berry Wallet reads the request (no cookie, no Origin)
//   POST /api/signin/nano/:id       Berry Wallet posts its signature: 204 with no body when accepted
//   POST /api/signin/nautilus?id=   Nautilus posts its signature: always 200 (Nautilus shows only a 200's words)
//   POST /api/signin/check          { id, way, scope: "admin" }: the browser asks every 2 seconds; only the browser that started it signs in
//   POST /api/signout               { scope: "admin" }
//
// Only RECEIVE_ADDRESS opens /admin, whichever wallet signs. Two logins, two cookies: the game's (cookie `session`, the package's) and /admin's
// (cookie `admin`, this file's), so the game and /admin can have different people signed in at once. Only a wallet signature that was started
// from /admin makes an admin login. DO NOT CHANGE the checks in this file or in the package: they are what makes the admin page the creator's.

import {
  answerNanoSignin,
  answerNautilus,
  checkNanchat,
  checkNanoSignin,
  checkNautilus,
  NANO_SIGNIN_ACCEPTED,
  nanoSigninRefusal,
  nautilusReply,
  readNanoSignin,
  startNanoSignin,
  startNautilus,
  WalletRefused,
  type NanoSigninOptions,
  type NautilusOptions,
  type RequestStore,
  type WalletRequest,
} from "@nano133/signin";
import { countryOf, shortBrowser } from "./browser";
import { EXAMPLE_ADDRESS, receiveAddress, type Env } from "./env";
import { fail, json, randomHex, readCookie, setCookie, sha256Hex, tooLarge } from "./http";

const STARTER_MAX_AGE = 30 * 60;
/** An admin sign-in counts for one day; then the creator signs in again. */
export const ADMIN_SESSION_MS = 24 * 60 * 60_000;
/** An admin sign-in REQUEST lives 2 minutes (the game's lives up to 5), and a signature is delivered for one more minute after it ends. It works once. */
export const ADMIN_REQUEST_MS = 2 * 60_000;
export const ADMIN_DELIVER_MS = 60_000;
/** How long a row of the admin's sign-in list is kept: 30 days. */
export const ADMIN_LOGIN_KEEP_MS = 30 * 24 * 60 * 60_000;

/** The admin login's cookie (the game's is the package's `session`): the admin guard reads only this one, so a login made for the game can never open /admin. */
const ADMIN_COOKIE = "admin";
/** The cookie that ties an admin request to the browser that started it (the game's is the package's `starter`): a request started for the game cannot be finished as an admin login. */
const STARTER_COOKIE = "starter-admin";

/**
 * What the database keeps of an admin session or of an admin request's starter: the hash of the token with a prefix. So the SERVER (not only the
 * cookie's name) keeps the two scopes apart: a token made for the game (the package keeps its plain hash) does not open /admin even if it is put in
 * the admin cookie, and a starter value copied from the game's cookie does not finish an admin request.
 */
export const adminKey = (value: string): Promise<string> => sha256Hex(`admin:${value}`);

/** The wallet apps' names. The admin uses Berry Wallet and Nautilus; NanChat is refused with words of its own (see `startSignin`). */
export const WAYS = ["berry", "nanchat", "nautilus"] as const;
export type Way = (typeof WAYS)[number];

/** The way a call names; Berry Wallet when it names none. Null for anything else. */
export const wayOf = (v: unknown): Way | null => (v === undefined ? "berry" : WAYS.find((w) => w === v) ?? null);

type Row = { id: string; rid: string | null; starter: string; status: string; expires_at: number; nonce: string | null; issued_at: number | null; label: string | null; account: string | null; scope: string };

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
 * The signin package's RequestStore for one wallet app, in D1, for the ADMIN's requests. A row's `id` is its key and `rid` the browser's id.
 * `finish` is one atomic update: waiting → signed in, once. `scope` is whose request it is: 'admin' here (the package's player store writes
 * 'play'). It is written when the request is created and read again when the browser's check delivers it (see `checkSignin`).
 */
export function d1Requests(db: D1Database, way: Way): RequestStore {
  const get = async (key: string) => {
    const r = await db.prepare("SELECT * FROM signin_requests WHERE id = ? AND way = ?").bind(key, way).first<Row>();
    return r ? toRequest(r) : null;
  };
  return {
    async create(key, r) {
      await db
        .prepare("INSERT INTO signin_requests (id, rid, way, starter, status, expires_at, nonce, issued_at, label, scope) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, 'admin')")
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
 * `admin` is given for a request that opens the admin; without it (a wallet's call for a request nobody holds) the plain text is used.
 */
export function wallets(env: Env, req: Request, now?: () => number, admin?: { country: string | null }) {
  const url = new URL(req.url);
  const at = now ? { now } : {};
  // A request that opens the ADMIN says so in what the wallet signs, and lives 2 minutes: Berry Wallet signs the page it signs in to ("URI: https://example.com/admin": the path
  // names the admin, with NO query: Berry Wallet refused "/admin?from=US" with "Sign-in requires a public HTTPS website", device test 2026-10-27), Nautilus signs its label ("ADMIN of example.com
  // sign-in ABCD-EFGH from US"). Nautilus's text carries the place the request started, so a person who is sent a link from elsewhere can tell; Berry's has the time ("Issued At") and the Sign-ins card has the country.
  // (NanChat is not offered for the admin: its text must start "Login to <host>" and its docs do not say what may follow.)
  const life = admin ? { ttlMs: ADMIN_REQUEST_MS } : {};
  const started = new Date(now?.() ?? Date.now()).toISOString().slice(11, 16);
  const adminLine = `Sign in to the ADMIN of ${url.host}. Started ${started} UTC from ${admin?.country ?? "an unknown country"}. If you did not start this, do not sign.`;
  return {
    berry: { domain: url.host, uri: admin ? `${url.origin}/admin` : `${url.origin}/`, store: d1Requests(env.DB, "berry"), ...life, ...at } satisfies NanoSigninOptions,
    nautilus: {
      site: url.host,
      siteAddress: receiveAddress(env) ?? EXAMPLE_ADDRESS,
      store: d1Requests(env.DB, "nautilus"),
      ...(admin ? { title: `ADMIN of ${url.host}`, ...(admin.country ? { note: `from ${admin.country}` } : {}), message: adminLine } : {}),
      ...life,
      ...at,
    } satisfies NautilusOptions,
    requestUrl: (id: string) => `${url.origin}/api/signin/nano/${id}`,
    nautilusUrl: (id: string) => `${url.origin}/api/signin/nautilus?id=${id}`,
  };
}

/** Starts an admin request (the package starts the game's). */
export async function startSignin(env: Env, req: Request, way: Way, now?: () => number): Promise<Response> {
  const admin = { country: countryOf(req) };
  // NanChat cannot name the admin in what it signs (its text must start "Login to <host>"): an admin request through it would look like any sign-in to the owner who is asked to sign.
  if (way === "nanchat") return fail(400, "NanChat cannot open the admin yet. Use Berry Wallet or Nautilus.");
  const starter = randomHex(32);
  const hash = await adminKey(starter);
  const w = wallets(env, req, now, admin);
  let out: Record<string, unknown>;
  if (way === "nautilus") {
    const s = await startNautilus(w.nautilus, { starter: hash, answerUrl: w.nautilusUrl });
    out = { way, id: s.id, link: s.link, code: s.code, expiresAt: s.expiresAt };
  } else {
    // `label` keeps what kind of request this is (and where it started), so the wallet's GET and POST get the same text: see `kindOf`.
    const s = await startNanoSignin(w.berry, { starter: hash, requestUrl: w.requestUrl, label: admin.country ? `admin:${admin.country}` : "admin" });
    out = { way, id: s.id, link: s.link, walletLink: s.walletLink, expiresAt: s.expiresAt };
  }
  return json(out, 200, { "Set-Cookie": setCookie(req, STARTER_COOKIE, starter, STARTER_MAX_AGE) });
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

/**
 * What kind of Berry request `id` is: an ADMIN one (`{ country }`: the country it started from, or null) or not (undefined). The kind is the request's stored SCOPE (written when it
 * started): not a note that could be lost, so a request that was started for the admin always gets the admin's text, and a request with no scope is the game's. The country is read from
 * the note `startSignin` kept ("admin:US"); it is only for the text.
 * The wallet's GET and POST come with no cookie, so the stored row is the only way to build the same text for the same request.
 */
async function kindOf(db: D1Database, id: string): Promise<{ country: string | null } | undefined> {
  if (!/^[0-9a-f]{32}$/.test(id)) return undefined;
  const row = await db.prepare("SELECT scope, label FROM signin_requests WHERE id = ? AND way = 'berry'").bind(id).first<{ scope: string; label: string | null }>();
  if (!row || row.scope !== "admin") return undefined;
  const country = typeof row.label === "string" && /^admin:[A-Z]{2}$/.test(row.label) ? row.label.slice(6) : null;
  return { country };
}

/** Berry Wallet's GET and POST. They come from the wallet app, so there is no cookie and no Origin to check. */
export async function walletRoute(env: Env, req: Request, id: string, now?: () => number): Promise<Response> {
  const { berry, requestUrl } = wallets(env, req, now, await kindOf(env.DB, id));
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
 * The browser's check of an admin request. When it is signed and this browser started it ("mine"), a NEW admin session is
 * made, once per request, and its cookie is set. `owner` is RECEIVE_ADDRESS, or null when none is set.
 */
export async function checkSignin(db: D1Database, req: Request, id: unknown, way: Way, nowMs = Date.now(), owner: string | null = null): Promise<Response> {
  if (typeof id !== "string") return fail(400, "no request id");
  const cookie = readCookie(req, STARTER_COOKIE);
  // The starter cookie is what this game made: 32 random bytes as 64 hex characters. A value of any other shape (one with a prefix of the other scope's hashing, for example) is no starter.
  const starter = cookie && /^[0-9a-f]{64}$/.test(cookie) ? await adminKey(cookie) : undefined;
  // An admin request is delivered for a minute after it ends.
  const o = { store: d1Requests(db, way), now: () => nowMs, deliverMs: ADMIN_DELIVER_MS };
  const r = way === "nautilus" ? await checkNautilus(o, id, starter) : way === "nanchat" ? await checkNanchat(o, id, starter) : await checkNanoSignin(o, id, starter);
  if (r.status !== "signedin") return json({ status: r.status });
  if (!r.mine || !r.account) return json({ status: "elsewhere" });
  // The request must have been STARTED for the admin: a request started for the game never makes an admin login, whatever credentials the browser presents.
  // (An answer for the other scope is "elsewhere", and the request is left as it is.)
  const started = await db.prepare("SELECT scope FROM signin_requests WHERE id = ? AND way = ?").bind(r.key ?? id, way).first<{ scope: string }>();
  if (!started || started.scope !== "admin") return json({ status: "elsewhere" });
  // An admin login is for the game's own address only. A wallet that is not it makes no admin login (and does not end the owner's, which is
  // in a cookie of its own), and the request stays unused.
  if (r.account !== owner) return json({ status: "not_owner", address: r.account });
  // Deliver once: a second check of the same request makes no second session. The delivery and the session are ONE batch (one transaction), and the session is
  // written only when the delivery changed a row. So "Sign out everywhere" cannot run between them: it either ends the request first (nothing is delivered, no session)
  // or deletes the session after (the batch is done).
  const token = randomHex(32);
  const done = await db.batch([
    db.prepare("UPDATE signin_requests SET delivered = 1 WHERE id = ? AND way = ? AND delivered = 0 AND status = 'signedin' AND scope = 'admin'").bind(r.key ?? id, way),
    db
      .prepare("INSERT INTO sessions (id_hash, address, created_at, expires_at, via, scope) SELECT ?, ?, ?, ?, 'wallet', 'admin' WHERE changes() = 1")
      .bind(await adminKey(token), r.account, nowMs, nowMs + ADMIN_SESSION_MS),
  ]);
  if (done[0]?.meta.changes !== 1) return json({ status: "used" });
  // The admin's sign-in list: the time, the rough country and a short browser name of THIS browser (the one that started the request and now gets the login). Nothing else.
  await recordAdminLogin(db, req, nowMs);
  return json({ status: "signedin", address: r.account }, 200, { "Set-Cookie": setCookie(req, ADMIN_COOKIE, token, ADMIN_SESSION_MS / 1000) });
}

/**
 * Writes one row of the admin's sign-in list: the time, the country of the request (two letters or none) and a short browser name made from fixed lists. No address, no IP and no browser text.
 * Rows older than 30 days are deleted at the same time.
 */
export async function recordAdminLogin(db: D1Database, req: Request, now: number): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO admin_logins (at, country, browser) VALUES (?, ?, ?)").bind(now, countryOf(req), shortBrowser(req.headers.get("User-Agent"))),
    db.prepare("DELETE FROM admin_logins WHERE at < ?").bind(now - ADMIN_LOGIN_KEEP_MS),
  ]);
}

/** `via` is "unknown" for a stored word other than "wallet" and "nanoterra": it is never read as a wallet login (the admin guard refuses anything but "wallet"). */
export type AdminSession = { address: string; createdAt: number; via: "wallet" | "nanoterra" | "unknown" };

/** The ADMIN login of this request (the admin cookie only), or null. */
export async function adminSession(db: D1Database, req: Request, now = Date.now()): Promise<AdminSession | null> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  // The scope is checked in the row as well as in the hash: the two scopes stay apart in two ways.
  const row = await db.prepare("SELECT address, created_at, via FROM sessions WHERE id_hash = ? AND expires_at > ? AND scope = 'admin'").bind(await adminKey(token), now).first<{ address: string; created_at: number; via: string }>();
  // Only the two words this game wrote are read; any other is "unknown", never a wallet login (a fail-open map would turn a stray value into a login that opens /admin).
  return row ? { address: row.address, createdAt: row.created_at, via: row.via === "wallet" || row.via === "nanoterra" ? row.via : "unknown" } : null;
}

/** Ends this browser's admin login only (the game's login, another person's perhaps, stays). */
export async function signOut(db: D1Database, req: Request): Promise<Response> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (token) await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await adminKey(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": setCookie(req, ADMIN_COOKIE, "", 0) });
}
