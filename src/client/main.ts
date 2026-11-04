// The game page: the 3D game, the HUD, and the sheets for looks, sign-in and paying. The looks and pay sheets are the package's shop
// (@nano133/nanoterra/shop/panel) and the sign-in sheet is the package's player sign-in (@nano133/nanoterra/player-signin/panel): this page gives
// them the game's own parts (what the player owns and wears, the Turnstile check, the frozen passkey scheme) and keeps the account sheet.

import "./style.css";
import { CONFIG } from "../shared/config";
import { FREE_LOOK, isOutfit, LOOKS, outfitById, type Outfit } from "../shared/looks";
import plays from "../../plays.json";
import { SCHEME } from "../shared/scheme";
import { pauseWhenLeft } from "@nano133/nanoterra/input";
import { mountFriends, type MountedFriends } from "@nano133/nanoterra/friends/panel";
import "@nano133/nanoterra/friends/style.css";
import { mountOptions, optionSection } from "@nano133/nanoterra/options";
import "@nano133/nanoterra/options/style.css";
import { EMOTE_KEY_OPTION, EMOTE_OPTION_DEFS } from "@nano133/nanoterra/emotes";
import { loadEmotes } from "@nano133/nanoterra/emotes/player";
import { mountEmotes } from "@nano133/nanoterra/emotes/wheel";
import "@nano133/nanoterra/emotes/style.css";
import { mountShop, qrSvg } from "@nano133/nanoterra/shop/panel";
import "@nano133/nanoterra/shop/style.css";
import { mountPlayerSignin } from "@nano133/nanoterra/player-signin/panel";
import "@nano133/nanoterra/player-signin/style.css";
import { Game } from "./game/game";
import { GAME_KEY, options } from "./options";
import { get, post, type Config, type Me } from "./ui/api";
import { h, shortAddress } from "./ui/dom";
import { nanoterraPlayerOf } from "./ui/player";
import { Sheet } from "./ui/sheet";
import { personCheck } from "./ui/turnstile";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const WORN_KEY = "gem-island.look";

let config: Config = { name: CONFIG.name, creator: CONFIG.creator.name, testMode: true, turnstileSiteKey: null };
let me: Me = { address: null, owned: [], admin: false };

const sheet = new Sheet($("app"));
const scoreEl = $("score");
const timeEl = $("time");
const start = $("start");
const end = $("end");
const accountBtn = $<HTMLButtonElement>("account-btn");

