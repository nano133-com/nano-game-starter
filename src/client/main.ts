// The game page: the 3D game, the HUD, and the sheets for looks, sign-in and paying.

import "./style.css";
import { CONFIG } from "../shared/config";
import { FREE_LOOK, lookById, type Look } from "../shared/looks";
import { Game } from "./game/game";
import { ApiError, get, post, type Config, type Me, type Order } from "./ui/api";
import { h, shortAddress } from "./ui/dom";
import { looksView } from "./ui/looks";
import { payView } from "./ui/pay";
import { Sheet } from "./ui/sheet";
import { signInView } from "./ui/signin";
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
    },
  },
);
timeEl.textContent = `${Math.floor(CONFIG.round.seconds / 60)}:${String(CONFIG.round.seconds % 60).padStart(2, "0")}`;
$("best").textContent = game.best ? `Best: ${game.best}` : "";

sheet.onOpenChange = (open) => {
  game.paused = open;
  game.controls.enabled = !open;
  if (open) game.controls.release();
};

// ---- looks ----

const owns = (look: Look) => look.priceUsd === 0 || me.owned.includes(look.id);

function wornLook(): Look {
  let id: string | null = null;
  try {
    id = localStorage.getItem(WORN_KEY);
  } catch {
    // Storage may be off (a private window).
  }
  const look = lookById(id);
  return look && owns(look) ? look : FREE_LOOK;
}

function wear(look: Look) {
  game.wear(look);
  try {
    localStorage.setItem(WORN_KEY, look.id);
  } catch {
    // The look then lasts for this visit only.
  }
}

function showLooks(refresh = true) {
  if (refresh && me.address) {
    // A payment may have been found while the sheet was closed (the scan runs every 10 minutes too).
    get<Me>("/api/me")
      .then((fresh) => {
        const changed = fresh.owned.join() !== me.owned.join() || fresh.address !== me.address;
        me = fresh;
        if (changed && sheet.open && document.querySelector("dialog[open] .looks")) showLooks(false);
      })
      .catch(() => null);
  }
  sheet.show(
    "Looks",
    looksView({
      owned: new Set(me.owned),
      worn: wornLook().id,
      signedIn: Boolean(me.address),
      wear: (l) => {
        wear(l);
        showLooks(false);
      },
      buy,
    }),
  );
}

async function buy(look: Look) {
  if (!me.address) return showSignIn(() => buy(look));
  const box = h("div", {}, h("p", { class: "status" }, "Making your order…"), h("div", { class: "turnstile", hidden: true }));
  sheet.show(`Buy ${look.name}`, box);
  try {
    const turnstile = await personCheck(config.turnstileSiteKey, box.lastElementChild as HTMLElement);
    const order = await post<Order>("/api/orders", { lookId: look.id, turnstile });
    showPay(order, look);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "The order did not start. Try again.";
    box.replaceChildren(h("p", { class: "status" }, message), h("button", { class: "btn btn-wide", type: "button", onclick: () => showLooks() }, "Back to looks"));
    if (e instanceof ApiError && e.status === 401) {
      me = { address: null, owned: [], admin: false };
      renderAccount();
    }
  }
}

function showPay(order: Order, look: Look) {
  const view = payView(order, async () => {
    me = await get<Me>("/api/me").catch(() => me);
    wear(look);
    renderAccount();
  });
  sheet.show(`Buy ${look.name}`, view.node, view.stop);
}

// ---- account ----

function renderAccount() {
  // A player who came from Nanoterra sees the name Nanoterra sent: whose account this is shows on the first screen.
  const name = me.address ? me.username ?? shortAddress(me.address) : "Sign in";
  accountBtn.textContent = name;
  accountBtn.setAttribute("aria-label", me.address ? `Signed in as ${me.username ? `${me.username}, ${me.address}` : me.address}` : "Sign in with Nano");
}

/** The character in the look the player has in Nanoterra (a sign-in from there), and in the shop's look that they wear. */
function dress() {
  game.setNanoterra(me.via === "nanoterra" ? me.look ?? null : null);
  game.wear(wornLook());
}

function showSignIn(then?: () => void) {
  const view = signInView(config, (signed) => {
    me = signed;
    renderAccount();
    dress();
    setTimeout(() => (then ? then() : sheet.close()), then ? 600 : 1200);
  });
  sheet.show("Sign in with Nano", view.node, view.stop);
}

function showAccount() {
  if (!me.address) return showSignIn();
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

$("play").addEventListener("click", () => {
  start.hidden = true;
  game.start();
});
$("again").addEventListener("click", () => {
  end.hidden = true;
  game.start();
});
$("end-looks").addEventListener("click", () => showLooks());
$("looks-btn").addEventListener("click", (e) => {
  (e.currentTarget as HTMLElement).blur();
  showLooks();
});
accountBtn.addEventListener("click", () => {
  accountBtn.blur();
  showAccount();
});

// ---- start ----

(async () => {
  try {
    [config, me] = await Promise.all([get<Config>("/api/config"), get<Me>("/api/me")]);
  } catch {
    // The game still plays without the server; buying waits until it answers.
  }
  $("test-flag").hidden = !config.testMode;
  renderAccount();
  dress();
})();
