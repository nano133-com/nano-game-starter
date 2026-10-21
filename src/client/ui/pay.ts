// The pay screen for one order. It shows the exact amount, a QR code and a "nano:" link for the wallet,
// and asks the game every 5 seconds whether the payment arrived, for 2 minutes per check.
//
// TEST MODE: the Worker sends no address and no link, and this screen shows a large "TEST MODE: DO NOT PAY"
// stamp where the QR code would be, with the wallet button off. Never change that: a payment to an address
// that nobody holds the key for is lost for good.

import { lookById, usdText } from "../../shared/looks";
import { ApiError, post, type Order } from "./api";
import { copy, h } from "./dom";
import { qrCanvas } from "./qr";

const POLL_MS = 5000;
const CHECK_FOR_MS = 2 * 60_000;

export function payView(order: Order, onPaid: (o: Order) => void): { node: HTMLElement; stop: () => void } {
  const look = lookById(order.lookId);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let checkingUntil = 0;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const again = h("button", { class: "btn btn-wide", type: "button", hidden: true }, "Check again");
  const left = h("span", { class: "time-left" });

  const amount = h("div", { class: "amount" }, h("strong", {}, `${order.xno} XNO`), h("span", {}, ` = ${usdText(Number(order.usd))}`));

  let payArea: HTMLElement;
  if (order.test || !order.uri || !order.address) {
    payArea = h(
      "div",
      { class: "test-pay" },
      h("div", { class: "qr-box qr-blocked", "aria-hidden": "true" }, h("div", { class: "qr-fake" })),
      h("div", { class: "stamp", role: "alert" }, h("span", {}, "TEST MODE:"), " ", h("span", {}, "DO NOT PAY")),
      h("button", { class: "btn btn-primary btn-wide", type: "button", disabled: true }, "Open wallet (off in test mode)"),
      h("p", { class: "fine" }, "This game is in test mode, so nothing can be paid here. To sell for real, the creator sets their own receive address and turns test mode off."),
    );
  } else {
    const qr = qrCanvas(order.uri, 232);
    qr.setAttribute("aria-label", `QR code to pay ${order.xno} XNO`);
    const copyAmount = h("button", { class: "btn btn-small", type: "button" }, "Copy");
    copyAmount.addEventListener("click", () => copy(order.xno, copyAmount));
    const copyAddress = h("button", { class: "btn btn-small", type: "button" }, "Copy");
    copyAddress.addEventListener("click", () => copy(order.address!, copyAddress));
    payArea = h(
      "div",
      { class: "live-pay" },
      h("div", { class: "qr-box" }, qr),
      h("a", { class: "btn btn-primary btn-wide", href: order.uri }, "Open wallet"),
      h(
        "details",
        { class: "by-hand" },
        h("summary", {}, "Enter it by hand"),
        h("div", { class: "row" }, h("span", { class: "label" }, "Amount"), h("code", {}, `${order.xno} XNO`), copyAmount),
        h("div", { class: "row" }, h("span", { class: "label" }, "To"), h("code", { class: "address" }, order.address), copyAddress),
        h("p", { class: "fine" }, "Send exactly this amount, with every digit. Another amount does not match this order."),
      ),
    );
  }

  const node = h(
    "div",
    { class: "pay" },
    h("p", { class: "pay-what" }, `${look?.name ?? order.lookId}: a look for your character. It changes how you look, not how you play.`),
    amount,
    payArea,
    h("p", { class: "fine" }, "This order ends in ", left, "."),
    status,
    again,
    h("p", { class: "fine prices" }, `Price in XNO from ${order.prices.join(", ")}. Powered by CoinGecko.`),
  );

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = undefined;
  };

  const tick = () => {
    const ms = Math.max(0, order.expiresAt - Date.now());
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    left.textContent = `${m}:${String(s).padStart(2, "0")}`;
  };
  tick();
  clockTimer = setInterval(tick, 1000);

  function show(o: Order) {
    order = o;
    if (o.status === "paid") {
      stop();
      payArea.replaceChildren(h("div", { class: "paid" }, h("strong", {}, "Paid. Thank you!"), h("p", {}, `${look?.name ?? "The look"} is yours now.`)));
      status.textContent = "";
      again.hidden = true;
      onPaid(o);
      return true;
    }
    if (o.status === "paid_late") {
      stop();
      status.textContent = "This payment came after the order ended. The look was not given. The creator sees it and can send it back.";
      again.hidden = true;
      return true;
    }
    if (o.status === "expired") {
      stop();
      status.textContent = "This order ended. If you already paid, wait here: a payment sent in time still counts.";
      again.hidden = false;
      return false;
    }
    return false;
  }

  async function poll() {
    if (stopped) return;
    try {
      const o = await post<Order>(`/api/orders/${order.id}/check`);
      if (show(o)) return;
      if (o.status === "open") status.textContent = order.test ? "Test mode: the game does not wait for a payment." : "Waiting for your payment…";
    } catch (e) {
      status.textContent = e instanceof ApiError ? e.message : "No connection. Trying again…";
    }
    if (Date.now() < checkingUntil) timer = setTimeout(poll, POLL_MS);
    else if (!stopped) {
      status.textContent = "Still waiting. Already paid? Press Check again.";
      again.hidden = false;
    }
  }

  function startChecking() {
    stopped = false;
    again.hidden = true;
    checkingUntil = Date.now() + CHECK_FOR_MS;
    clockTimer ??= setInterval(tick, 1000);
    poll();
  }
  again.addEventListener("click", startChecking);
  if (!order.test) startChecking();
  else status.textContent = "Test mode: the game does not wait for a payment.";

  return { node, stop };
}