const game = new Game(
  $("view"),
  { stick: $("stick"), knob: $("stick-knob"), jump: $("jump-btn") },
  {
    score: (s) => (scoreEl.textContent = String(s)),
    time: (s) => (timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`),
    over: (score, best, isBest) => {
      $("end-score").textContent = String(score);
      $("end-best").textContent = isBest ? "A new best!" : `Best: ${best}`;
      end.hidden = false;
      $("again").focus();
      showWhere();
    },
  },
);
timeEl.textContent = `${Math.floor(CONFIG.round.seconds / 60)}:${String(CONFIG.round.seconds % 60).padStart(2, "0")}`;
$("best").textContent = game.best ? `Best: ${game.best}` : "";

const pausedCard = $("paused");

// ---- the friends list ----
// The admin's friends setting (GET /api/config): Nanoterra's friends in nano133's window, the game's own players (/api/friends), or none.
// The key is mounted once, at the start, and stays: in the "nanoterra" mode its window holds the player's live connection (never hide it with
// display: none, never remove it). `where` is plain text that the player's friends see.
let friends: MountedFriends | null = null;
let friendsOpen = false;
let optionsOpen = false;
let wheelOpen = false;
let shopOpen = false;
let signinOpen = false;
let atLooks = false;

function whereNow(): string {
  if (atLooks) return "Looking at looks";
  if (game.playing) return "Playing a round";
  return end.hidden ? "On the start screen" : "Between rounds";
}

function showWhere() {
  friends?.setWhere(whereNow());
}

/** Something over the game: the account sheet, the shop, the sign-in sheet, the friends panel, the options panel or the emote wheel. */
const covered = () => sheet.open || shopOpen || signinOpen || friendsOpen || optionsOpen || wheelOpen;

/** Anything over the game stops a free round, as the paused card does. */
function holdGame() {
  const held = covered();
  game.paused = held || !pausedCard.hidden;
  game.controls.enabled = !held && pausedCard.hidden;
  if (held) game.controls.release();
}

function startFriends() {
  const mode = config.friends ?? "off";
  // Nanoterra's window needs the game's id there (game.config.json "nanoterraId"): with none, there is no key (/admin says so).
  if (mode === "off" || (mode === "nanoterra" && !config.nanoterraId)) return;
  const root = $("friends");
  friends = mountFriends(root, { mode, game: config.nanoterraId ?? "", base: "/api/friends", where: whereNow() });
  const panel = root.querySelector<HTMLElement>(".n133f-panel");
  if (panel)
    new MutationObserver(() => {
      friendsOpen = panel.dataset.open === "true";
      holdGame();
    }).observe(panel, { attributes: true, attributeFilter: ["data-open"] });
}

// ---- options ----
// The gear key in the HUD and the kit's panel (Basic and Advanced). The settings themselves are in options.ts; the game reads them where it uses them.
mountOptions($("options"), options, {
  onOpen: () => {
    optionsOpen = true;
    holdGame();
  },
  onClose: () => {
    optionsOpen = false;
    holdGame();
  },
});

// A closed panel gives the focus back to its key (for a keyboard player). A press on the game takes it away again, so a key the game does not
// use (Space, after Jump moved to another key) does not press the HUD key that still has the focus.
$("view").addEventListener("pointerdown", () => {
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
});

// ---- emotes ----
// Nanoterra's eleven emotes on the wheel, for the Nanoterra character only (the penguin has none). The admin's "Allow Nanoterra emotes" (GET
// /api/config `emotes`) can take them off; then there is no key. The clips load when the wheel first opens (`loadEmotes`), never with the game.
// This game is single-player: a multiplayer game sends each emote to the others from the character's `onEmote` (nanoterraCharacter.ts) and plays
// theirs with `playRemote` from "@nano133/nanoterra/emotes/player" (the kit's README, "Emotes").
function startEmotes() {
  if ((config.character ?? CONFIG.character) !== "nanoterra" || config.emotes === "off") return;
  // The wheel's settings join the panel only when the wheel is there: "Show the Emotes key" and its key on a keyboard (B). "Show other players'
  // emotes" is left out: one player sees no other. A multiplayer game adds all three: `options.add(EMOTE_OPTIONS)`.
  options.add([...optionSection("emotes", EMOTE_OPTION_DEFS.filter((d) => d.key === "show"), "Emotes"), EMOTE_KEY_OPTION]);
  const root = $("emotes");
  mountEmotes(root, {
    game: GAME_KEY,
    onPlay: (id) => void game.emote(id),
    onOpen: () => void loadEmotes(),
    nanoterraEmotes: config.emotes ?? "on",
    options,
    // B opens the wheel only while nothing else is over the game.
    keyAllowed: () => !(sheet.open || shopOpen || signinOpen || friendsOpen || optionsOpen) && pausedCard.hidden,
  });
  const layer = root.querySelector<HTMLElement>(".n133e-layer");
  if (layer)
    new MutationObserver(() => {
      wheelOpen = layer.dataset.open === "true";
      holdGame();
    }).observe(layer, { attributes: true, attributeFilter: ["data-open"] });
}

sheet.onOpenChange = () => {
  // The paused card keeps the round stopped when a sheet closes under it.
  holdGame();
  showWhere();
};

// ---- leaving the page ----
// Another tab, another window or another app (a phone) takes the page away: the round stops, the character stands
// still, and the round stays stopped until the player taps Resume. The controls let go by themselves (controls.ts).
// This is for a FREE round. If you make a round cost money, keep the controls' release but do not stop its clock:
// a paid round's deadline must not move (the nano133 arcade follows the same rule).
function pauseForLeave() {
  // A paid round never pauses: its deadline must not move. The controls still let go.
  if (paidRound && game.playing) return void game.controls.release();
  if (!game.playing || !pausedCard.hidden || covered()) return;
  game.paused = true;
  game.controls.enabled = false;
  game.controls.release();
  pausedCard.hidden = false;
  $("resume").focus();
}

function resume() {
  pausedCard.hidden = true;
  holdGame();
}

$("resume").addEventListener("click", resume);
// The tab is hidden, or the window loses the focus to another window (a real blur: not a script's, and not a focus that moves
// inside the page). `pauseForLeave` is safe to call twice for one leave.
pauseWhenLeft(pauseForLeave);

// ---- looks ----

const owns = (look: Outfit) => look.priceUsd === 0 || me.owned.includes(look.id);

function wornLook(): Outfit {
  let id: string | null = null;
  try {
    id = localStorage.getItem(WORN_KEY);
  } catch {
    // Storage may be off (a private window).
  }
  const look = outfitById(id);
  return look && owns(look) ? look : FREE_LOOK;
}

function wear(look: Outfit) {
  game.wear(look);
  try {
    localStorage.setItem(WORN_KEY, look.id);
  } catch {
    // The look then lasts for this visit only.
  }
}

/** Reads the player again (`/api/me`): a payment may have been found while the shop was closed (the scan runs every 10 minutes too). */
async function refreshMe() {
  if (!me.address) return;
  const fresh = await get<Me>("/api/me").catch(() => null);
  if (!fresh) return;
  const changed = fresh.owned.join() !== me.owned.join() || fresh.address !== me.address;
  me = fresh;
  if (changed) {
    renderAccount();
    shop.refresh();
  }
}

// The Looks sheet and the pay sheet: the package's shop. The server decides every price; the sheet shows each look's price before any step,
// and in test mode its pay sheet says "TEST MODE: DO NOT PAY" with no QR code and the wallet key off (the order's answer carries no address).
// The game's own keys open it (`key: false`): Looks in the top bar and on the end card.
const shop = mountShop($("app"), {
  looks: LOOKS,
  plays,
  // A paid play order gave one credit: the Play keys read the credits again.
  onCredit: () => void shop.ready().catch(() => null),
  key: false,
  owned: () => me.owned,
  signedIn: () => Boolean(me.address),
  // Buy when nobody is signed in: the sign-in sheet first. The shop's sheet is a modal dialog, so it closes while the sign-in sheet is open;
  // the shop opens again by itself on the pay sheet (or on the looks, when the player closed the sign-in).
  signIn: async () => {
    shop.close();
    return signIn();
  },
  worn: (look) => wornLook().id === look.id,
  wear: (look) => {
    if (isOutfit(look)) wear(look);
  },
  // A paid order gave this look: it is the player's now, and they wear it.
  onOwned: (lookId, look) => {
    if (!me.owned.includes(lookId)) me = { ...me, owned: [...me.owned, lookId] };
    if (isOutfit(look)) wear(look);
    void refreshMe();
  },
  personCheck: (box) => personCheck(config.turnstileSiteKey, box),
  // The server refused an order with 401: the session ended. The player is signed out here too; the sheet's "Sign in" key signs in again.
  onSessionEnd: () => {
    me = { address: null, owned: [], admin: false };
    renderAccount();
    dress();
  },
  onOpen: () => {
    shopOpen = atLooks = true;
    holdGame();
    showWhere();
    void refreshMe();
  },
  onClose: () => {
    shopOpen = atLooks = false;
    holdGame();
    showWhere();
  },
});

// ---- account ----

function renderAccount() {
  // A player who came from Nanoterra sees the name Nanoterra sent: whose account this is shows on the first screen.
  const name = me.address ? me.username ?? shortAddress(me.address) : "Sign in";
  accountBtn.textContent = name;
  accountBtn.setAttribute("aria-label", me.address ? `Signed in as ${me.username ? `${me.username}, ${me.address}` : me.address}` : "Sign in with Nano");
}

/** The character in the look the player has in Nanoterra (a sign-in from there, while sign-in from Nanoterra is On), and in the shop's look that they wear. */
function dress() {
  game.setNanoterra(nanoterraPlayerOf(me, config));
  game.wear(wornLook());
}

// The player's sign-in: the package's sheet (a passkey, or Berry Wallet, NanChat or Nautilus). On a preview address (*.workers.dev) it offers no
// passkey: a passkey belongs to one domain for good, and the game moves to its own. The passkey's account comes from the FROZEN scheme
// (src/shared/scheme.ts). The sheet opens from the account key and from the shop's Buy.
const signinSheet = mountPlayerSignin($("app"), {
  name: CONFIG.name,
  scheme: SCHEME,
  qr: (text) => h("div", { class: "signin-qr" }, qrSvg(text, "QR code to sign in with your wallet")),
  personCheck: (box) => personCheck(config.turnstileSiteKey, box),
});
const signinRoot = $("app").querySelector<HTMLElement>(".n133-signin.n133s-sheet");
if (signinRoot)
  new MutationObserver(() => {
    signinOpen = signinRoot.dataset.open === "true";
    holdGame();
  }).observe(signinRoot, { attributes: true, attributeFilter: ["data-open"] });

/** Opens the sign-in sheet. True when a player is signed in after it (the page has read them again). */
async function signIn(): Promise<boolean> {
  const player = await signinSheet.open();
  if (!player) return false;
  me = await get<Me>("/api/me").catch(() => ({ address: player.address, owned: [], admin: false, via: player.via }));
  renderAccount();
  dress();
  void shop.ready().catch(() => null);
  return Boolean(me.address);
}

function showAccount() {
  if (!me.address) return void signIn();
  const out = h("button", { class: "btn btn-wide", type: "button" }, "Sign out");
  out.addEventListener("click", async () => {
    await post("/api/signout").catch(() => null);
    me = { address: null, owned: [], admin: false };
    renderAccount();
    dress();
    sheet.close();
  });
  sheet.show(
    "Your account",
    h(
      "div",
      {},
      h("p", {}, me.username ? `Signed in as ${me.username}${me.via === "nanoterra" ? " (from Nanoterra)" : ""}` : "Signed in as"),
      h("p", { class: "address" }, me.address),
      me.admin ? h("p", {}, h("a", { class: "btn btn-wide", href: "/admin" }, "Open the admin page")) : null,
      out,
    ),
  );
}

// ---- buttons ----

// ---- a paid round (plays.json) ----
// The round's start uses ONE credit: a new round id for each round, and the round starts only after the server says "used".
let paidRound = false;
const PLAY_ID = "extra-round";
async function startPaidRound(playId: string) {
  const ref = crypto.randomUUID();
  const r = await post<{ used: boolean; again: boolean }>("/api/plays/use", { playId, ref }).catch(() => null);
  await shop.ready().catch(() => null);
  if (!r?.used) return;
  start.hidden = true;
  end.hidden = true;
  paidRound = true;
  game.start();
  showWhere();
}
for (const after of ["play", "again"]) {
  const key = shop.playKey(PLAY_ID, (id) => void startPaidRound(id));
  if (key) $(after).after(key);
}

$("play").addEventListener("click", () => {
  paidRound = false;
  start.hidden = true;
  game.start();
  showWhere();
});
$("again").addEventListener("click", () => {
  paidRound = false;
  end.hidden = true;
  game.start();
  showWhere();
});
$("end-looks").addEventListener("click", () => shop.open());
$("looks-btn").addEventListener("click", (e) => {
  (e.currentTarget as HTMLElement).blur();
  shop.open();
});
accountBtn.addEventListener("click", () => {
  accountBtn.blur();
  showAccount();
});

// ---- ready ----
// The start card painted before this script came (index.html), with Play as "Loading…". The game can start now: Play says so, and
// `data-boot` hides the loading notes (style.css) and tells public/boot.js that this script ran. Nothing below waits for the
// network: /api/config may answer later.
const play = $<HTMLButtonElement>("play");
play.disabled = false;
play.removeAttribute("aria-busy");
play.textContent = "Play";
document.documentElement.dataset.boot = "ready";

// ---- start ----

(async () => {
  try {
    [config, me] = await Promise.all([get<Config>("/api/config"), get<Me>("/api/me")]);
  } catch {
    // The game still plays without the server; buying waits until it answers.
  }
  $("test-flag").hidden = !config.testMode;
  // The "Game" switches of /admin: which character the players are (the bundled word is the default until the server says).
  if (config.character) game.setCharacter(config.character);
  renderAccount();
  dress();
  if (me.address) void shop.ready().catch(() => null);
  startFriends();
  startEmotes();
})();
