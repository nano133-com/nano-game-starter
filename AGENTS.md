# AGENTS.md

Notes for an AI coding assistant (Claude Code, Codex, Cursor, Gemini and others) that helps a creator
change this game. The creator may not be a programmer: explain each change in plain words, and ask
before anything that touches money, sign-in or secrets.

## What this is

A small 3D game (Three.js, built with Vite) and a Cloudflare Worker (TypeScript) with a D1 database. The
game sells **looks** (cosmetics) for Nano (XNO). The money goes straight from the player's wallet to the
creator's address. The Worker holds **no key**: it only reads the Nano ledger to see that a payment came.

| Path | What |
|---|---|
| `game.config.json` | Name, one line, creator name, listing pictures, round length. Safe to change. |
| `looks.json` | The looks: `id`, `name`, `priceUsd`, and `change` (`body` colour, optional `hat` and `hatColor`). Safe to change, with the rules below. |
| `src/client/game/` | The game: `world.ts` (the level), `character.ts`, `gems.ts`, `controls.ts`, `game.ts` (rules, speed, camera). Safe to change. |
| `src/client/ui/`, `src/client/style.css` | The sheets (looks, sign-in, pay) and the look of the page. Change with care (see "Never change"). |
| `public/` | Static files: `art/wide.jpg`, `art/tall.jpg`, `favicon.svg`. |
| `src/worker/` | The server. Money and sign-in live here. See "Never change". |
| `src/shared/` | Code for both sides: amounts (`amount.ts`), looks, config, security headers. |
| `migrations/` | The database tables. Add a new numbered file; never edit an applied one. |
| `test/` | Tests for money, records and sign-in. |

## How to work

```sh
npm install
npm run dev        # build, apply the local database, run on http://localhost:8787
npm run check      # typecheck + tests + build: run it before every commit
```

- Local secrets go in `.dev.vars` (copy `.dev.vars.example`). Git ignores it.
- A push to the creator's GitHub repository deploys the game (Cloudflare Workers Builds runs
  `npm run build`, then `npm run deploy`, which applies new database migrations first).
- To deploy by hand: `npx wrangler login`, then `npm run deploy`.
- Test the game on a phone first (portrait and landscape), then a tablet, then a computer.

## Safe changes

- **The level:** add or move trees and rocks in `world.ts` (each one also needs a collider), change
  colours, the sky, the island's size (`ISLAND_RADIUS`).
- **The rules:** speed, jump, gravity and camera in `game.ts`; the round's length and the number of
  gems in `game.config.json`; how gems score in `gems.ts`.
- **The character:** shapes and hats in `character.ts`. A new hat needs its name in `HATS`
  (`src/shared/looks.ts`) and a `case` in `Character.wear`.
- **Looks:** add a look to `looks.json` with a new `id`. Keep one free look (`priceUsd: 0`).
- Keep the first load small (no big model or sound files without a reason), and keep 60 frames a
  second on a mid-range phone: few objects, simple materials, no real-time shadows.

## Rules for looks

- A look only changes how the character looks. **It never changes a score, a speed or a rule.**
- Every look shows its price before the player buys. **Nothing random: no loot boxes, no mystery
  items, no chances.**
- **Never change or remove the `id` of a look that someone may own.** Owned looks are stored by id.
  To retire a look, keep it in the file.
- Prices are in US dollars with at most 2 decimals. The server reads them from `looks.json`; the
  browser never decides a price.

## Never change (without the creator's clear yes, and new tests)

These parts protect the creator's money and the players. If the creator asks to change one, explain
the risk first, then change it only with tests in `test/` that show the new rule.

1. **The payment check** (`src/worker/match.ts`, `src/worker/sweep.ts`): exact amount, to the
   creator's address, a confirmed send, first seen after the order (less 2 minutes for clocks). One
   payment pays one order, once.
2. **The reservation** (`src/worker/orders.ts`, the UNIQUE `amount_lock` column): no two waiting
   orders ever ask for the same amount. Amounts are clean (at most 4 decimals of XNO) because some
   wallets shorten longer amounts, and then a payment matches nothing.
3. **Amounts as text and BigInt** (`src/shared/amount.ts`). Never use a float for an amount that is
   paid or compared. Round prices up, never down.
4. **Test mode** (`src/worker/env.ts`, `src/client/ui/pay.ts`): without a real address, or with
   `TEST_MODE` on, a pay screen shows **TEST MODE: DO NOT PAY**, no QR code, no address and no wallet
   link. A payment to an address nobody holds the key for is lost for good.
5. **The admin guard** (`src/worker/admin.ts`): only the creator's own `RECEIVE_ADDRESS`, signed in
   with Nano within the last day, can read `/api/admin/*`.
6. **Sign-in** (`src/worker/signin.ts`, the `@nano133/signin` package): players sign in with Berry
   Wallet, NanChat or Nautilus. The signed text names the game's domain; only the browser that started a
   sign-in gets the session; one session per sign-in. Whichever wallet signs, only `RECEIVE_ADDRESS` opens
   `/admin`. NanChat's answers all come through its relay server, so their limits are totals and per
   sign-in, never per visitor.
7. **Security headers and CORS** (`src/shared/security.ts`, `src/worker/http.ts`): a strict Content
   Security Policy; calls that change something must come from the game's own pages. Do not loosen
   them to make a feature work: find another way.
8. **Secrets** (`NODE_API_KEY`, `TURNSTILE_SECRET`): only in Cloudflare secrets or `.dev.vars`.
   Never in code, `wrangler.jsonc`, a commit, a log or a message. Never add a seed or a private key to
   this project: the game must stay watch-only.

## Good to know

- A late payment (after the 15-minute order) is recorded as **paid late**; the look is not given.
  The creator sends it back by hand. The game cannot: it has no key.
- Payments are found by the player's page (every 5 seconds, 2 minutes per check), by `/admin`
  ("Check payments now"), and by a cron every 10 minutes.
- Prices: the median of CoinGecko, Kraken and KuCoin (no keys). CoinGecko's terms ask for "Powered by
  CoinGecko" on the pay screen: keep it.
- Workers Free allows 10 ms of CPU per request. One signature check takes about 0.4 ms (Berry Wallet,
  Nautilus) or 2 ms (NanChat); `src/worker/warm.ts` moves each kind's first-use cost to the Worker's
  start-up. `npm run bench:signin` measures it.
- The Nautilus app and NanChat's relay server post to `/api/signin/nautilus` and `/api/signin/nanchat`.
  If a firewall rule (for example Bot Fight Mode) stands in front of the game, it must let them through.
- `/nano-game.json` is the listing for Nano Island. It never lists looks or prices.
- `window.__gemIsland.snapshot()` gives the game's state to automated browser checks.
