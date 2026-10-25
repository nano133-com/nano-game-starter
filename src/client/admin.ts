// The creator's admin page: orders, owned looks and totals, from the game's own database. Only the game's
// receive address can read them (the Worker checks it on every call); this page only shows them.

import "./style.css";
import "./admin.css";
import { ApiError, get, post, type Config } from "./ui/api";
import { h, shortAddress } from "./ui/dom";
import { shelfView } from "./shelf";
import { signInView } from "./ui/signin";

type Summary = {
  address: string;
  testMode: boolean;
  turnstile: boolean;
  nodes: string[];
  rate: { usd: number; sources: string[]; at: number } | null;
  repo: string | null;
  warnings: string[];
  counts: { open: number; paid: number; expired: number; paid_late: number };
  totals: { paid: { count: number; xno: string; usd: string }; paidLate: { count: number; xno: string; usd: string } };
  orders: { id: string; player: string; lookId: string; look: string; usd: string; xno: string; status: string; createdAt: number; expiresAt: number; paidAt: number | null; payer: string | null; hash: string | null }[];
  players: { player: string; looks: { id: string; name: string; at: number }[] }[];
};

const gate = document.getElementById("gate")!;
const data = document.getElementById("data")!;
const STATUS_WORDS: Record<string, string> = { open: "Open", paid: "Paid", expired: "Expired", paid_late: "Paid late" };
let filter = "all";
/** The Shelf keeps its draft while the page redraws (a tab, a payment check): one view for the life of the page. */
let shelf: ReturnType<typeof shelfView> | null = null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "");

async function load() {
  try {
    const s = await get<Summary>("/api/admin/summary");
    gate.hidden = true;
    render(s);
  } catch (e) {
    if (!(e instanceof ApiError)) {
      gate.replaceChildren(h("p", {}, "The game's server did not answer. Try again."));
      return;
    }
    data.hidden = true;
    gate.hidden = false;
    if (e.status === 403 && e.body.signedInAs) {
      gate.replaceChildren(
        h("h2", {}, "Not the game's address"),
        h("p", {}, `You are signed in as ${shortAddress(String(e.body.signedInAs))}. Only the game's receive address can open this page.`),
        signOutButton(),
      );
      return;
    }
    if (e.status === 403 && e.body.reason === "nanoterra") {
      gate.replaceChildren(
        h("h2", {}, "You signed in from Nanoterra"),
        h("p", {}, "A Nanoterra sign-in names your address but proves no key, so it cannot open this page. Sign out, then sign in with the wallet that holds your game's address."),
        signOutButton(),
      );
      return;
    }
    if (e.status === 403 && e.body.reason !== "no_address") {
      gate.replaceChildren(h("h2", {}, "This page is closed to you"), h("p", {}, e.message), signOutButton());
      return;
    }
    if (e.status === 403) {
      gate.replaceChildren(h("h2", {}, "No receive address yet"), h("p", {}, e.message), h("p", { class: "fine" }, "Set RECEIVE_ADDRESS in your Cloudflare dashboard (Workers & Pages, your game, Settings, Variables), then deploy again."));
      return;
    }
    const config = await get<Config>("/api/config").catch((): Config => ({ name: "", creator: "", testMode: true, turnstileSiteKey: null }));
    const view = signInView(config, () => load());
    gate.replaceChildren(h("h2", {}, "Sign in with your game's address"), h("p", {}, e.message), view.node);
  }
}

function signOutButton() {
  return h(
    "button",
    {
      class: "btn",
      type: "button",
      onclick: async () => {
        await post("/api/signout").catch(() => null);
        load();
      },
    },
    "Sign out",
  );
}

function shelfCard(s: Summary): HTMLElement {
  const d = { orders: s.orders, players: s.players, repo: s.repo };
  if (shelf) shelf.update(d);
  else shelf = shelfView(d);
  return shelf.el;
}

