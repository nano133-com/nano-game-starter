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
| `game.config.json` | Name, one line, creator name, listing pictures, round length, the defaults of the two switches (`"character"`, `"signin"`), and `"nanoterraId"` (the game's listing id on Nanoterra, or `null`; checked in `src/shared/config.ts`). Safe to change. |
| `src/worker/admin.ts`, `src/client/admin.ts` | The admin (`/admin`) **is the package** `@nano133/nanoterra` (paths `/admin`, `/admin/d1`, `/admin/panel`, `/admin/style.css`): the guard, the routes, the D1 store, the panel with the "Game" card (two switches, the friends list's choice and "Allow Nanoterra emotes", kept in the `meta` table as `setting:character`, `setting:signin`, `setting:friends` and `setting:emotes`), the Shelf, the orders. These two files only give the package what is this game's own: the owner, the admin session, the status, the looks and the wallet sign-in. See "Rules for looks" (the Shelf never writes) and the admin guard below. |
| `looks.json` | The looks: `id`, `name`, `priceUsd`, and `change` (`body` colour, optional `hat` and `hatColor`), and optional `slots` (a model in `head`, `hand` or `back`). Safe to change, with the rules below. |
| `public/looks/` | The looks' models (`.glb`). Each passes `test/lookModels.test.ts`. |
| `src/client/game/` | The game: `world.ts` (the level), `character.ts` (what a character does, and the penguin), `nanoterraCharacter.ts` (the Nanoterra character), `hat.ts`, `gems.ts`, `controls.ts` (keys and thumbs; they let go when the page is left: `releaseWhenLost` from `@nano133/nanoterra/input`), `game.ts` (rules, speed, camera). `main.ts` pauses a free round when the player leaves the page (`pauseWhenLeft`, same path) and keeps it paused until Resume; a round that costs money must not stop its clock. Safe to change. |
| `src/client/options.ts` | The player's settings (`@nano133/nanoterra/options`): one store, kept in this browser (`n133-options:gem-island`), with the Options key and panel mounted in `main.ts`. See "The options menu" below. |
| `src/client/ui/`, `src/client/style.css` | The account sheet, the admin's own sign-in (`ui/signin.ts`) and the look of the page. The Looks sheet, the pay sheet and the player's sign-in sheet **are the package's** (see "The shop and the player's sign-in"); `style.css` only gives them the game's colours. Change with care (see "Never change"). |
| `public/` | Static files: `art/wide.jpg`, `art/tall.jpg`, `favicon.svg`, and `nanoterra.css` (the look of the sign-in pages: see "Safe changes"). |
| `src/worker/` | The server. See "Never change". The shop and the player's sign-in are the package's: `src/worker/player.ts` only sets them up on this game's tables and settings. The admin's own sign-in is `src/worker/signin.ts`. |
| `src/shared/scheme.ts` | The FROZEN passkey scheme of this game (see "The shop and the player's sign-in"). Set your domain in it once, before the first player; never change it after. |
| `src/shared/` | Code for both sides: looks (`looks.ts`, with the rules in `@nano133/nanoterra/looks`), config, the passkey scheme, security headers. |
| `src/worker/nanoterra.ts` | Sign in from Nanoterra (`/nanoterra/callback`, `/nanoterra/confirm`, `/nanoterra/cancel`): trades a one-time code for the player's details, shows a confirm screen (it and the error pages share one frame, `frame()`, dressed by `public/nanoterra.css`), makes a session on Continue. See "Never change". |
| `src/worker/friends.ts` | The game's own friends list (the admin's friends setting `"own"`): the package's handler (`@nano133/nanoterra/friends`) at `/api/friends` on the D1 tables of `migrations/0007_friends.sql`, with this game's directory of players (a Nanoterra username or a short address; never a full address to the browser). See "The friends list" below. |
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
- **The sign-in pages' look:** the confirm screen ("Sign in as <name>?") and the error pages of Sign in from Nanoterra are plain HTML
  from the Worker (`frame()` in `src/worker/nanoterra.ts`), not part of the game's bundle, so `public/nanoterra.css` is their whole look. To give
  them the game's look, change the tokens in its `:root` (colours, corners, key sizes, the fonts). Optional, and the page looks right without them:
  a picture behind the card (`--nt-picture`, `--nt-picture-tall` and `--nt-dim`, a file in `public/art/`), a logo (the "Optional: your logo"
  rule: a CSS background on `.nt-logo`, so the page has no `<img>`) and your own font (the file in `public/fonts/` WITH its licence, the
  `@font-face` at the top, the name in `--nt-display` or `--nt-body`). The CSP allows only the game's own files (`style-src 'self'`,
  `img-src 'self'`, `font-src 'self'`): no inline style, no font or picture from another site, and never loosen the CSP for a look.
  It is markup and CSS only: keep the words, the forms, their order and the escaped name exactly as they are (`test/nanoterra.test.ts` must
  pass unchanged). Keys stay 48 px or taller (Continue and Play as a guest 56 to 64 px). Check a phone held upright (390x844) and on its side
  (844x390), a tablet and a computer: no sideways scroll, the card and its keys on screen.
