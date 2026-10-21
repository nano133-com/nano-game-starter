// Dollars per XNO: the median of public price feeds that need no key, so one wrong feed cannot move the
// price. The answer is kept 5 minutes. When every feed fails, the last good price is used for up to 6 hours;
// after that, new orders wait ("Prices are not available") and nothing is sold at a guessed price.
//
// CoinGecko's API terms ask for the words "Powered by CoinGecko": the pay screen shows them.

import { MAX_RATE, MIN_RATE } from "../shared/amount";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const PRICE_FEEDS: { name: string; url: string; read: (j: any) => unknown }[] = [
  { name: "CoinGecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=nano&vs_currencies=usd", read: (j) => j?.nano?.usd },
  { name: "Kraken", url: "https://api.kraken.com/0/public/Ticker?pair=NANOUSD", read: (j) => (Object.values(j?.result ?? {})[0] as any)?.c?.[0] },
  { name: "KuCoin", url: "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=XNO-USDT", read: (j) => j?.data?.price },
];

export const RATE_FRESH_MS = 5 * 60_000;
export const RATE_LAST_GOOD_MS = 6 * 60 * 60_000;

export type Rate = { usd: number; at: number; sources: string[]; stale: boolean };

/** Asks every feed at once and returns the median of the believable answers, or null. */
export async function readFeeds(fetchFn: Fetch, feeds = PRICE_FEEDS, timeoutMs = 4000): Promise<{ usd: number; sources: string[] } | null> {
  const answers = await Promise.allSettled(
    feeds.map(async (f) => {
      const res = await fetchFn(f.url, { headers: { Accept: "application/json", "User-Agent": "nano-game-starter" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Number(f.read(await res.json()));
    }),
  );
  const good = answers
    .map((a, i) => ({ name: feeds[i]!.name, v: a.status === "fulfilled" ? a.value : NaN }))
    .filter((x) => Number.isFinite(x.v) && x.v >= MIN_RATE && x.v <= MAX_RATE)
    .sort((a, b) => a.v - b.v);
  if (!good.length) return null;
  return { usd: good[Math.floor(good.length / 2)]!.v, sources: good.map((g) => g.name) };
}

/** Dollars per XNO now, or null when no believable price is known. */
export async function usdPerXno(db: D1Database, fetchFn: Fetch, now = Date.now(), feeds = PRICE_FEEDS): Promise<Rate | null> {
  const row = await db.prepare("SELECT value, at FROM meta WHERE key = 'rate'").first<{ value: string; at: number }>();
  const last = row ? (JSON.parse(row.value) as { usd: number; sources: string[] }) : null;
  if (row && last && now - row.at < RATE_FRESH_MS) return { ...last, at: row.at, stale: false };
  const fresh = await readFeeds(fetchFn, feeds);
  if (fresh) {
    await db
      .prepare("INSERT INTO meta (key, value, at) VALUES ('rate', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at")
      .bind(JSON.stringify(fresh), now)
      .run();
    return { ...fresh, at: now, stale: false };
  }
  if (row && last && now - row.at < RATE_LAST_GOOD_MS) return { ...last, at: row.at, stale: true };
  return null;
}
