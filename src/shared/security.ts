// The security headers of every response. The build writes them into dist/client/_headers for the game's
// files (Cloudflare serves those without running the Worker), and the Worker adds the same ones to its own
// answers. One list, so the two never drift apart.

import { mergeCsp, SHOP_CSP } from "@nano133/nanoterra/shop";

/** Turnstile (Cloudflare's free check that a visitor is a person) loads from here. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Nanoterra's friends window (the admin's friends setting "nanoterra") is a frame from here: `/embed/friends?game=<id>&v=1`. */
export const NANOTERRA_ORIGIN = "https://nano133.com";

/** The game's own policy. The shop's needs (SHOP_CSP: Turnstile, and its calls to this site) are merged in below; never replace this list with the package's. */
const GAME_POLICY = [
  "default-src 'none'",
  `script-src 'self' ${TURNSTILE_ORIGIN}`,
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src ${TURNSTILE_ORIGIN} ${NANOTERRA_ORIGIN}`,
  "manifest-src 'self'",
  "media-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  // No other site may show the game in a frame. To let one (for example Nano Island), add its origin here.
  "frame-ancestors 'none'",
].join("; ");

/** The policy of every page and answer: the game's own, with the shop's sources added (a source is never written twice). */
export const CONTENT_SECURITY_POLICY = mergeCsp(GAME_POLICY, SHOP_CSP);

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    // Browsers ignore this header on plain http (local development), so it is safe everywhere.
    "Strict-Transport-Security": "max-age=31536000",
  };
}

/** The text of the static-assets _headers file. */
export function headersFile(): string {
  const all = Object.entries(securityHeaders())
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return [
    "# Made by the build from src/shared/security.ts. Change the headers there, not here.",
    "/*",
    all,
    "",
    "# Vite gives these files a hash in their name, so they can be kept for a year.",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "# The listing pictures may be shown on other sites (Nano Island shows them).",
    "/art/*",
    "  ! Cross-Origin-Resource-Policy",
    "  Cross-Origin-Resource-Policy: cross-origin",
    "",
  ].join("\n");
}
