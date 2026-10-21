// The game's Worker: the API under /api, the listing at /nano-game.json, and the payment scan every
// 10 minutes. The game's files (index.html, admin.html, /assets) are served by Cloudflare without it.

import { nanoUri, priceRaw, xnoText } from "../shared/amount";
import { CONFIG } from "../shared/config";
import { lookById } from "../shared/looks";
import { adminGuard, adminSummary } from "./admin";
import { receiveAddress, testMode, turnstileOn, type Env } from "./env";
import { fail, json, readJson, sameOrigin, secure, visitorIp } from "./http";
import { Busy, MAX_OPEN_PER_PLAYER, orderById, orderView, reserve, type OrderRow } from "./orders";
import { PRICE_FEEDS, usdPerXno } from "./price";
import { d1Limit, LIMITS, memoryLimit, visitorKey } from "./ratelimit";
import { checkSignin, sessionOf, signOut, startSignin, walletRoute } from "./signin";
import { sweep } from "./sweep";
import { turnstileOk } from "./turnstile";
import { warm } from "./warm";

if (!warm) console.warn("the signature warm-up check failed");

export { sweep };

/** The listing that Nano Island reads. It never lists looks or prices: the sale is the creator's own. */
export function listing(env: Env, req: Request) {
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
    // CORS: only the game's own pages may call the API.
    const origin = req.headers.get("Origin");
    if (origin !== url.origin) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" } });
  }

  // The wallet app's routes: no cookie and no Origin (it is not a browser page).
  const wallet = path.match(/^\/api\/signin\/nano\/([0-9a-f]{32})$/);
  if (wallet && (method === "GET" || method === "POST")) {
    if (!memoryLimit(`wallet|${ip}`, LIMITS.wallet.limit, LIMITS.wallet.windowMs, now)) return fail(429, "Too many requests.");
    return walletRoute(db, req, wallet[1]!, () => now);
  }

  const pollRoute = path === "/api/signin/check" || /^\/api\/orders\/[0-9a-f]{24}\/check$/.test(path);
  const limit = pollRoute ? LIMITS.poll : LIMITS.other;
  if (!memoryLimit(`${pollRoute ? "poll" : "other"}|${ip}`, limit.limit, limit.windowMs, now)) return fail(429, "Too many requests. Wait a minute.");
  // Every call that changes something must come from the game's own pages.
  if (method === "POST" && !sameOrigin(req)) return fail(403, "This call must come from the game's own page.");

  if (method === "GET" && path === "/api/config") {
    return json({
      name: CONFIG.name,
      creator: CONFIG.creator.name,
      testMode: testMode(env),
      turnstileSiteKey: turnstileOn(env) ? env.TURNSTILE_SITE_KEY!.trim() : null,
    });
  }

  if (method === "POST" && path === "/api/signin/start") {
    const body = await readJson(req);
    if (!(await d1Limit(db, `signin|${await visitorKey(db, req)}`, LIMITS.signinStart.limit, LIMITS.signinStart.windowMs, now))) return fail(429, "Too many sign-ins. Wait a few minutes.");
    if (!(await turnstileOk(env, body.turnstile, req.headers.get("CF-Connecting-IP")))) return fail(403, "The person check failed. Try again.");
    return startSignin(db, req, () => now);
  }
  if (method === "POST" && path === "/api/signin/check") return checkSignin(db, req, (await readJson(req)).id, now);
  if (method === "POST" && path === "/api/signout") return signOut(db, req);

  const session = await sessionOf(db, req, now);

  if (method === "GET" && path === "/api/me") {
    if (!session) return json({ address: null, owned: [], admin: false });
    const owned = (await db.prepare("SELECT look_id FROM owned WHERE player = ?").bind(session.address).all<{ look_id: string }>()).results.map((r) => r.look_id);
    return json({ address: session.address, owned, admin: session.address === receiveAddress(env) });
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

  if (path === "/api/admin/summary" && method === "GET") {
    const refused = await adminGuard(env, req, now);
    return refused ?? json(await adminSummary(env, now));
  }
  if (path === "/api/admin/check" && method === "POST") {
    const refused = await adminGuard(env, req, now);
    if (refused) return refused;
    const scan = await sweep(env, { at: now });
    return json({ scan, summary: await adminSummary(env, now) });
  }

  return fail(404, "No such route.");
}

/** Deletes rows nobody needs any more. Orders stay: they are the creator's sales record. */
async function cleanUp(db: D1Database, now: number) {
  await db.batch([
    db.prepare("DELETE FROM signin_requests WHERE expires_at < ?").bind(now - 2 * 3_600_000),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM hits WHERE win < ?").bind(Math.floor((now - 86_400_000) / LIMITS.order.windowMs)),
  ]);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/nano-game.json" && (req.method === "GET" || req.method === "HEAD")) {
        return secure(json(listing(env, req), 200, { "Cache-Control": "public, max-age=300" }), false);
      }
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
