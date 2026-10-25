// The cookie reader (src/worker/http.ts): a name is compared exactly. A cookie whose name only LOOKS like a prefixed name to this reader
// (a Unicode space in front of "__Host-session") is another cookie to a browser, and a sibling subdomain can set it: it must never pass
// for the real one.
import { describe, expect, it } from "vitest";
import { cookie, readCookie } from "../src/worker/http";

// Not a `Request`: Node's own Request refuses a header with a character above U+00FF, but workerd decodes the Cookie header as UTF-8 and the reader sees it.
const req = (header: string, url = "https://game.test/") => ({ url, headers: { get: (k: string) => (k.toLowerCase() === "cookie" ? header : null) } }) as unknown as Request;

describe("cookie()", () => {
  it("finds a cookie by its exact name, with spaces and tabs around", () => {
    expect(cookie(req("a=1; session=abc;  b=2"), "session")).toBe("abc");
    expect(cookie(req("session=abc"), "session")).toBe("abc");
    expect(cookie(req(" \tsession \t=\t abc \t; b=2"), "session")).toBe("abc");
    expect(cookie(req("a=1"), "session")).toBeNull();
    expect(cookie(new Request("https://game.test/"), "session")).toBeNull();
  });

  it("does not take a Unicode space, a zero-width mark or another look-alike for part of the name", () => {
    for (const lead of ["\u00a0", "\u2000", "\u2009", "\u3000", "\ufeff", "\u200b"]) {
      expect(cookie(req(`${lead}__Host-session=evil`), "__Host-session"), JSON.stringify(lead)).toBeNull();
      expect(cookie(req(`${lead}session=evil; session=real`), "session"), JSON.stringify(lead)).toBe("real");
      expect(readCookie(req(`${lead}__Host-session=evil`), "session"), JSON.stringify(lead)).toBeNull();
    }
  });

  it("skips a value that is not valid percent-coding instead of failing", () => {
    expect(cookie(req("session=%E0%A4%A; session=ok"), "session")).toBe("ok");
    expect(cookie(req("session=%E0%A4%A"), "session")).toBeNull();
  });
});
