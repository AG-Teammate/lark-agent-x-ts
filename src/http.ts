/** Web client UA; both the gateway and the login endpoints validate requests as browser requests. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/**
 * Non-2xx response (equivalent to requests' raise_for_status, with the same message format).
 * reason is the failure reason given by the server (error text from the gateway response, e.g. `chat not in thread mode`), or an empty string if none;
 * it is kept out of message so the error text stays identical to the original.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    url: string,
    readonly reason = '',
  ) {
    super(`${status} ${status < 500 ? 'Client' : 'Server'} Error: ${statusText} for url: ${url}`);
  }
}

/** Network-layer errors such as connection failures and timeouts; the message starts with "Network request failed" so callers can tell network problems from credential problems. */
export class NetworkError extends Error {}

export const cookieHeader = (cookies: Record<string, string>): string =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

export interface RequestOptions {
  method?: string;
  params?: Record<string, string | number>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: RequestInit['body'];
  timeoutMs?: number;
  redirect?: RequestInit['redirect'];
}

export async function request(url: string, o: RequestOptions = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(o.params ?? {})) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookies && Object.keys(o.cookies).length) headers.cookie = cookieHeader(o.cookies);
  try {
    return await fetch(u, {
      method: o.method ?? 'GET',
      headers,
      ...(o.body === undefined ? {} : { body: o.body }),
      redirect: o.redirect ?? 'follow',
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const e = err as Error;
    const reason =
      e.name === 'TimeoutError' ? `Read timed out (${o.timeoutMs ?? 15_000}ms)` : e.message;
    throw new NetworkError(`Network request failed (${u.host}): ${reason}`);
  }
}

export function raiseForStatus(res: Response): Response {
  if (!res.ok) throw new HttpError(res.status, res.statusText, res.url);
  return res;
}

function parseSetCookie(line: string): { name: string; value: string; expired: boolean } | null {
  const [pair = '', ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  let expired = false;
  for (const a of attrs) {
    const [k = '', v = ''] = a.trim().split('=');
    const key = k.toLowerCase();
    if (key === 'max-age' && Number(v) <= 0) expired = true;
    if (key === 'expires' && Date.parse(v) < Date.now()) expired = true;
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), expired };
}

/**
 * Cookie jar (equivalent to a requests session's cookies): follows redirects manually, collecting Set-Cookie from every hop and sending them all on later requests.
 * Used for QR login and the messenger page (which 302-redirects to the tenant subdomain and sets cookies along the way); all hosts involved are subdomains of one region, so cookies are not scoped per domain.
 */
export class CookieJar {
  readonly cookies: Record<string, string>;

  constructor(initial: Record<string, string> = {}) {
    this.cookies = { ...initial };
  }

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const c = parseSetCookie(line);
      if (!c) continue;
      if (c.expired) delete this.cookies[c.name];
      else this.cookies[c.name] = c.value;
    }
  }

  async fetch(url: string, o: RequestOptions = {}): Promise<Response> {
    let current = url;
    let opts: RequestOptions = { ...o };
    for (let hop = 0; hop < 10; hop++) {
      const res = await request(current, {
        ...opts,
        cookies: { ...this.cookies, ...(o.cookies ?? {}) },
        redirect: 'manual',
      });
      this.absorb(res);
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return res;
      current = new URL(location, current).toString();
      // Same as browsers: 303, and 301/302 for POST, switch to GET and drop the request body
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && opts.method === 'POST')
      ) {
        const { body: _body, params: _params, ...rest } = opts;
        opts = { ...rest, method: 'GET' };
      } else {
        const { params: _params, ...rest } = opts;
        opts = rest;
      }
    }
    throw new NetworkError(`Network request failed (${new URL(url).host}): too many redirects`);
  }
}
