// Calls to the game's own Worker (/api). Cookies stay on this site; nothing goes to another server.
import type { Look as NanoterraLook } from "@nano133/character";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) throw new ApiError(res.status, typeof body.error === "string" ? body.error : `The server answered ${res.status}. Try again.`, body);
  return body as T;
}

export const get = <T>(path: string) => call<T>(path);
export const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export type Config = { name: string; creator: string; testMode: boolean; turnstileSiteKey: string | null };
export type Me = { address: string | null; owned: string[]; admin: boolean; via?: "wallet" | "nanoterra"; username?: string; look?: NanoterraLook; nanoterraItems?: string[] };
export type Order = {
  id: string;
  lookId: string;
  usd: string;
  amount: string;
  xno: string;
  status: "open" | "paid" | "expired" | "paid_late";
  createdAt: number;
  expiresAt: number;
  test: boolean;
  address?: string;
  uri?: string;
  prices: string[];
};