- **A look's model:** a look's slot `head`, `hand` or `back` names a model in `public/looks/` (`"slots": { "hand": "shovel" }` is
  `public/looks/shovel.glb`). `src/client/game/worn.ts` loads it (GLTFLoader, only when worn), shares it and frees it; the Nanoterra character
  hangs it on `socket(slot)` and the penguin on its own flipper, head or back. A hand model has an empty `grip_R` node where the hand holds it.
  `test/lookModels.test.ts` runs the package's cosmetic check (`@nano133/nanoterra/model`, `COSMETIC_LIMITS[slot]`) on every model there: never
  add an exception to make a new model pass. In a run, `hold` in `worn.ts` turns a hand model down (the elbow's bend would lift it in front of the
  face); a back model gets the package's `hideTail` and `hideWings`.
- Keep the first load small (no big model or sound files without a reason), and keep 60 frames a
  second on a mid-range phone: few objects, simple materials, no real-time shadows.

## Rules for looks

- A look only changes how the character looks. **It never changes a score, a speed or a rule.**
- Every look shows its price before the player buys. **Nothing random: no loot boxes, no mystery
  items, no chances.**
- **Never change or remove the `id` of a look that someone may own.** Owned looks are stored by id.
  To retire a look, keep it in the file.
- Prices are in US dollars with at most 4 decimals: there is no minimum, so a fraction of a cent works (`0.005` is half a
  cent). The server reads them from `looks.json`; the browser never decides a price.
- The rules of the file are in the package `@nano133/nanoterra`, path `/looks` (`checkLooks`, `lookProblems`, `removalProblems`, `looksJson`). Use them; do not
  copy them. (The old check refused $0.07, $0.29 and $1.10: `priceStepOk` and `wholeCents` compare a price with its own decimal text.)
- **The Shelf (`/admin`) never writes.** It edits a draft in the creator's browser and gives text to copy. Do not add a server call that
  changes `looks.json`, the database's looks or prices: an editor would give the server a new way to change data. A change of looks is a
  change of the repository, pushed to GitHub. **The "Game" card is not the Shelf:** its two switches, the friends list and the emotes (`POST /api/admin/game`) write only the four
  settings `setting:character`, `setting:signin`, `setting:friends` and `setting:emotes`, behind the same admin guard; the route takes nothing else, and the package's store contract (run in
  `test/adminConformance.test.ts`) proves that saving changes no other `meta` row, order or owned look. Keep it that way: never add a looks, price, order or address field to it.
- `GITHUB_REPO` (a setting, `owner/name`) only makes the Shelf link to `looks.json`. It is not a secret and it gives the game no GitHub access.

## The friends list

- The admin's **Game** card has a third choice, the friends list: `"nanoterra"` (the default), `"own"` or `"off"` (`setting:friends` in `meta`). The Worker reads
  it in ONE place, `settingsOf` in `src/worker/admin.ts`, and gives it in `GET /api/config` as `friends`, with `nanoterraId` from `game.config.json`. Do not read it
  anywhere else.
