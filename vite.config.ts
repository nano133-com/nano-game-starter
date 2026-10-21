import { defineConfig, type Plugin } from "vite";
import { CONFIG } from "./src/shared/config.ts";
import { headersFile } from "./src/shared/security.ts";

/** Writes dist/client/_headers from src/shared/security.ts, so the game's files get the Worker's headers. */
function securityHeadersFile(): Plugin {
  return {
    name: "security-headers-file",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile() });
    },
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Puts the game's name and line from game.config.json into the pages. */
function gameText(): Plugin {
  return {
    name: "game-text",
    transformIndexHtml: (html) => html.replaceAll("%GAME_NAME%", escapeHtml(CONFIG.name)).replaceAll("%GAME_LINE%", escapeHtml(CONFIG.line)),
  };
}

export default defineConfig({
  plugins: [gameText(), securityHeadersFile()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022",
    // A warning, not a limit: keep the first load small for phones.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: { game: "index.html", admin: "admin.html" },
    },
  },
});
