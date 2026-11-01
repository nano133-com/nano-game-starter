// The ADMIN's sign-in in the browser (/admin), with Berry Wallet or Nautilus. (The game's own sign-in, for players, is the package's sheet:
// @nano133/nanoterra/player-signin/panel, in main.ts.) First the wallets as tiles; then, for the chosen one, one button that opens it (a phone)
// or a QR code to scan with it (a computer). The page asks the game every 2 seconds until the wallet has signed (5 minutes at most).
// The tiles show letters, not logos: no wallet's license clearly allows its logo. NanChat is not offered: it cannot name the admin in what it signs.

import { qrSvg } from "@nano133/nanoterra/shop/panel";
import { ApiError, post, type Config } from "./api";
import { h, isTouch, shortAddress } from "./dom";
import { personCheck } from "./turnstile";

type Way = "berry" | "nautilus";
type Start = { way: Way; id: string; link: string; walletLink?: string; code?: string; expiresAt: number };

/** The wallets, in the sheet's order: Berry Wallet first. */
const WALLETS: { way: Way; name: string; mark: string }[] = [
  { way: "berry", name: "Berry Wallet", mark: "B" },
  { way: "nautilus", name: "Nautilus", mark: "N" },
];
const nameOf = (way: Way) => WALLETS.find((w) => w.way === way)!.name;

/**
 * The admin's sign-in, ready to put in the admin panel. `onDone` runs once the owner has signed in; `stop()` ends the waiting. It makes the
 * ADMIN login (`scope: "admin"`: a cookie of its own), so the game and /admin can have different people signed in at once.
 */
export function signInView(config: Config, onDone: () => void): { node: HTMLElement; stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The request that is waiting. Back keeps it: the person may have approved it already. */
  let current: Start | null = null;
  const status = h("p", { class: "status", role: "status" });
  const check = h("div", { class: "turnstile", hidden: true });
  const area = h("div", { class: "signin-area" });
  const intro = "No password and no payment. This signs in to the ADMIN of this game: your wallet signs a short message that says so. If you did not start this yourself, do not sign.";
  const node = h("div", { class: "signin" }, h("p", {}, intro), check, area, status);

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  function showTiles() {
    const tiles = WALLETS.map((w) =>
      h("button", { class: "wallet-tile", type: "button", onclick: () => choose(w.way) }, h("span", { class: "wallet-mark", "aria-hidden": "true" }, w.mark), h("span", { class: "wallet-name" }, w.name)),
    );
    area.replaceChildren(h("p", { class: "signin-ask" }, "Choose your wallet"), h("div", { class: "wallet-tiles" }, ...tiles));
  }

  async function choose(way: Way) {
    if (current?.way === way && Date.now() < current.expiresAt) return showWallet(current);
    if (timer) clearTimeout(timer);
    current = null;
    for (const b of area.querySelectorAll("button")) b.disabled = true;
    status.textContent = "Starting…";
    try {
      const turnstile = await personCheck(config.turnstileSiteKey, check);
      const s = await post<Start>("/api/signin/start", { way, turnstile, scope: "admin" });
      current = s;
      showWallet(s);
      poll(s);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Sign-in did not start. Try again.";
      showTiles();
    }
  }

  function showWallet(s: Start) {
    const name = nameOf(s.way);
    const back = h("button", { class: "btn btn-ghost btn-small signin-back", type: "button", onclick: () => showTiles() }, "‹ Back");
    area.replaceChildren(back, h("h3", { class: "signin-wallet" }, name), ...walletSteps(s, name));
    status.textContent = `Waiting for ${name}…`;
  }

  /** What the person does with the wallet: on a phone, one button; on a computer, a QR code for the phone. */
  function walletSteps(s: Start, name: string): Node[] {
    const open = (text: string, href: string) => h("a", { class: "btn btn-primary btn-wide", href }, text);
    const qr = (text: string) => {
      const code = qrSvg(text, `QR code to sign in with ${name}`);
      code.classList.add("qr");
      return h("div", { class: "qr-box" }, code);
    };
    const only = h("p", { class: "fine" }, `Only approve a sign-in that you started yourself, on ${location.host}.`);
    const back = h("p", { class: "fine" }, `Approve the sign-in in ${s.way === "berry" ? "your wallet" : name}, then come back to this page.`);
    const touch = isTouch();
    if (s.way === "nautilus") {
      const code = h("p", {}, "Check that Nautilus shows the code ", h("strong", { class: "signin-code" }, s.code ?? ""), ".");
      return touch ? [code, open("Open Nautilus", s.link), back] : [qr(s.link), h("p", {}, "Scan this with Nautilus on your phone, then approve the sign-in."), code, only];
    }
    const other = h("a", { class: "btn btn-wide", href: s.walletLink ?? s.link }, "Another wallet");
    const here = h("p", { class: "fine" }, "On this computer: ", h("a", { href: s.walletLink ?? s.link }, "open a wallet"), ".");
    return touch ? [open("Open Berry Wallet", s.link), other, back] : [qr(s.link), h("p", {}, "Scan this with Berry Wallet on your phone, then approve the sign-in."), only, here];
  }

  /** The request ended without a sign-in: say why, and offer a new one. */
  function again(s: Start, words: string) {
    current = null;
    status.textContent = words;
    const retry = h("button", { class: "btn btn-primary btn-wide", type: "button", onclick: () => choose(s.way) }, "Try again");
    const other = h("button", { class: "btn btn-wide", type: "button", onclick: () => showTiles() }, "Choose another wallet");
    area.replaceChildren(retry, other);
  }

  async function poll(s: Start) {
    if (stopped || current !== s) return;
    if (Date.now() > s.expiresAt + 5000) return again(s, "This sign-in expired.");
    try {
      const r = await post<{ status: string; address?: string }>("/api/signin/check", { id: s.id, way: s.way, scope: "admin" });
      if (stopped || current !== s) return;
      if (r.status === "signedin" && r.address) {
        current = null;
        area.replaceChildren();
        status.textContent = `Signed in as ${shortAddress(r.address)}`;
        onDone();
        return;
      }
      if (r.status === "elsewhere" || r.status === "used") return again(s, "This sign-in was used in another browser. Start again.");
      if (r.status === "not_owner") return again(s, "That wallet is not this game's address. Choose the wallet that holds it.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) status.textContent = "Too many checks. Waiting a moment…";
    }
    timer = setTimeout(() => poll(s), 2000);
  }

  showTiles();
  return { node, stop };
}
