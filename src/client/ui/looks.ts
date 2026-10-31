// The looks list: wear a look you own, or buy one. Every look is shown with its price before any step:
// nothing is random, and there are no loot boxes.

import { OUTFITS, usdText, type Look, type Outfit } from "../../shared/looks";
import { h } from "./dom";

const HAT_WORDS: Record<string, string> = { cap: "with a cap", beanie: "with a beanie", crown: "with a crown", tophat: "with a top hat" };

export function looksView(p: { owned: Set<string>; worn: string; signedIn: boolean; wear: (l: Outfit) => void; buy: (l: Look) => void }): HTMLElement {
  const list = h("ul", { class: "looks" });
  for (const look of OUTFITS) {
    const mine = look.priceUsd === 0 || p.owned.has(look.id);
    const swatch = h("span", { class: "swatch", "aria-hidden": "true" });
    swatch.style.background = look.change.body;
    if (look.change.hat) {
      const hat = h("span", { class: `swatch-hat hat-${look.change.hat}` });
      hat.style.background = look.change.hatColor ?? "#333";
      swatch.append(hat);
    }
    const worn = p.worn === look.id;
    const action = mine
      ? h("button", { class: `btn ${worn ? "" : "btn-primary"}`, type: "button", disabled: worn, onclick: () => p.wear(look) }, worn ? "Wearing" : "Wear")
      : h("button", { class: "btn btn-buy", type: "button", onclick: () => p.buy(look) }, `Buy ${usdText(look.priceUsd)}`);
    list.append(
      h(
        "li",
        { class: `look${worn ? " look-worn" : ""}` },
        swatch,
        h("span", { class: "look-text" }, h("strong", {}, look.name), h("small", {}, look.change.hat ? HAT_WORDS[look.change.hat] : "colour only", mine ? (look.priceUsd === 0 ? " · free" : " · yours") : "")),
        action,
      ),
    );
  }
  return h(
    "div",
    {},
    list,
    h("p", { class: "fine" }, "A look changes how your character looks. It never changes a score. You pay in Nano (XNO), straight to the game's creator."),
    p.signedIn ? null : h("p", { class: "fine" }, "To buy a look, sign in with Nano first: your looks belong to your Nano address."),
  );
}
