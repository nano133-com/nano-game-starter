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
| `game.config.json` | Name, one line, creator name, listing pictures, round length, and the defaults of the two switches (`"character"`, `"signin"`). Safe to change. |
| `src/worker/admin.ts`, `src/client/admin.ts` | The admin (`/admin`) **is the package** `@nano133/nanoterra` (paths `/admin`, `/admin/d1`, `/admin/panel`, `/admin/style.css`): the guard, the routes, the D1 store, the panel with the "Game" card (two switches kept in the `meta` table as `setting:character` and `setting:signin`), the Shelf, the orders. These two files only give the package what is this game's own: the owner, the admin session, the status, the looks and the wallet sign-in. See "Rules for looks" (the Shelf never writes) and the admin guard below. |
| `looks.json` | The looks: `id`, `name`, `priceUsd`, and `change` (`body` colour, optional `hat` and `hatColor`). Safe to change, with the rules below. |
| `src/client/game/` | The game: `world.ts` (the level), `character.ts` (what a character does, and the penguin), `nanoterraCharacter.ts` (the Nanoterra character), `hat.ts`, `gems.ts`, `controls.ts`, `game.ts` (rules, speed, camera). Safe to change. |
| `src/client/ui/`, `src/client/style.css` | The sheets (looks, sign-in, pay) and the look of the page. Change with care (see "Never change"). |
| `public/` | Static files: `art/wide.jpg`, `art/tall.jpg`, `favicon.svg`. |
| `src/worker/` | The server. Money and sign-in live here. See "Never change". |
| `src/shared/` | Code for both sides: amounts (`amount.ts`), looks (`looks.ts`, with the rules in `@nano133/nanoterra/looks`), config, security headers. |
| `src/worker/nanoterra.ts` | Sign in from Nanoterra (`/nanoterra/callback`, `/nanoterra/confirm`, `/nanoterra/cancel`): trades a one-time code for the player's details, shows a confirm screen, makes a session on Continue. See "Never change". |
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
- **The character:** `game.config.json` `character` is the ONE switch: `"nanoterra"` (the default: `nanoterraCharacter.ts`, the package
  `@nano133/nanoterra`, path `/character`, as the character the player picked in Nanoterra: the record that `/api/me` gives) or `"own"` (the penguin in
  `character.ts`). Do not read it anywhere else, and do not put it in `nano-game.json` (the listing does not carry it). Both do what `Avatar` in
  `character.ts` says, so `game.ts` does not know which it has. The hats are in `hat.ts` and both wear them (on a Nanoterra body each base has its own head: the kit's
  `BASE_SPECS[base].hat` says where a hat sits): a new hat needs its name in `HATS` (`src/shared/looks.ts`) and a `case` in `buildHat`. A shop look that costs
  something paints the Nanoterra character's shirt (its body when it wears no top); the free look must never hide the character that a signed-in player brought.
  The body is display only: never give a base or a size a different collider, jump or reach.
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
- The rules of the file are in the package `@nano133/nanoterra`, path `/looks` (`checkLooks`, `lookProblems`, `removalProblems`, `looksJson`). Use them; do not
  copy them. (The old check refused $0.07, $0.29 and $1.10: `wholeCents` fixes that.)
- **The Shelf (`/admin`) never writes.** It edits a draft in the creator's browser and gives text to copy. Do not add a server call that
  changes `looks.json`, the database's looks or prices: an editor would give the server a new way to change data. A change of looks is a
  change of the repository, pushed to GitHub. **The "Game" card is not the Shelf:** its two switches (`POST /api/admin/game`) write only the two
  settings `setting:character` and `setting:signin`, behind the same admin guard; the route takes nothing else, and the package's store contract (run in
  `test/adminConformance.test.ts`) proves that saving changes no other `meta` row, order or owned look. Keep it that way: never add a looks, price, order or address field to it.
