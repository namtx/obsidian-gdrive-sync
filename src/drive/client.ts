import { HttpError, type Http, type HttpRequest, type HttpResponse } from "./http";

export interface TokenSource {
  accessToken(): Promise<string>;
  refresh(): Promise<unknown>;
}

export interface BackoffOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  maxRetries: 6,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Drive's per-user rate limits come back as 403 with these reasons. */
const RATE_LIMIT_REASONS = /rateLimitExceeded|userRateLimitExceeded/;

export function isRetryable(res: HttpResponse): boolean {
  if (res.status === 429 || res.status >= 500) return true;
  return res.status === 403 && RATE_LIMIT_REASONS.test(res.text);
}

/** Authorized HTTP with exponential backoff on 429, 5xx, rate-limit 403s and network errors. */
export class DriveClient {
  private backoff: BackoffOptions;

  constructor(
    private http: Http,
    private tokens: TokenSource,
    backoff: Partial<BackoffOptions> = {},
  ) {
    this.backoff = { ...DEFAULT_BACKOFF, ...backoff };
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const { maxRetries, baseDelayMs, maxDelayMs, sleep, random } = this.backoff;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.accessToken();
      let res: HttpResponse | null = null;
      let networkError: unknown = null;
      try {
        res = await this.http({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } });
      } catch (e) {
        networkError = e;
      }
      if (res?.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.refresh();
        attempt--;
        continue;
      }
      if (res && !isRetryable(res)) return res;
      if (attempt >= maxRetries) {
        if (res) return res;
        throw networkError;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(delay / 2 + random() * (delay / 2));
    }
  }

  /** Request and parse JSON, throwing on any non-2xx status. */
  async json<T>(req: HttpRequest, context: string): Promise<T> {
    const res = await this.request(req);
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, res.text, context);
    return JSON.parse(res.text) as T;
  }
}

/** Case-insensitive header lookup; `requestUrl` lowercases names on some platforms. */
export function header(res: HttpResponse, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(res.headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}
