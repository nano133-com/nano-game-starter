# Nano game starter

A small 3D game that you own and run on your own free Cloudflare account. Players collect gems on an
island. They can buy **looks** for their character (a colour, a hat) and pay you in **Nano (XNO)**,
straight to your own wallet. You change the game with your AI assistant.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nano133-com/nano-game-starter)

- **Your game, your sales.** The game, the orders and the payments live in your own Cloudflare account.
  Nobody else sees your sales.
- **No keys on the server.** The game only needs your public Nano address. It never holds a seed or a
  private key, so it cannot send money anywhere.
- **Fair looks.** Every look shows its price. Nothing is random, and there are no loot boxes. A look
  never changes a score.
- **Phones first.** A thumbstick on the left, camera on the right. Keyboard and mouse on a computer.

## Launch your game in 6 steps

1. **Get a Nano address.** Install [Berry Wallet](https://www.berrywallet.org) on your phone. Tap Receive
   and copy your address (it starts with `nano_`).
2. **Click "Deploy to Cloudflare"** (above). Sign in to GitHub and Cloudflare (both are free).
   Cloudflare copies this project into your GitHub account, makes the database, and puts the game
   online. On the setup page, paste your address into `RECEIVE_ADDRESS` and leave the other fields as they are
   (step 4 adds the optional keys later).
3. **Try it in test mode.** Open your game's address (`https://<name>.<you>.workers.dev`). Until your
   own address is set, every pay screen says **TEST MODE: DO NOT PAY**. Open `/admin` and sign in with
   the wallet that holds your address: only your own address can open it. The admin login is its own: you can be signed in to
   the game as a player and to `/admin` as the creator at the same time (two cookies). The admin login lasts one day: sign out of `/admin`
   before you share the browser.
4. **Turn on the protections.** In the Cloudflare dashboard (Workers & Pages, your game, Settings,
   Variables and Secrets), add a Nano node API key as the secret `NODE_API_KEY` (for
   example [Nanswap Nodes](https://nanswap.com/nano-node); read the provider's terms first, because some free
   keys are for personal use only), and the keys of a free
   [Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) widget in `TURNSTILE_SITE_KEY` and the
   secret `TURNSTILE_SECRET`. The admin page tells you what is still off. Without a key, the game checks
   payments on public Nano nodes.
5. **Make it yours.** Open your copy on GitHub with your AI assistant (Claude Code, Codex, Cursor and
   others). Ask for a new level, new looks or new rules. It reads `AGENTS.md` first. Each change you
   push to GitHub goes live by itself. A ready prompt is in `ai/PROMPT.md`.
6. **Sell, and get listed.** Set `TEST_MODE` to `off`, buy a cheap look yourself, and check `/admin`.
   Your game's listing file is at `https://<your game>/nano-game.json`. When the Nano Island creator
   program opens ([nano133.com/build/islands](https://nano133.com/build/islands)), Nano Island lists your
   game from that file; the sale stays with you.

## The Shelf: see and change your looks

Open `/admin` and look at **Shelf**. It shows each look with a small picture, its price (and its step on the
[price ladder](https://nano133.com/build/cosmetics), from 1¢ to $1), and what it has sold in your own database. Press
**Edit the shelf** to change a name, a price, a colour or a hat, add a look, or copy one. The page checks every change with
the rules of the looks ladder in [`@nano133/nanoterra`](https://www.npmjs.com/package/@nano133/nanoterra) (path `/looks`): at least one free look, prices in whole cents, and **a
look that a player owns stays in the file** (it cannot be removed here).

**The Shelf changes nothing in your game.** It works on a draft in your browser and sends nothing to the server, nothing to nano133.com and
nothing to GitHub. When you like the draft, press **Copy looks.json** and put the text in `looks.json` in your repository, or press
**Copy a message for my AI** and give it to your AI assistant. Push to GitHub: your game builds again and the new looks go live. If you set
`GITHUB_REPO` (for example `your-name/your-game`) in `wrangler.jsonc`, the Shelf also links to `looks.json` on GitHub. The Shelf is part of
the starter and you can delete it: the game does not need it.

## Sign in from Nanoterra

When your game is listed in Nanoterra, a player who is signed in at nano133.com can press Play and arrive here signed in. The
player agrees once, on a card, to send their username, their Nano address and their character to your game. Nothing is sent
otherwise, and a player can turn it off for your game at any time.

How it works (the standard OAuth shape, with a state):

1. Nanoterra's Play key sends the player to `/nanoterra/start`. Your Worker makes a random **state**, keeps it in a cookie of that
   browser (10 minutes) and sends the browser to nano133.com with your client id and the state.
2. Nanoterra checks that the player is signed in, an adult, and agreed to play your game. It makes a one-time code (60 seconds, used
   once) **for that state** and sends the browser back to `/nanoterra/callback?code=...&state=...`.
3. The callback accepts the link **only when the state in it is the state in this browser's cookie**. A link that someone else made has a
   state that is not in the victim's cookie, so it is refused before anything is traded. A state works once.
4. Your Worker trades the code for the player's details with a call from the server, using your client id, your client secret and the
   state. It then shows a screen: **Sign in as <name>? Continue / Not me**. Only a press of **Continue** makes your game's own session
   for that address. (The screen is a second defence: it also stops a player who presses Continue by mistake from landing in a
   stranger's account without seeing the name.)

The secret never goes to a page. (The one-time code is in the address of the callback request, so your Worker's request log may hold it.
It is already used by then: it works once.)

To switch it on:

1. In Nanoterra's launch page (nano133.com/build/nanoterra/launch, step 6, after your game is sent), press **Make my secret**. It
   shows the client id and the secret **once**. Save them now: Nanoterra keeps only a one-way code.
2. Put the client id in `NANOTERRA_CLIENT_ID` (`wrangler.jsonc`, or the dashboard). Add the secret with
   `npx wrangler secret put NANOTERRA_SECRET` (never in a file you commit).
3. Keep `"signin": "exchange"` in `game.config.json`. Deploy. Nanoterra's check then tries your callback with a bad code (it must be refused) and
   reads your start route (it must set a cookie and redirect to nano133.com's authorize address with your client id and a state).

What a player signed in from Nanoterra gets here: a session for the address Nanoterra named. It can show the player's name,
own looks and order looks like any signed-in player. It **never opens `/admin`**: only a wallet signature does.

**Two switches in `/admin` (the "Game" card).** Open `/admin` and look at **Game**. It has two switches: **Players use their Nanoterra
character** and **Players can sign in with Nanoterra**. A press saves at once: you push nothing and deploy nothing. They start from the words in
`game.config.json` (`"character"` and `"signin"`), and a press in `/admin` wins; the Worker reads the choice at run time and keeps it in your own database
(two rows of the `meta` table, `setting:character` and `setting:signin`). The card changes only these two settings, never a look, a price or an order.
Turning sign-in off changes the `signin` word of your listing file (`/nano-game.json`, kept for 60 seconds) and makes the game refuse sign-in from
Nanoterra (`/nanoterra/start`, the callback and Continue) at once, so a link made before signs nobody in. **For a game that is listed, Nanoterra's review
decides what Nanoterra shows:** the sign-in word is part of your listing file, and a change to a listed game's file waits for that review. The card cannot
see the review, so it says so and links to Nanoterra's launch page (step 6).

**The character.** One switch, in one file (and now in `/admin`, as above): `game.config.json` says `"character": "nanoterra"` (the default) or `"own"`. Nothing else reads it
(the listing file `nano-game.json` does not carry it). With `"nanoterra"` the player is the Nanoterra island character, drawn by the package
[`@nano133/nanoterra`](https://www.npmjs.com/package/@nano133/nanoterra) (path `/character`: the same code that nano133.com's island draws with). A player who
signed in from Nanoterra plays as the character they picked there: the base (a person, a round one, a bear, a bee, a robot or a pineapple), the face, the hair, the
clothes, the size and the colours, which come with the sign-in as the player's *record* (two whole numbers on closed lists, kept in your own database, and
checked again with the lists before the game draws them). A player whose Nanoterra sent no record plays in their five colours on the person body; anyone
else has the island's first look. A look from your shop (`looks.json`) that costs something paints the shirt with its body colour (the body, for a character
that wears no top, as Nanoterra's own shirt dyes do), and any look that has a hat puts it on the head of whatever body the player has. The free look leaves
the player's character alone. The body is display only: the collider, the jump and the reach are the same for every base and size. Set `"character": "own"`
for the little penguin of `character.ts` (or for a character of your own). The Nanoterra cosmetics that the player owns come with the sign-in
(`nanoterraItems` in `/api/me`) but are not drawn: the package draws the body only (a later version adds the item art).

**Be honest about whose account it is.** The state and the confirm screen close the old hole (a link that signs a victim in as the
sender). Still show the signed-in name on the first screen (this starter does, in the account button), and before any payment make clear
whose account it is. If you write your own game's server instead of using this starter, keep the state in a cookie and compare it at the
callback: that comparison is what protects your players.

Use the details only to sign the player in to your game (Nanoterra's Terms). Your own records of them are yours to protect; Nanoterra
cannot delete them for the player.

## What it costs

Cloudflare serves the game's files free, with no traffic limit. You pay only for many server calls.

| Your game | Plays a month | Cost a month |
|---|---|---|
| Small | 5,000 | $0 (Workers Free) |
| Medium | 250,000 | $0 on Free; $5 (Workers Paid) is safer on a busy day |
| Large | 5,000,000 | about $6.70 (Workers Paid) |

A domain of your own is optional (a `.com` is about $10 a year). Figures: Cloudflare's price pages,
read on 2026-10-21; they can change.

## How a sale works

1. A player signs in with Nano: Berry Wallet, NanChat or Nautilus signs a short message (no password, no
   payment).
2. The player picks a look. The game turns its US dollar price into XNO with public price feeds and
   asks for a **clean amount** with at most 4 decimals (for example `0.2778 XNO`). While another order
   waits with that amount, the next order asks 0.0001 XNO more, so every waiting order has its own
   amount.
3. The player pays from any Nano wallet (a QR code or a `nano:` link).
4. The game reads the Nano ledger (a node with your key first, public nodes as backup) and finds a
   payment of exactly that amount to your address, sent after the order. The look is given once.
5. A payment that comes after the order ended (15 minutes) is shown as **Paid late** in `/admin`.
   The look is not given. Send it back by hand from your wallet: the game has no key to do it.

## Run it on your computer

```sh
npm install
cp .dev.vars.example .dev.vars    # optional: your local settings and secrets
npm run dev                       # http://localhost:8787
npm run check                     # types, tests and build
```

The tests use a fake Nano node and keys made in the test: no network and no money.

## Files you will change

| File | What |
|---|---|
| `game.config.json` | The game's name, its one line, your name, the round's length, and the character switch (`"character": "nanoterra"` or `"own"`) |
| `looks.json` | The looks, their prices in US dollars and what they change |
| `src/client/game/` | The 3D game: the island (`world.ts`), the character, the gems, the rules (`game.ts`) |
| `public/art/` | The listing pictures (`wide.jpg` 1600×900, `tall.jpg` 900×1600) |

Do not change the payment check, the reservation, the admin guard or the sign-in. `AGENTS.md` says why.

MIT license. Copyright Pugs, LLC. Made by [nano133.com](https://nano133.com). Sign in with Nano is
[`@nano133/signin`](https://www.npmjs.com/package/@nano133/signin).
