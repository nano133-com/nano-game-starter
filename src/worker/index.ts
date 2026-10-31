// The game's Worker: the API under /api, the listing at /nano-game.json, and the payment scan every
// 10 minutes. The game's files (index.html, admin.html, /assets) are served by Cloudflare without it.

import { nautilusReply } from "@nano133/signin";
import { nanoUri, priceRaw, xnoText } from "../shared/amount";
import { CONFIG } from "../shared/config";
import { signinOn, type Signin } from "@nano133/nanoterra/admin";
import { lookById } from "../shared/looks";
import { adminHandler, settingsOf } from "./admin";
import { FRIENDS_BASE, friendsHandler } from "./friends";
import { receiveAddress, setting, testMode, turnstileOn, type Env } from "./env";
import { fail, json, readJson, sameOrigin, secure, visitorIp } from "./http";
import { callback as nanoterraCallback, cancel as nanoterraCancel, confirm as nanoterraConfirm, playerOf, signinOff, start as nanoterraStart } from "./nanoterra";
import { Busy, MAX_OPEN_PER_PLAYER, orderById, orderView, reserve, type OrderRow } from "./orders";
import { PRICE_FEEDS, usdPerXno } from "./price";
import { d1Limit, LIMITS, memoryLimit, visitorKey } from "./ratelimit";
import { ADMIN_LOGIN_KEEP_MS, checkSignin, nanchatRoute, nautilusRoute, scopeOf, sessionOf, signOut, startSignin, walletRoute, wayOf } from "./signin";
import { sweep } from "./sweep";
import { turnstileOk } from "./turnstile";
import { warm } from "./warm";

if (!warm) console.warn("the signature warm-up check failed");

export { sweep };

/**
 * The listing that Nano Island reads. It never lists looks or prices: the sale is the creator's own. `signin` is the switch of /admin (or
 * game.config.json's word): the listing file says how the game signs a Nanoterra player in.
 */
export function listing(env: Env, req: Request, signin: Signin = CONFIG.signin) {
  const origin = new URL(req.url).origin;
  return {
    nanoGame: 1,
    name: CONFIG.name,
    line: CONFIG.line,
    play: `${origin}/`,
    art: { wide: `${origin}${CONFIG.art.wide}`, tall: `${origin}${CONFIG.art.tall}` },
    creator: { name: CONFIG.creator.name, nano: receiveAddress(env) },
    multiplayer: CONFIG.multiplayer,
    regions: CONFIG.regions,
    ages: CONFIG.ages,
    // How this game signs a Nanoterra player in ("exchange": /nanoterra/start keeps a state and /nanoterra/callback trades a one-time code for the player's details).
    signin,
    // The character is NOT here: its switch is the "Game" card of /admin (or "character" in game.config.json, "nanoterra" or "own"), and only the game's own code reads it.
  };
}

/** What the pay screen shows. In test mode the address and the payment link are left out on purpose. */
function payView(o: OrderRow, env: Env, now: number) {
  const test = testMode(env);
  const address = receiveAddress(env);
  return {
    ...orderView(o, now),
    xno: xnoText(o.amount),
    test,
    ...(!test && address ? { address, uri: nanoUri(address, o.amount) } : {}),
    prices: PRICE_FEEDS.map((f) => f.name),
  };
}