function render(s: Summary) {
  data.hidden = false;
  const check = h("button", { class: "btn btn-primary", type: "button" }, "Check payments now");
  const checkNote = h("span", { class: "fine", role: "status" });
  check.addEventListener("click", async () => {
    check.disabled = true;
    checkNote.textContent = "Checking…";
    try {
      const r = await post<{ scan: { scanned: boolean; settled: unknown[]; error?: string }; summary: Summary }>("/api/admin/check");
      render(r.summary);
    } catch (e) {
      checkNote.textContent = e instanceof Error ? e.message : "The check failed.";
      check.disabled = false;
    }
  });

  const tabs = h("div", { class: "tabs", role: "group", "aria-label": "Show orders" });
  for (const key of ["all", "open", "paid", "expired", "paid_late"]) {
    const n = key === "all" ? s.orders.length : s.counts[key as keyof Summary["counts"]];
    tabs.append(
      h(
        "button",
        {
          class: `tab${filter === key ? " tab-on" : ""}`,
          type: "button",
          "aria-pressed": filter === key ? "true" : "false",
          onclick: () => {
            filter = key;
            render(s);
          },
        },
        `${key === "all" ? "All" : STATUS_WORDS[key]} (${n})`,
      ),
    );
  }

  const rows = s.orders.filter((o) => filter === "all" || o.status === filter);
  const orders = h("div", { class: "orders" });
  if (!rows.length) orders.append(h("p", { class: "fine" }, "No orders here yet."));
  for (const o of rows) {
    orders.append(
      h(
        "article",
        { class: `order order-${o.status}` },
        h("div", { class: "order-top" }, h("strong", {}, o.look), h("span", { class: `badge badge-${o.status}` }, STATUS_WORDS[o.status] ?? o.status)),
        h("div", { class: "order-amount" }, `${o.xno} XNO · $${o.usd}`),
        h("div", { class: "fine" }, `Player ${shortAddress(o.player)} · made ${when(o.createdAt)}`),
        o.paidAt ? h("div", { class: "fine" }, `Payment seen ${when(o.paidAt)}${o.payer ? ` from ${shortAddress(o.payer)}` : ""}`) : null,
        o.status === "paid_late" && o.payer ? h("div", { class: "late-note" }, "Send this amount back by hand to ", h("code", {}, o.payer), ". The game holds no key, so it cannot send it.") : null,
        o.hash ? h("div", { class: "fine hash" }, `Block ${o.hash}`) : null,
      ),
    );
  }

  const players = h("div", { class: "players" });
  if (!s.players.length) players.append(h("p", { class: "fine" }, "Nobody owns a paid look yet."));
  for (const p of s.players) players.append(h("div", { class: "player" }, h("code", {}, p.player), h("span", {}, p.looks.map((l) => l.name).join(", "))));

  const parts: (Node | null)[] = [
    s.warnings.length ? h("section", { class: "admin-card warnings", role: "alert" }, h("h2", {}, "Check these"), h("ul", {}, ...s.warnings.map((w) => h("li", {}, w)))) : null,
    h(
      "section",
      { class: "totals" },
      h("div", { class: "total" }, h("span", {}, "Paid"), h("strong", {}, `${s.totals.paid.xno} XNO`), h("small", {}, `$${s.totals.paid.usd} · ${plural(s.totals.paid.count, "order")}`)),
      h("div", { class: "total" }, h("span", {}, "Paid late (send back)"), h("strong", {}, `${s.totals.paidLate.xno} XNO`), h("small", {}, `$${s.totals.paidLate.usd} · ${plural(s.totals.paidLate.count, "order")}`)),
      h("div", { class: "total" }, h("span", {}, "Open now"), h("strong", {}, String(s.counts.open)), h("small", {}, `${s.counts.expired} expired`)),
    ),
    shelfCard(s),
    h("section", { class: "admin-card" }, h("div", { class: "card-head" }, h("h2", {}, "Orders"), h("div", {}, check, " ", checkNote)), tabs, orders),
    h("section", { class: "admin-card" }, h("h2", {}, "Owned looks"), players),
    h(
      "section",
      { class: "admin-card fine" },
      h("p", {}, "Signed in as ", h("code", {}, s.address), "."),
      h("p", {}, `Payments are checked on: ${s.nodes.join(", ")}.`),
      s.rate ? h("p", {}, `Last price: $${s.rate.usd} per XNO (${s.rate.sources.join(", ")}), ${when(s.rate.at)}.`) : null,
      signOutButton(),
    ),
  ];
  data.replaceChildren(...parts.filter((p): p is Node => p !== null));
}

load();
