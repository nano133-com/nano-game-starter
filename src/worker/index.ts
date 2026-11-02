// The game's Worker: the API under /api, the listing at /nano-game.json, and the payment scan every
// 10 minutes. The game's files (index.html, admin.html, /assets) are served by Cloudflare without it.

import { freePlayOn, signinOn, type GameSettings } from "@nano133/nanoterra/admin";
import { SHOP_LIMITS } from "@nano133/nanoterra/shop/worker";
import { CONFIG } from "../shared/config";
import { adminHandler, adminSigninOf, settingsOf } from "./admin";
import { FRIENDS_BASE, friendsHandler } from "./friends";
import { receiveAddress, type Env } from "./env";
import { fail, json, sameOrigin, secure, visitorIp } from "./http";
import { callback as nanoterraCallback, cancel as nanoterraCancel, confirm as nanoterraConfirm, playerOf, signinOff, start as nanoterraStart } from "./nanoterra";
import { playerSignin, shopOf } from "./player";
import { LIMITS, memoryLimit } from "./ratelimit";
import { warm } from "./warm";

if (!warm) console.warn("the signature warm-up check failed");

/**
 * The listing that Nano Island reads. It never lists looks or prices: the sale is the creator's own. `signin` and `freePlay` are switches of /admin
 * (`signin` starts from game.config.json's word, free play is on until /admin turns it off): the listing file says how the game signs a Nanoterra
 * player in, and whether it has free play.
 */
export function listing(env: Env, req: Request, settings: Pick<GameSettings, "signin" | "freePlay"> = { signin: CONFIG.signin }) {
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
    signin: settings.signin,
    // Free play (the Game card's "Free play", on by default): false says a player must pay in the game to play, and Nanoterra's listing then says "Paid".
    freePlay: freePlayOn(settings),
    // The character is NOT here: its switch is the "Game" card of /admin (or "character" in game.config.json, "nanoterra" or "own"), and only the game's own code reads it.
  };
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

  // The ADMIN's sign-in (the package's, on its own route /api/admin-signin: see admin.ts). It answers only its own paths, with its own limits (the
  // wallet apps' calls 30 a minute and the checks 90 a minute per address, the starts 20 in 10 minutes per visitor in D1), the same-origin rule for the
  // page's calls, and the person check; any other path is null and goes on.
  const adminSignin = await adminSigninOf(env, now).handle(req);
  if (adminSignin) return adminSignin;

  // The PLAYER's sign-in (the package's: a passkey or a wallet app), on /api/signin and /api/signout.
  const signin = playerSignin(env, now);

  // The wallet apps' routes: no cookie and no Origin (an app, or NanChat's relay server, posts them: not a browser page). The player's sign-in answers them.
  const walletPath = /^\/api\/signin\/nano\/[0-9a-f]{32}$/.test(path) || path === "/api/signin/nautilus" || path === "/api/signin/nanchat";
  if (walletPath) {
    const answer = await signin.handle(req);
    if (answer) return answer;
  }

  const pollRoute = path === "/api/signin/check" || /^\/api\/orders\/[0-9a-f]{24}\/check$/.test(path);
  const limit = pollRoute ? LIMITS.poll : LIMITS.other;
  if (!memoryLimit(`${pollRoute ? "poll" : "other"}|${ip}`, limit.limit, limit.windowMs, now)) return fail(429, "Too many requests. Wait a minute.");
  // Every call that changes something must come from the game's own pages.
  if (method === "POST" && !sameOrigin(req)) return fail(403, "This call must come from the game's own page.");

  // The player's own calls: start, check, the passkey and sign-out (the session cookie `session`).
  if (!walletPath) {
    const answer = await signin.handle(req);
    if (answer) return answer;
  }

  // The shop (the package's): POST /api/orders, GET /api/orders/{id}, POST /api/orders/{id}/check. Its player is the PLAYER's sign-in, never the admin cookie.
  const shop = shopOf(env, now, (r) => signin.player(r));

  if (method === "GET" && path === "/api/config") {
    const settings = await settingsOf(env);
    return json({
      name: CONFIG.name,
      creator: CONFIG.creator.name,
      // Whether pay screens are in test mode, and Turnstile's site key or null: the shop's rules.
      ...shop.config(),
      // The "Game" card of /admin: which character the players are (the game draws it), whether sign-in from Nanoterra is on, and which
      // friends list the game shows ("nanoterra", "own" or "off"), and whether the emote wheel holds Nanoterra's emotes ("on" or "off").
      character: settings.character,
      nanoterraSignin: signinOn(settings.signin),
      friends: settings.friends,
      emotes: settings.emotes,
      // The game's id on Nanoterra (game.config.json), or null: the Nanoterra friends window needs it.
      nanoterraId: CONFIG.nanoterraId,
    });
  }

  const order = await shop.handle(req);
  if (order) return order;

  const session = await signin.session(req);

  // The game's own friends list. It answers only while the admin's friends setting is "own": in the other modes /api/friends is no route (404),
  // and the friends tables are not read. The player is the PLAYER session above (the `session` cookie), never the admin cookie.
  if (path === FRIENDS_BASE && (await settingsOf(env)).friends === "own") {
    const friends = await friendsHandler(env, now, ip, session?.address ?? null).handle(req);
    if (friends) return friends;
  }

  if (method === "GET" && path === "/api/me") {
    if (!session) return json({ address: null, owned: [], admin: false });
    const owned = await shop.owned(session.address);
    // The name and the character of a player who signed in from Nanoterra (the game's own screens may show them). `look`: the five colours; `record`: the whole character
    // (two numbers, `unpackRecord` in the page reads them), when Nanoterra sent one.
    const nanoterra = session.via === "nanoterra" ? await playerOf(db, session.address) : null;
    return json({ address: session.address, owned, admin: session.via === "wallet" && session.address === receiveAddress(env), via: session.via, ...(nanoterra ? { username: nanoterra.username, look: nanoterra.look, ...(nanoterra.record ? { record: { v: 2, k: nanoterra.record } } : {}), nanoterraItems: nanoterra.items } : {}) });
  }

  // The admin: the package's handler (the guard first, then the summary, the "Game" card and the payment check). It answers EVERY path under /api/admin,
  // so a visitor who is not the owner learns nothing about the routes.
  const admin = await adminHandler(env, now, ip).handle(req);
  if (admin) return admin;

  return fail(404, "No such route.");
}

/**
 * Deletes rows nobody needs any more: old limit counters. (The player's rows are the player sign-in's `clean()`; the admin's old requests, ended logins
 * and sign-in rows past 30 days are the admin sign-in's `clean()`.) Orders stay: they are the creator's sales record.
 */
async function cleanUp(db: D1Database, now: number) {
  // Every D1 counter (new orders, sign-in starts, NanChat's totals, Nanoterra's once-only keys) counts in 10-minute windows.
  await db.prepare("DELETE FROM hits WHERE win < ?").bind(Math.floor((now - 86_400_000) / SHOP_LIMITS.order.windowMs)).run();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/nano-game.json" && (req.method === "GET" || req.method === "HEAD")) {
        // 60 seconds, not 300: a switch of /admin shows in the listing within a minute.
        return secure(json(listing(env, req, await settingsOf(env)), 200, { "Cache-Control": "public, max-age=60" }), false);
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
        const scan = await shopOf(env, now).scan(now);
        if (scan.error) console.warn("payment scan", scan.error);
        await playerSignin(env, now).clean(now);
        await adminSigninOf(env, now).clean(now);
        await cleanUp(env.DB, now);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
