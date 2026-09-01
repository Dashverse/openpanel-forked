interface ApiConfig {
  baseUrl: string;
  defaultHeaders?: Record<string, string | Promise<string | null>>;
  maxRetries?: number;
  initialRetryDelay?: number;
}

interface FetchOptions extends RequestInit {
  retries?: number;
}

// Chrome caps keepalive request bodies at 64 KB. Stay under it with headroom
// for headers, which count against the same budget.
const KEEPALIVE_MAX_BODY_BYTES = 60_000;

/**
 * UTF-8 byte length of a request body.
 *
 * `String.length` counts UTF-16 code units, which is always <= the UTF-8 byte
 * count, so a body already over the limit by that measure is over it in bytes
 * too and we can skip the encode. Anything shorter gets measured properly:
 * counting code units undercounts non-Latin text by up to 3x, which is enough
 * to mark a 150 KB body as keepalive-eligible and have the fetch throw.
 */
function isKeepaliveEligible(body: string): boolean {
  if (body.length >= KEEPALIVE_MAX_BODY_BYTES) return false;
  if (typeof TextEncoder === 'undefined') return true;
  return new TextEncoder().encode(body).length < KEEPALIVE_MAX_BODY_BYTES;
}

export class Api {
  private baseUrl: string;
  private headers: Record<string, string | Promise<string | null>>;
  private maxRetries: number;
  private initialRetryDelay: number;

  constructor(config: ApiConfig) {
    this.baseUrl = config.baseUrl;
    this.headers = {
      'Content-Type': 'application/json',
      ...config.defaultHeaders,
    };
    this.maxRetries = config.maxRetries ?? 3;
    this.initialRetryDelay = config.initialRetryDelay ?? 500;
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    const resolvedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.headers)) {
      const resolvedValue = await value;
      if (resolvedValue !== null) {
        resolvedHeaders[key] = resolvedValue;
      }
    }
    return resolvedHeaders;
  }

  public addHeader(key: string, value: string | Promise<string | null>) {
    this.headers[key] = value;
  }

  private async post<ReqBody, ResBody>(
    url: string,
    data: ReqBody,
    options: FetchOptions,
    attempt: number,
  ): Promise<ResBody | null> {
    try {
      const body = data ? JSON.stringify(data ?? {}) : undefined;
      // keepalive:true lets requests survive page unload, but Chrome limits
      // keepalive request bodies to 64 KB. Disable it for large payloads
      // (e.g. session-replay FullSnapshot chunks) so the fetch doesn't fail.
      const keepalive = !body || isKeepaliveEligible(body);
      const response = await fetch(url, {
        method: 'POST',
        headers: await this.resolveHeaders(),
        body,
        keepalive,
        ...options,
      });

      if (response.status === 401) return null;

      if (response.status !== 200 && response.status !== 202) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const responseText = await response.text();
      return responseText ? JSON.parse(responseText) : null;
    } catch (error) {
      if (attempt < this.maxRetries) {
        const delay = this.initialRetryDelay * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.post<ReqBody, ResBody>(url, data, options, attempt + 1);
      }
      console.error('Max retries reached:', error);
      return null;
    }
  }

  async fetch<ReqBody, ResBody>(
    path: string,
    data: ReqBody,
    options: FetchOptions = {},
  ): Promise<ResBody | null> {
    const url = `${this.baseUrl}${path}`;
    return this.post<ReqBody, ResBody>(url, data, options, 0);
  }
}
