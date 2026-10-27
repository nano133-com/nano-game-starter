// The "Game" card of /admin: two switches, "Players use their Nanoterra character" and "Players can sign in with Nanoterra". A press saves at
// once (POST /api/admin/game, behind the same admin guard as every admin call) and the Worker reads the setting at run time, so the creator pushes
// and deploys nothing. The words are in src/shared/gameSwitches.ts. The card changes ONLY these two settings: never a look, a price or an order.

import { pressOf, REVIEW_LINK, REVIEW_NOTE, stateOf, SWITCHES, type GameSettings, type SwitchId } from "../shared/gameSwitches";
import { ApiError, post } from "./ui/api";
import { h } from "./ui/dom";

export type GameState = GameSettings & { fromAdmin: { character: boolean; signin: boolean } };

/** The card for the settings `initial`. It keeps its own state: a press shows "Saving…", then "Saved" or the server's words. */
export function gameCard(initial: GameState): HTMLElement {
  let state = initial;
  const rows = new Map<SwitchId, { button: HTMLButtonElement; sentence: HTMLElement; status: HTMLElement }>();
  const card = h("section", { class: "admin-card game-card", "aria-labelledby": "game-title" }, h("h2", { id: "game-title" }, "Game"));
  card.append(h("p", { class: "fine" }, "Two choices about your game. A press saves at once: you push nothing and deploy nothing. They start from game.config.json, and a press here wins."));

  const draw = () => {
    for (const [id, row] of rows) {
      const on = stateOf(id, state);
      row.button.setAttribute("aria-checked", on ? "true" : "false");
      row.button.classList.toggle("switch-on", on);
      row.button.querySelector(".switch-word")!.textContent = on ? "On" : "Off";
      row.sentence.textContent = on ? SWITCHES[id].on : SWITCHES[id].off;
    }
  };

  const press = async (id: SwitchId) => {
    const row = rows.get(id)!;
    row.button.disabled = true;
    row.status.textContent = "Saving…";
    try {
      state = await post<GameState>("/api/admin/game", pressOf(id, state));
      row.status.textContent = "Saved.";
      draw();
    } catch (e) {
      row.status.textContent = e instanceof ApiError ? e.message : "The game's server did not answer. Nothing was changed.";
    } finally {
      row.button.disabled = false;
    }
  };

  for (const id of ["character", "signin"] as const) {
    const label = h("span", { class: "switch-title", id: `switch-${id}-label` }, SWITCHES[id].title);
    const button = h(
      "button",
      { class: "switch", type: "button", role: "switch", "aria-checked": "false", "aria-labelledby": `switch-${id}-label`, "aria-describedby": `switch-${id}-note` },
      h("span", { class: "switch-word" }, "Off"),
      h("span", { class: "switch-knob", "aria-hidden": "true" }),
    );
    const sentence = h("p", { class: "switch-note", id: `switch-${id}-note` });
    const status = h("span", { class: "fine", role: "status", "aria-live": "polite" });
    button.addEventListener("click", () => void press(id));
    rows.set(id, { button, sentence, status });
    card.append(h("div", { class: "switch-row" }, h("div", { class: "switch-head" }, label, button), sentence, status));
    // The sign-in word is part of the listing file: Nanoterra's review decides what Nanoterra shows. This page cannot see that review.
    if (id === "signin") card.append(h("p", { class: "fine switch-review" }, REVIEW_NOTE, " ", h("a", { href: REVIEW_LINK, target: "_blank", rel: "noopener noreferrer" }, "Open the launch page")));
  }
  draw();
  return card;
}
