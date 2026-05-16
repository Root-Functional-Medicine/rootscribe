import { logger } from "../logger.js";
import { loadConfig, updateConfig } from "../config.js";

const REGION_API_BASES: Record<string, string> = {
  "aws:us-west-2": "https://api.plaud.ai",
  "aws:eu-central-1": "https://api-euc1.plaud.ai",
};
const DEFAULT_API_BASE = "https://api.plaud.ai";

export function getPlaudApiBase(): string {
  const cfg = loadConfig();
  if (cfg.plaudRegion) {
    return REGION_API_BASES[cfg.plaudRegion] ?? DEFAULT_API_BASE;
  }
  return DEFAULT_API_BASE;
}

export class PlaudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaudAuthError";
  }
}

export class PlaudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "PlaudApiError";
  }
}

type FetchInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  authOverride?: string;
};

function getToken(): string {
  const cfg = loadConfig();
  if (!cfg.token) throw new PlaudAuthError("no token configured");
  return cfg.token;
}

// Plaud's API sits behind Cloudflare bot protection. A self-identifying
// "rootscribe/X (+url)" UA gets a 403 challenge; the Plaud web app uses a
// normal browser UA, so we mirror that. Confirmed 2026-05-15: bot-style UA
// → 403 Cloudflare HTML; browser UA → 200 JSON. See PR/ticket for details.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function plaudFetch(pathOrUrl: string, init: FetchInit = {}): Promise<Response> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${getPlaudApiBase()}${pathOrUrl}`;
  const token = init.authOverride ?? getToken();
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    authorization: `Bearer ${token}`,
    ...init.headers,
  };
  // Default JSON content type for methods that likely send a body.
  if (init.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers });
      if (res.status === 401) {
        updateConfig({ setupComplete: true });
        throw new PlaudAuthError("Plaud returned 401 — token expired or revoked");
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        const waitMs = attempt * 1000;
        logger.warn({ url, status: res.status, attempt }, "Plaud 5xx — retrying");
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof PlaudAuthError) throw err;
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
    }
  }
  throw new PlaudApiError(
    `network error after ${maxAttempts} attempts: ${String(lastErr)}`,
    0,
    "",
  );
}

export async function plaudJson<T>(path: string, init: FetchInit = {}): Promise<T> {
  const res = await plaudFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new PlaudApiError(
      `Plaud ${init.method ?? "GET"} ${path} → ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new PlaudApiError(
      `Plaud ${path} returned non-JSON: ${String(err)}`,
      res.status,
      text.slice(0, 500),
    );
  }
}
