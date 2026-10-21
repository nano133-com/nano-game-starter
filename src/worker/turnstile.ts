// Cloudflare Turnstile: a free check that a visitor is a person. It guards sign-in and new orders when both
// TURNSTILE_SITE_KEY and the secret TURNSTILE_SECRET are set; without them it is skipped, and the admin page
// says so.

import { setting, turnstileOn, type Env } from "./env";
import type { Fetch } from "./price";

const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** True when the check passes, or when Turnstile is off. */
export async function turnstileOk(env: Env, token: unknown, ip: string | null, fetchFn: Fetch = (i, init) => fetch(i, init)): Promise<boolean> {
  if (!turnstileOn(env)) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", setting(env.TURNSTILE_SECRET)!);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetchFn(VERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}
