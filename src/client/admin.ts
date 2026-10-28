// The creator's admin page: the package's panel (@nano133/nanoterra/admin/panel), drawn into #admin-panel. The panel shows the game's two switches, its
// numbers, the Shelf, the orders and the looks that players own; only the game's receive address can read any of it (the Worker checks it on every call).
// This file gives the panel what only this game has: its looks (and their pictures, ui/lookPreview.ts), its wallet sign-in for the ADMIN login, and how
// to sign out of it.

import "./style.css";
import "@nano133/nanoterra/admin/style.css";
import "./admin.css";
import { mountAdmin, previewPicture } from "@nano133/nanoterra/admin/panel";
import { LOOKS } from "../shared/looks";
import { get, post, type Config } from "./ui/api";
import { signInView } from "./ui/signin";

mountAdmin(document.getElementById("admin-panel")!, {
  looks: LOOKS,
  // Each look on the game's own character (with its hat and its model), drawn when the Shelf opens; the flat picture until then.
  lookPicture: previewPicture(() => import("./ui/lookPreview").then((m) => m.render)),
  defaultsFile: "game.config.json",
  noAddressHelp: "Set RECEIVE_ADDRESS in your Cloudflare dashboard (Workers & Pages, your game, Settings, Variables), then deploy again.",
  repoHelp: "To get a link to your looks.json on GitHub, set GITHUB_REPO (for example your-name/your-game) in wrangler.jsonc.",
  loginsNote: "This game keeps each sign-in for 30 days: only the time, the rough country and a short browser name. No address, no IP address and no browser text.",
  // The wallet sign-in of the ADMIN scope (its own cookie): only a wallet signature that was started from /admin makes an admin login.
  signIn: async (into, done) => {
    const config = await get<Config>("/api/config").catch((): Config => ({ name: "", creator: "", testMode: true, turnstileSiteKey: null }));
    into.append(signInView(config, done, "admin").node);
  },
  // Only the admin login: the game's login (another person, perhaps) stays.
  signOut: () => post("/api/signout", { scope: "admin" }),
});
