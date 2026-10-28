// The short browser name and the rough country that the admin's sign-in list keeps. Only fixed words come out: nothing of the browser's own text.
import { describe, expect, it } from "vitest";
import { countryOf, shortBrowser } from "../src/worker/browser";

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  operaWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};
const VOCABULARY = /^(?:Unknown browser|(?:Edge|Opera|Samsung Internet|Firefox|Chrome|Safari|Browser)(?: on (?:iOS|Android|ChromeOS|Windows|macOS|Linux))?)$/;

describe("the short browser name", () => {
  it("names a browser and a system from fixed lists", () => {
    expect(shortBrowser(UA.chromeMac)).toBe("Chrome on macOS");
    expect(shortBrowser(UA.edgeWin)).toBe("Edge on Windows");
    expect(shortBrowser(UA.firefoxLinux)).toBe("Firefox on Linux");
    expect(shortBrowser(UA.safariIos)).toBe("Safari on iOS");
    expect(shortBrowser(UA.chromeIos)).toBe("Chrome on iOS");
    expect(shortBrowser(UA.safariMac)).toBe("Safari on macOS");
    expect(shortBrowser(UA.chromeAndroid)).toBe("Chrome on Android");
    expect(shortBrowser(UA.samsung)).toBe("Samsung Internet on Android");
    expect(shortBrowser(UA.operaWin)).toBe("Opera on Windows");
    expect(shortBrowser(UA.chromeOs)).toBe("Chrome on ChromeOS");
  });

  it("gives 'Unknown browser' for nothing, a bot or a text that is no browser, and never echoes any of the browser's own text", () => {
    for (const ua of [null, undefined, "", "curl/8.4.0", "Googlebot/2.1 (+http://www.google.com/bot.html)", "<script>alert(1)</script>", "x".repeat(100_000), "\u0000\u0001", "Mozilla/5.0 (compatible; MSIE 9.0; <img src=x onerror=alert(1)>)"]) {
      const name = shortBrowser(ua as string);
      expect(name, String(ua).slice(0, 40)).toMatch(VOCABULARY);
      expect(name.length).toBeLessThanOrEqual(40);
    }
    expect(shortBrowser("curl/8.4.0")).toBe("Unknown browser");
    // A hostile text that holds a real browser's words still gives only the fixed name.
    expect(shortBrowser("<script>alert(1)</script> Firefox/121.0 (Windows)")).toBe("Firefox on Windows");
    for (const ua of Object.values(UA)) expect(shortBrowser(ua)).toMatch(VOCABULARY);
  });

  it("reads only the start of a long text, so a long text cannot make it slow", () => {
    const started = performance.now();
    shortBrowser(`${"a".repeat(500_000)} Chrome/120 Macintosh`);
    expect(performance.now() - started).toBeLessThan(50);
    expect(shortBrowser(`${"a".repeat(500_000)} Chrome/120 Macintosh`)).toBe("Unknown browser");
  });
});

describe("the rough country", () => {
  const withHeader = (v?: string) => new Request("https://game.test/", { headers: v === undefined ? {} : { "CF-IPCountry": v } });
  it("is Cloudflare's two capital letters, or nothing", () => {
    expect(countryOf(withHeader("US"))).toBe("US");
    expect(countryOf(withHeader("DE"))).toBe("DE");
    for (const v of [undefined, "", "XX", "T1", "us", "USA", "U", "U1", "1U", "<s>", "U.", "US,DE"]) expect(countryOf(withHeader(v)), String(v)).toBeNull();
  });
});