async function createOrder(env: Env, req: Request, player: string, now: number): Promise<Response> {
  const body = await readJson(req);
  const look = lookById(body.lookId);
  if (!look) return fail(400, "That look does not exist.");
  if (look.priceUsd === 0) return fail(400, "That look is free: it is already yours.");
  const db = env.DB;
  const visitor = await visitorKey(db, req);
  if (!(await d1Limit(db, `order|${visitor}`, LIMITS.order.limit, LIMITS.order.windowMs, now))) return fail(429, "Too many orders. Wait a few minutes.");
  if (!(await turnstileOk(env, body.turnstile, req.headers.get("CF-Connecting-IP")))) return fail(403, "The person check failed. Try again.");
  if (await db.prepare("SELECT 1 FROM owned WHERE player = ? AND look_id = ?").bind(player, look.id).first()) return fail(409, "You already own this look.");
  // One waiting order per look: the same one comes back, with the same amount.
  const same = await db.prepare("SELECT * FROM orders WHERE player = ? AND look_id = ? AND status = 'open' AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(player, look.id, now + 60_000).first<OrderRow>();
  if (same) return json(payView(same, env, now));
  const open = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE player = ? AND status = 'open' AND expires_at > ?").bind(player, now).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_PER_PLAYER) return fail(429, "You have orders waiting. Pay one or wait until it ends.");
  const rate = await usdPerXno(db, (i, init) => fetch(i, init), now);
  if (!rate) return fail(503, "Prices are not available now. Try again later.");
  const price = priceRaw(look.priceUsd, rate.usd);
  if (!price) return fail(503, "Prices are not available now. Try again later.");
  try {
    const order = await reserve(db, { player, lookId: look.id, usd: look.priceUsd.toFixed(2), rate: rate.usd, price, visitor, now });
    return json(payView(order, env, now), 201);
  } catch (e) {
    if (e instanceof Busy) return fail(503, "Many players are paying this price right now. Try again in a minute.");
    throw e;
  }
}

export async function handleApi(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const db = env.DB;
  const ip = visitorIp(req);
  const method = req.method;

  if (method === "OPTIONS") {
    // The admin never answers a preflight: for a path of /api/admin the package's guard answers (401 or 403 for a visitor, 405 for the owner), with no CORS header.
    const admin = await adminHandler(env, now, ip).handle(req);
    if (admin) return admin;
    // CORS: only the game's own pages may call the API.
    const origin = req.headers.get("Origin");
    if (origin !== url.origin) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" } });
  }

  // The wallet apps' routes: no cookie and no Origin (an app, or NanChat's relay server, posts them: not a browser page).
  const wallet = path.match(/^\/api\/signin\/nano\/([0-9a-f]{32})$/);
  if (wallet && (method === "GET" || method === "POST")) {
    if (!memoryLimit(`wallet|${ip}`, LIMITS.wallet.limit, LIMITS.wallet.windowMs, now)) return fail(429, "Too many requests.");
    return walletRoute(env, req, wallet[1]!, () => now);
  }
  if (path === "/api/signin/nautilus" && method === "POST") {
    // Nautilus shows the words of a refusal only with HTTP 200.
    if (!memoryLimit(`wallet|${ip}`, LIMITS.wallet.limit, LIMITS.wallet.windowMs, now)) return json(nautilusReply(url.host, "Too many requests. Wait a minute."));
    return nautilusRoute(env, req, () => now);
  }
  if (path === "/api/signin/nanchat" && method === "POST") return nanchatRoute(env, req, now);

  const pollRoute = path === "/api/signin/check" || /^\/api\/orders\/[0-9a-f]{24}\/check$/.test(path);
  const limit = pollRoute ? LIMITS.poll : LIMITS.other;
  if (!memoryLimit(`${pollRoute ? "poll" : "other"}|${ip}`, limit.limit, limit.windowMs, now)) return fail(429, "Too many requests. Wait a minute.");
  // Every call that changes something must come from the game's own pages.
  if (method === "POST" && !sameOrigin(req)) return fail(403, "This call must come from the game's own page.");

  if (method === "GET" && path === "/api/config") {
    const settings = await settingsOf(env);
    return json({
      name: CONFIG.name,
      creator: CONFIG.creator.name,
      testMode: testMode(env),
      turnstileSiteKey: turnstileOn(env) ? setting(env.TURNSTILE_SITE_KEY)! : null,
      // The "Game" card of /admin: which character the players are (the game draws it), whether sign-in from Nanoterra is on, and which
      // friends list the game shows ("nanoterra", "own" or "off").
      character: settings.character,
      nanoterraSignin: signinOn(settings.signin),
      friends: settings.friends,
      // The game's id on Nanoterra (game.config.json), or null: the Nanoterra friends window needs it.
      nanoterraId: CONFIG.nanoterraId,
    });
  }

  if (method === "POST" && path === "/api/signin/start") {
    const body = await readJson(req);
    const way = wayOf(body.way);
    if (!way) return fail(400, "That wallet is not one of this game's.");
    if (!(await d1Limit(db, `signin|${await visitorKey(db, req)}`, LIMITS.signinStart.limit, LIMITS.signinStart.windowMs, now))) return fail(429, "Too many sign-ins. Wait a few minutes.");
    if (!(await turnstileOk(env, body.turnstile, req.headers.get("CF-Connecting-IP")))) return fail(403, "The person check failed. Try again.");
    return startSignin(env, req, way, () => now, scopeOf(body.scope));
  }
  if (method === "POST" && path === "/api/signin/check") {
    const body = await readJson(req);
    const way = wayOf(body.way);
    if (!way) return fail(400, "That wallet is not one of this game's.");
    return checkSignin(db, req, body.id, way, now, scopeOf(body.scope), receiveAddress(env));
  }
  // A body that is not JSON (an older page) signs out of the game, as before.
  if (method === "POST" && path === "/api/signout") return signOut(db, req, scopeOf((await readJson(req).catch((): Record<string, unknown> => ({}))).scope));

  const session = await sessionOf(db, req, now);

  // The game's own friends list. It answers only while the admin's friends setting is "own": in the other modes /api/friends is no route (404),
  // and the friends tables are not read. The player is the PLAYER session above (the `session` cookie), never the admin cookie.
  if (path === FRIENDS_BASE && (await settingsOf(env)).friends === "own") {
    const friends = await friendsHandler(env, now, ip, session?.address ?? null).handle(req);
    if (friends) return friends;
  }

  if (method === "GET" && path === "/api/me") {
    if (!session) return json({ address: null, owned: [], admin: false });
    const owned = (await db.prepare("SELECT look_id FROM owned WHERE player = ?").bind(session.address).all<{ look_id: string }>()).results.map((r) => r.look_id);
    // The name and the character of a player who signed in from Nanoterra (the game's own screens may show them). `look`: the five colours; `record`: the whole character
    // (two numbers, `unpackRecord` in the page reads them), when Nanoterra sent one.
    const nanoterra = session.via === "nanoterra" ? await playerOf(db, session.address) : null;
    return json({ address: session.address, owned, admin: session.via === "wallet" && session.address === receiveAddress(env), via: session.via, ...(nanoterra ? { username: nanoterra.username, look: nanoterra.look, ...(nanoterra.record ? { record: { v: 2, k: nanoterra.record } } : {}), nanoterraItems: nanoterra.items } : {}) });
  }

  if (path === "/api/orders" && method === "POST") {
    if (!session) return fail(401, "Sign in first.");
    return createOrder(env, req, session.address, now);
  }
  const order = path.match(/^\/api\/orders\/([0-9a-f]{24})(\/check)?$/);
  if (order) {
    if (!session) return fail(401, "Sign in first.");
    if (order[2] && method === "POST") await sweep(env, { at: now });
    else if (order[2] || method !== "GET") return fail(405, "Not allowed.");
    const o = await orderById(db, order[1]);
    // Another player's order looks the same as no order at all.
    if (!o || o.player !== session.address) return fail(404, "No such order.");
    return json(payView(o, env, now));
  }

  // The admin: the package's handler (the guard first, then the summary, the "Game" card and the payment check). It answers EVERY path under /api/admin,
  // so a visitor who is not the owner learns nothing about the routes.
  const admin = await adminHandler(env, now, ip).handle(req);
  if (admin) return admin;

  return fail(404, "No such route.");
}

/** Deletes rows nobody needs any more. Orders stay: they are the creator's sales record. */
async function cleanUp(db: D1Database, now: number) {
  await db.batch([
    db.prepare("DELETE FROM signin_requests WHERE expires_at < ?").bind(now - 2 * 3_600_000),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM hits WHERE win < ?").bind(Math.floor((now - 86_400_000) / LIMITS.order.windowMs)),
    db.prepare("DELETE FROM admin_logins WHERE at < ?").bind(now - ADMIN_LOGIN_KEEP_MS),
  ]);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/nano-game.json" && (req.method === "GET" || req.method === "HEAD")) {
        // 60 seconds, not 300: a switch of /admin shows in the listing within a minute.
        return secure(json(listing(env, req, (await settingsOf(env)).signin), 200, { "Cache-Control": "public, max-age=60" }), false);
      }
      // Sign-in from Nanoterra is a switch of /admin: while it is off, a link made before signs nobody in. ("Not me" always works.)
      if ((path === "/nanoterra/start" || path === "/nanoterra/callback" || path === "/nanoterra/confirm") && !signinOn((await settingsOf(env)).signin)) return secure(signinOff(), false);
      if (path === "/nanoterra/start") return secure(nanoterraStart(env, req, visitorIp(req)), false);
      if (path === "/nanoterra/callback") return secure(await nanoterraCallback(env, req, visitorIp(req)), false);
      if (path === "/nanoterra/confirm") return secure(await nanoterraConfirm(env, req, visitorIp(req)), false);
      if (path === "/nanoterra/cancel") return secure(await nanoterraCancel(env, req), false);
      if (path.startsWith("/api/")) return secure(await handleApi(req, env), true);
      return secure(new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }), false);
    } catch (e) {
      if (e instanceof RangeError || e instanceof SyntaxError) return secure(fail(400, "That request is not readable."), true);
      // Log the error for the creator (Workers Logs). Never send its details to the visitor.
      console.error("request failed", path, e instanceof Error ? e.message : String(e));
      return secure(fail(500, "Something went wrong. Try again."), true);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(
      (async () => {
        const scan = await sweep(env, { at: now });
        if (scan.error) console.warn("payment scan", scan.error);
        await cleanUp(env.DB, now);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