- `GITHUB_REPO` (a setting, `owner/name`) only makes the Shelf link to `looks.json`. It is not a secret and it gives the game no GitHub access.

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
5. **The admin guard** (the package's `adminAccess`, used by the handler that `src/worker/admin.ts` makes; every `/api/admin/*` route is behind it, the "Game" card's too): only the
   creator's own `RECEIVE_ADDRESS`, signed in with Nano within the last day, can read or change anything under `/api/admin`. **Do not copy the guard back into this repository and do not
   loosen it.** The part that is this game's own (the owner and the admin session) is in `src/worker/admin.ts`; `test/adminConformance.test.ts` runs the package's conformance suite
   against it, so a wrong cookie, a missing owner or a route outside the guard fails a test. **The admin login is its own cookie** (`admin`, made only by a wallet
   signature that `/admin` started, `scope: "admin"`; the game's is `session`): the guard reads only the admin cookie, so a login made for
   the game (a wallet, or Nanoterra) can never open `/admin`, and an admin login is not a player. Keep it that way.
6. **Sign-in** (`src/worker/signin.ts`, the `@nano133/signin` package): players sign in with Berry
   Wallet, NanChat or Nautilus. The signed text names the game's domain; only the browser that started a
   sign-in gets the session; one session per sign-in. Whichever wallet signs, only `RECEIVE_ADDRESS` opens
   `/admin`. **The admin's wallet text names the admin** (Berry: the `uri` is `/admin`, with no query: Berry Wallet refused `/admin?from=US` on a device test, 2026-10-27; Nautilus: the label is `ADMIN of <host> sign-in <code> from <country>`), an admin
   request lives 2 minutes (`ADMIN_REQUEST_MS`) and is delivered for one more minute (`ADMIN_DELIVER_MS`), NanChat is refused for the admin, and Berry's kind (admin or game) is kept in the
   request's `scope` column (migration 0006, written when it starts, read again by `kindOf` and by `checkSignin`: a request started for one scope can never make a login in the other,
   whatever the browser presents; a starter cookie that is not 64 hex characters is no starter) so the wallet's GET and POST get the same text; `sessionOf` also checks the row's scope. `test/adminSignin.test.ts` pins that a game signature never opens `/admin` and an admin one never makes a
   game session. Do not change any of it without that test. The admin's sign-in list keeps only a time, a two-letter country and a short browser name (`src/worker/browser.ts`): never an
   address, an IP or a browser text. NanChat's answers all come through its relay server, so their limits are totals and per
   sign-in, never per visitor.
7. **Security headers and CORS** (`src/shared/security.ts`, `src/worker/http.ts`): a strict Content
   Security Policy; calls that change something must come from the game's own pages. Do not loosen
   them to make a feature work: find another way.
8. **Secrets** (`NODE_API_KEY`, `TURNSTILE_SECRET`, `NANOTERRA_SECRET`): only in Cloudflare secrets or `.dev.vars`.
   Never in code, `wrangler.jsonc`, a commit, a log or a message. Never add a seed or a private key to
   this project: the game must stay watch-only.
9. **Sign in from Nanoterra** (`src/worker/nanoterra.ts`, the `via` column of `sessions`): `/nanoterra/start` makes a STATE and keeps it in a cookie
   of this browser (`nanoterra-state`, HttpOnly, SameSite=Lax, 10 minutes), then goes to nano133.com's authorize address with the client id and the
   state; the callback accepts `?state=` ONLY when it equals that cookie (compared in constant time, both of the right shape) and drops the cookie in
   every answer after that (a state works once): this is the login CSRF defence, never loosen it or trade a code first. The one-time code is
   traded for the player's details by a call from the Worker, with the client secret and the state; the answer is read strictly. The callback makes NO session:
   it shows "Sign in as <name>? Continue / Not me" and sets a signed pending cookie (5 minutes, SameSite=Lax). Only
   `POST /nanoterra/confirm` makes the session, and only with that cookie, an Origin of this game and the `bind` field of the screen
   (a hash of the cookie's token: a second callback in the same browser cannot ride a press on the old screen); a pending cookie works
   once (`hits`, by its id), also against "Not me" (this stops a link that holds someone else's code from signing a victim in as that
   person). The cookie reader compares a name exactly (`trimAscii` in `http.ts`): never go back to `trim()`, which lets a sibling subdomain
   toss a cookie that passes for a `__Host-` one. The name on the screen is escaped. The session it makes
   (`via: "nanoterra"`) NEVER opens `/admin` (only a wallet signature does). A page never holds the secret, and the code is never
   logged. Whatever the game gives a player (a look, a score, a prize) must not depend on a Nanoterra sign-in alone if it would
   be wrong to give it to whoever holds that name: show the signed-in name first, and make clear whose account it is before a payment.

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
