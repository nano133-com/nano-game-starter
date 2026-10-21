// Cloudflare Turnstile in the page, only when the game has a site key (see /api/config). It proves the
// visitor is a person before a sign-in or an order. Its script comes from challenges.cloudflare.com.

type TurnstileApi = { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void };
let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve((window as unknown as { turnstile: TurnstileApi }).turnstile);
    s.onerror = () => {
      loading = null;
      reject(new Error("The person check did not load. Check your connection and try again."));
    };
    document.head.append(s);
  });
  return loading;
}

/** Shows the check in `box` and resolves with its token. Null when Turnstile is off for this game. */
export async function personCheck(siteKey: string | null, box: HTMLElement): Promise<string | null> {
  if (!siteKey) return null;
  const api = await load();
  return new Promise((resolve, reject) => {
    box.hidden = false;
    const id = api.render(box, {
      sitekey: siteKey,
      callback: (token: string) => {
        resolve(token);
        setTimeout(() => api.remove(id), 0);
        box.hidden = true;
      },
      "error-callback": () => reject(new Error("The person check failed. Try again.")),
    });
  });
}