- `src/client/main.ts` mounts the key once, after `/api/config` (`mountFriends`, `@nano133/nanoterra/friends/panel`, and its `style.css`), in `#friends` in the HUD's
  right group. **Never hide it with `display: none` and never remove it:** in the `"nanoterra"` mode its window holds the player's live connection. With `"nanoterra"`
  and no `nanoterraId` there is no key, and `/admin` says why. `whereNow()` gives the plain text that friends see; keep it short and true.
- `/api/friends` answers only in the `"own"` mode (404 in the others). Its player is the PLAYER session (`signin.session()`, cookie `session`), **never the admin cookie**. The
  package's handler checks the origin (a POST from the game's own page) and the limit (30 calls a minute for each player). `test/friends.test.ts` runs the package's
  `friendsStoreConformance` on the real D1 tables, and pins the refusals.
- The window's frame comes from `https://nano133.com` (`frame-src` in `src/shared/security.ts`). Do not add another origin for it.
- There is no "Delete my data" yet. A page that adds one calls `friendsStore(env).forget(address)` too (and the shop's and the sign-in's, see below).

## The options menu

- `src/client/options.ts` makes ONE store (`createOptions`, `@nano133/nanoterra/options`) with only the settings the game honours: Camera speed, Move stick (a phone
  and a tablet), Invert look, Less motion, Quality, and the Jump key (a desktop). The browser keeps only what differs from the device's default, under
  `n133-options:gem-island`. `main.ts` mounts the gear key in `#options` (the HUD's right group) with `mountOptions`, and holds the round still while the panel is open,
  as it does for the sheets and the friends panel (`holdGame`).
- Where each one works: `controls.ts` reads Camera speed (50 is the game's own speed: `TOUCH_LOOK` and `MOUSE_LOOK` times value / 50), Invert look, Move stick (the
  stick's half of the screen; `style.css` moves Jump and Emotes to the other side) and the Jump key (`keys.jump`, a `KeyboardEvent.code`); `game.ts` sets the
  pixel ratio from Quality (low 1, medium 1.5, high 1.75 on a touch screen and 2 elsewhere) and gives Less motion to the character; `style.css` calms the HUD with
  `html[data-n133-opt-reduced-motion="true"]` (`reflectOptions`). Each value is read when it is used, or followed with `options.subscribe`, so a change works at once.
- **To add a setting:** add its def to `defs` in `options.ts` (a kit setting by name with `common("...")`, or your own: `{ kind: "toggle", key: "hints", label:
  "Show hints", tab: "basic", group: "Game", default: true }`; kinds `"toggle"`, `"choice"`, `"range"` and `"key"`), read it with `options.get("hints")` where the game
  uses it, and follow a change with `options.subscribe`. Offer only what the game really does (the starter has no sound, so it offers no volume). Never keep a second
  copy of a setting in your own storage, and never use a setting for a rule, a score or a price. The kit's README ("The options menu") has every field.

## Emotes

- Nanoterra's eleven emotes (Wave, Cheer, Clap, Dance, Bow, Shrug, Laugh, Point, Sit, Facepalm, Spin) on the kit's wheel (`@nano133/nanoterra/emotes`), for the
  Nanoterra character only: the penguin has none. `main.ts` mounts the Emotes key in `#emotes` (above Jump on a touch screen) once `/api/config` has answered, and
  only then adds the wheel's own settings to the options ("Show the Emotes key" and the wheel's key, B; a multiplayer game adds all of `EMOTE_OPTIONS`, with "Show
  other players' emotes"). The round
  holds still while the wheel is open. `nanoterraCharacter.ts` plays a pick (`createEmotes(body).play(id)`); the character's `update` plays it over the walk, and a
  move or a jump ends a whole-body one (Dance, Sit).
- **The clips load only when the wheel first opens** (`loadEmotes`, a chunk of its own, `clips-<hash>.js`, and the pictures `icons-<hash>.webp`). Never import the
  clips yourself: they must stay out of the first load.
- **The admin's switch:** the Game card's "Allow Nanoterra emotes" (`emotes`, `"on"` by default, or `"off"`) is read in ONE place, `settingsOf`, and given in
  `GET /api/config` as `emotes`. Off: no key and no wheel (a game with its own emotes keeps those on the wheel; see below).
- **A game's own emotes:** give the wheel the list, Nanoterra's ids and your own: `mountEmotes(el, { ..., emotes: ["wave", "dance", { id: "flip", label: "Flip",
  icon: "/art/flip.png" }], onPlay: (id) => (id === "flip" ? myFlip() : game.emote(id)) })`. An emote is display only: never a score, a rule or a price.
- **Multiplayer** (the starter is single-player): send each emote from `createEmotes(body, { onEmote: (e) => send(emoteMessage(e)) })` and play the others' with
  `playRemote(theirBody, { id: readEmoteMessage(message) }, { options })`, and add `EMOTE_OPTIONS` to the store; with `emotes` `"off"`, send none and play none. The kit's README ("Emotes") has the rest.

## The shop and the player's sign-in

Both come from the package `@nano133/nanoterra` (since 0.9.0). The game does not keep a copy of either: do not copy their code back into this repository.

- **The shop** (`@nano133/nanoterra/shop`): the order routes (`POST /api/orders`, `GET /api/orders/{id}`, `POST /api/orders/{id}/check`), the unique clean
  amount of each order, the match on the ledger, the price, the nodes and the payment scan. `src/worker/player.ts` makes it with `createShop(env, { catalogue:
  looks.json, player })` from `/shop/worker`; the cron (`*/10`, `scheduled` in `src/worker/index.ts`) and the admin's "Check payments now" call `shop.scan()`.
  The page mounts `mountShop` (`/shop/panel`, with `key: false`: the game's own Looks keys call `shop.open()`) and its stylesheet. The tables are the game's own
  (`orders`, `owned`, `meta`, `hits`, from `migrations/0001_init.sql`): the package reads and writes them as they are.
- **The player's sign-in** (`@nano133/nanoterra/player-signin`): a passkey, or Berry Wallet, NanChat or Nautilus, on `/api/signin/*` and `/api/signout`, with
  the session cookie `session`. `src/worker/player.ts` makes it with `createPlayerSignin({ store: createD1PlayerSignin(env.DB), ..., sharedPaths: true })`.
  `sharedPaths` is there because the ADMIN signs in on the same paths (`scope: "admin"`): the package leaves those calls to `src/worker/signin.ts`. Everything
  that needs the player reads `signin.player(request)` or `signin.session(request)` (the shop, `/api/me`, the friends list); never an address from a body. A
  sign-in from Nanoterra makes its session with `signin.signIn(request, address, "nanoterra")`. The page mounts `mountPlayerSignin` (`/player-signin/panel`)
  and its stylesheet; the account key and the shop's Buy open it. `migrations/0008_player_signin.sql` is the package's `d1.sql`: it adds `signin_once` (the
  passkey's once-only keys) and keeps every table and session.
- **The passkey scheme is FROZEN** (`src/shared/scheme.ts`). A passkey player's account, and so every look they buy, lies at the address its three texts give.
  The template has `your-game.example`. **The creator sets their game's domain in the three texts ONCE, before the first player**, runs `npm test`, and writes
  the two new vectors that `test/scheme.test.ts` prints into that test. After the first player, never change a character of it, and never change the vectors
  to make the test pass: every passkey player would lose their looks. A new scheme is a new `versionByte` with new texts, never an edit.
- **No passkey on `*.workers.dev`.** A passkey belongs to one domain for good, and a game on the preview address moves to its own domain later. So on
  `*.workers.dev` the sign-in sheet offers the wallet apps only (the package's default; do not pass `passkey: true`), and `/admin` says "Passkeys turn on when your
  game has its own domain." (`mountAdmin(..., { playerPasskeys: true })` in `src/client/admin.ts`). Set the domain before the first passkey player.
- **What the game keeps:** `looks.json` (the shop's catalogue, the page's list and the admin's Shelf: the same file), `wrangler.jsonc` and the secrets (the shop
  reads `RECEIVE_ADDRESS`, `TEST_MODE`, `NODE_API_KEY`, `NANO_NODES`, `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` itself), the frozen scheme, the account
  sheet, the admin's sign-in and the Content Security Policy (`src/shared/security.ts` merges the shop's `SHOP_CSP` into the game's own list with `mergeCsp`).
- **"Delete my data"** (the starter has none): a page that adds one calls `playerSignin(env).forget(address)`, `shopOf(env).store.forget(address, Date.now())`
  (it answers `waitUntil` while an order of the player may still be paid: try again then) and `friendsStore(env).forget(address)`.

## Never change (without the creator's clear yes, and new tests)

These parts protect the creator's money and the players. If the creator asks to change one, explain
the risk first, then change it only with tests in `test/` that show the new rule.

1. **The payment check** (the package's shop: do not copy it back, do not wrap it with a looser one): exact amount, to the
   creator's address, a confirmed send, first seen after the order (less 2 minutes for clocks). One
   payment pays one order, once.
2. **The reservation** (the package's shop, on the UNIQUE `amount_lock` column of `orders`): no two waiting
   orders ever ask for the same amount. Amounts are clean (at most 4 decimals of XNO) because some
   wallets shorten longer amounts, and then a payment matches nothing.
3. **Amounts as text and BigInt** (the package's shop). Never use a float for an amount that is
   paid or compared. Round prices up, never down.
4. **Test mode** (the package's shop: its answer and its pay sheet; `RECEIVE_ADDRESS` and `TEST_MODE` in `wrangler.jsonc`): without a real address, or with
   `TEST_MODE` on, a pay screen shows **TEST MODE: DO NOT PAY**, no QR code, no address and no wallet
   link. A payment to an address nobody holds the key for is lost for good.
5. **The admin guard** (the package's `adminAccess`, used by the handler that `src/worker/admin.ts` makes; every `/api/admin/*` route is behind it, the "Game" card's too): only the
   creator's own `RECEIVE_ADDRESS`, signed in with Nano within the last day, can read or change anything under `/api/admin`. **Do not copy the guard back into this repository and do not
   loosen it.** The part that is this game's own (the owner and the admin session) is in `src/worker/admin.ts`; `test/adminConformance.test.ts` runs the package's conformance suite
   against it, so a wrong cookie, a missing owner or a route outside the guard fails a test. **The admin login is its own cookie** (`admin`, made only by a wallet
   signature that `/admin` started, `scope: "admin"`; the game's is `session`): the guard reads only the admin cookie, so a login made for
   the game (a wallet, or Nanoterra) can never open `/admin`, and an admin login is not a player. Keep it that way.
6. **Sign-in** (the player's: the package's `@nano133/nanoterra/player-signin`; the admin's: `src/worker/signin.ts`; both check signatures with
   `@nano133/signin`): players sign in with a passkey, Berry Wallet, NanChat or Nautilus. The signed text names the game's domain; only the browser that
   started a sign-in gets the session; one session per sign-in. The player's sign-in never makes an admin login, and it never reads, delivers or deletes
   an admin row (`scope = 'admin'`). Whichever wallet signs, only `RECEIVE_ADDRESS` opens
   `/admin`. **The passkey scheme** (`src/shared/scheme.ts`) is frozen after the first player (see "The shop and the player's sign-in"). **The admin's wallet text names the admin** (Berry: the `uri` is `/admin`, with no query: Berry Wallet refused `/admin?from=US` on a device test, 2026-10-27; Nautilus: the label is `ADMIN of <host> sign-in <code> from <country>`), an admin
   request lives 2 minutes (`ADMIN_REQUEST_MS`) and is delivered for one more minute (`ADMIN_DELIVER_MS`), NanChat is refused for the admin, and Berry's kind (admin or game) is kept in the
   request's `scope` column (migration 0006, written when it starts, read again by `kindOf` and by `checkSignin`: a request started for one scope can never make a login in the other,
   whatever the browser presents; a starter cookie that is not 64 hex characters is no starter) so the wallet's GET and POST get the same text; `adminSession` also checks the row's scope. `test/adminSignin.test.ts` pins that a game signature never opens `/admin` and an admin one never makes a
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
- `window.__gemIsland.snapshot()` gives the game's state to automated browser checks (the place `x`, `y`, `z`, the camera's `yaw` and `pitch`, the `pixelRatio`).
