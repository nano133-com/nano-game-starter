// The creator's admin page: the package's panel (@nano133/nanoterra/admin/panel), drawn into #admin-panel. The panel shows the game's two switches and friends list, its
// numbers, the Shelf, the orders and the looks that players own; only the game's receive address can read any of it (the Worker checks it on every call).
// This file gives the panel what only this game has: its looks (and their pictures, ui/lookPreview.ts) and its person check. The wallet sign-in for the
// ADMIN login, and the sign-out of it, are the package's (@nano133/nanoterra/admin-signin/panel, on the Worker's /api/admin-signin).

import "./style.css";
import "@nano133/nanoterra/admin/style.css";
import "@nano133/nanoterra/admin-signin/style.css";
import "./admin.css";
import { mountAdmin, previewPicture } from "@nano133/nanoterra/admin/panel";
import { adminSignIn, adminSignOut } from "@nano133/nanoterra/admin-signin/panel";
import { LOOKS } from "../shared/looks";
import { get, type Config } from "./ui/api";
import { personCheck } from "./ui/turnstile";

/** The game's settings, read once: Turnstile's site key (or null) for the person check before a sign-in starts. */
let config: Promise<Config> | null = null;
const configOf = () => (config ??= get<Config>("/api/config").catch((): Config => ({ name: "", creator: "", testMode: true, turnstileSiteKey: null })));

mountAdmin(document.getElementById("admin-panel")!, {
  looks: LOOKS,
  // Each look on the game's own character (with its hat and its model), drawn when the Shelf opens; the flat picture until then.
  lookPicture: previewPicture(() => import("./ui/lookPreview").then((m) => m.render)),
  defaultsFile: "game.config.json",
  noAddressHelp: "Set RECEIVE_ADDRESS in your Cloudflare dashboard (Workers & Pages, your game, Settings, Variables), then deploy again.",
  repoHelp: "To get a link to your looks.json on GitHub, set GITHUB_REPO (for example your-name/your-game) in wrangler.jsonc.",
  loginsNote: "This game keeps each sign-in for 30 days: only the time, the rough country and a short browser name. No address, no IP address and no browser text.",
  // The wallet sign-in of the ADMIN (its own cookie, `admin`): Berry Wallet or Nautilus; only a wallet signature that was started from /admin makes an
  // admin login. NanChat is not offered: its text cannot name the admin.
  signIn: adminSignIn({ personCheck: async (box) => personCheck((await configOf()).turnstileSiteKey, box) }),
  // Only the admin login: the game's login (another person, perhaps) stays.
  signOut: adminSignOut(),
  // The game offers its players a passkey (the package's player sign-in): on a *.workers.dev address the "Check these" banner says that passkeys
  // turn on when the game has its own domain (a passkey belongs to one domain for good).
  playerPasskeys: true,
});
