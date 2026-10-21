// Sign in with Nano in the browser: Berry Wallet (or any wallet that reads "nano-signin-v1").
// On a phone: one button opens the wallet. On a computer: a QR code to scan with the wallet.
// The page asks the game every 2 seconds until the wallet has signed (5 minutes at most).

import { ApiError, get, post, type Config, type Me } from "./api";
import { h, isTouch, shortAddress } from "./dom";
import { personCheck } from "./turnstile";
import { qrCanvas } from "./qr";

type Start = { id: string; link: string; walletLink: string; expiresAt: number };

/**
 * Fills `box` with the sign-in. Resolves with the signed-in account; `stop()` ends the waiting (when the
 * sheet closes).
 */
export function signInView(config: Config, onDone: (me: Me) => void): { node: HTMLElement; stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = h("p", { class: "status", role: "status" });
  const check = h("div", { class: "turnstile", hidden: true });
  const area = h("div", { class: "signin-area" });
  const begin = h("button", { class: "btn btn-primary btn-wide", type: "button" }, "Sign in with Nano");
  const node = h(
    "div",
    { class: "signin" },
    h("p", {}, "No password and no payment. Your wallet signs a short message that names this game."),
    check,
    area,
    begin,
    status,
  );

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  begin.addEventListener("click", async () => {
    begin.disabled = true;
    status.textContent = "Starting…";
    try {
      const turnstile = await personCheck(config.turnstileSiteKey, check);
      const s = await post<Start>("/api/signin/start", { turnstile });
      begin.hidden = true;
      showRequest(s);
      status.textContent = "Waiting for your wallet…";
      poll(s);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Sign-in did not start. Try again.";
      begin.disabled = false;
    }
  });

  function showRequest(s: Start) {
    const open = h("a", { class: "btn btn-primary btn-wide", href: s.link }, "Open Berry Wallet");
    const other = h("a", { class: "btn btn-wide", href: s.walletLink }, "Another wallet");
    if (isTouch()) {
      area.replaceChildren(open, other, h("p", { class: "fine" }, "Approve the sign-in in your wallet, then come back to this page."));
    } else {
      const qr = qrCanvas(s.link, 220);
      qr.setAttribute("aria-label", "QR code to sign in with Berry Wallet");
      area.replaceChildren(
        h("div", { class: "qr-box" }, qr),
        h("p", {}, "Scan this with Berry Wallet on your phone, then approve the sign-in."),
        h("p", { class: "fine" }, "Only approve a sign-in that you started yourself."),
        h("p", { class: "fine" }, "On this computer: ", h("a", { href: s.walletLink }, "open a wallet"), "."),
      );
    }
  }

  async function poll(s: Start) {
    if (stopped) return;
    if (Date.now() > s.expiresAt + 5000) {
      status.textContent = "This sign-in expired.";
      area.replaceChildren();
      begin.hidden = false;
      begin.disabled = false;
      begin.textContent = "Try again";
      return;
    }
    try {
      const r = await post<{ status: string; address?: string }>("/api/signin/check", { id: s.id });
      if (r.status === "signedin" && r.address) {
        const me = await get<Me>("/api/me");
        area.replaceChildren();
        status.textContent = `Signed in as ${shortAddress(r.address)}`;
        onDone(me);
        return;
      }
      if (r.status === "elsewhere" || r.status === "used") {
        status.textContent = "This sign-in was used in another browser. Start again.";
        begin.hidden = false;
        begin.disabled = false;
        return;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) status.textContent = "Too many checks. Waiting a moment…";
    }
    timer = setTimeout(() => poll(s), 2000);
  }

  return { node, stop };
}
