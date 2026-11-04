// The creator's admin page: the package's panel (@nano133/nanoterra/admin/panel), drawn into #admin-panel. The panel shows the game's two switches and friends list, its
// numbers, the Shelf, the orders and the looks that players own; only the game's receive address can read any of it (the Worker checks it on every call).
// This file gives the panel what only this game has: its looks (and their pictures, ui/lookPreview.ts), its person check, and its FROZEN passkey scheme
// and name (the player sheet's, for the owner's passkeys). The wallet sign-in for the ADMIN login, the owner's passkeys and the sign-out of it are the
// package's (@nano133/nanoterra/admin-signin/panel, on the Worker's /api/admin-signin).

import "./style.css";
import "@nano133/nanoterra/admin/style.css";
import "@nano133/nanoterra/admin-signin/style.css";
import "./admin.css";
import { mountAdmin, previewPicture } from "@nano133/nanoterra/admin/panel";
import { adminSignIn, adminSignOut, ownerPasskeys } from "@nano133/nanoterra/admin-signin/panel";
import { previewHost } from "@nano133/nanoterra/player-signin/panel";
import { CONFIG } from "../shared/config";
import { LOOKS } from "../shared/looks";
import plays from "../../plays.json";
import { SCHEME } from "../shared/scheme";
import { get, type Config } from "./ui/api";
import { personCheck } from "./ui/turnstile";

/** The game's settings, read once: Turnstile's site key (or null) for the person check before a sign-in starts. */
let config: Promise<Config> | null = null;
const configOf = () => (config ??= get<Config>("/api/config").catch((): Config => ({ name: "", creator: "", testMode: true, turnstileSiteKey: null })));

// The owner's passkeys (a passkey is only a key to /admin: the money stays in the wallet). They come from the game's FROZEN scheme and name, the same
// that the player sheet takes (src/client/main.ts), so a passkey the owner also plays with can be linked too: its PLAYER signature still opens nothing
// here. A passkey belongs to one domain for good, so on a preview address (*.workers.dev) there is no Passkey tile and no "Owner passkeys" card, as
// the player sheet offers no passkey there: they turn on with the game's own domain. (The admin sign-in's panel does not check the host itself.)
const passkeys = !previewHost(location.hostname);
const passkey = { scheme: SCHEME, name: CONFIG.name };

mountAdmin(document.getElementById("admin-panel")!, {
  looks: LOOKS,
  plays,
  // Each look on the game's own character (with its hat and its model), drawn when the Shelf opens; the flat picture until then.
  lookPicture: previewPicture(() => import("./ui/lookPreview").then((m) => m.render)),
  defaultsFile: "game.config.json",
  noAddressHelp: "Set RECEIVE_ADDRESS in your Cloudflare dashboard (Workers & Pages, your game, Settings, Variables), then deploy again.",
  repoHelp: "To get a link to your looks.json on GitHub, set GITHUB_REPO (for example your-name/your-game) in wrangler.jsonc.",
  loginsNote: "This game keeps each sign-in for 30 days: only the time, the rough country and a short browser name. No address, no IP address and no browser text.",
  // The wallet sign-in of the ADMIN (its own cookie, `admin`): Berry Wallet or Nautilus; only a wallet signature that was started from /admin, or a
  // passkey that the owner's wallet linked (the Passkey tile), makes an admin login. NanChat is not offered: its text cannot name the admin.
  signIn: adminSignIn({ personCheck: async (box) => personCheck((await configOf()).turnstileSiteKey, box), ...(passkeys ? { passkeys: true, ...passkey } : {}) }),
  // Settings, "Owner passkeys": the list, Add a passkey and Remove (both only after a WALLET sign-in).
  cards: passkeys ? [ownerPasskeys(passkey)] : [],
  // Only the admin login: the game's login (another person, perhaps) stays.
  signOut: adminSignOut(),
  // The game offers its players a passkey (the package's player sign-in): on a *.workers.dev address the "Check these" banner says that passkeys
  // turn on when the game has its own domain (a passkey belongs to one domain for good).
  playerPasskeys: true,
});
