import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { credentialsPath, loadConfig } from './config.js';
import { CookieJar, request, USER_AGENT } from './http.js';
import { getLogger } from './log.js';
import { PyFloat, pyDumps } from './pyjson.js';
import { getRegion, type Region, urls, webOrigin } from './region.js';

const logger = getLogger('larkx.auth');

/** Credentials are missing or were revoked by the server; re-login required. */
export class AuthExpired extends Error {}

const nowSeconds = () => Date.now() / 1000;
const ageHours = (savedAt: number) => (savedAt ? (nowSeconds() - savedAt) / 3600 : -1).toFixed(1);

/** Credentials: `<LARKX_HOME>/credentials.json`, same format as the original project (credentials from the Python version's login can be reused as-is). */
export class LarkAuth {
  region: Region;
  cookies: Record<string, string> = {};
  savedAt = 0;
  deviceId = '';
  appKey = '';
  userId = '';
  csrfToken = '';
  webAppId = '';

  constructor(readonly path: string = credentialsPath()) {
    this.region = getRegion(loadConfig().region);
    this.load();
  }

  load(): boolean {
    if (!existsSync(this.path)) return false;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
      // Credentials saved before regions were introduced are all Feishu
      this.region = getRegion(String(data.region || 'feishu'));
      this.cookies = (data.cookies as Record<string, string>) ?? {};
      this.savedAt = Number(data.saved_at ?? 0);
      this.deviceId = String(data.device_id ?? '');
      this.appKey = String(data.app_key ?? '');
      this.userId = String(data.user_id ?? '');
      this.csrfToken = String(data.csrf_token ?? '');
      this.webAppId = String(data.web_app_id ?? '');
      return Object.keys(this.cookies).length > 0;
    } catch (err) {
      logger.warning(`failed to read credentials file: ${(err as Error).message}`);
      return false;
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data = {
      region: this.region.name,
      cookies: this.cookies,
      saved_at: this.savedAt ? new PyFloat(this.savedAt) : 0,
      device_id: this.deviceId,
      app_key: this.appKey,
      user_id: this.userId,
      csrf_token: this.csrfToken,
      web_app_id: this.webAppId,
    };
    writeFileSync(this.path, pyDumps(data, { indent: 2 }), 'utf8');
    logger.info(`credentials saved to ${this.path}`);
  }

  get gatewayAppId(): string {
    return this.webAppId || this.region.webAppId;
  }

  get hasCredentials(): boolean {
    return Object.keys(this.cookies).length > 0;
  }

  /** Swap in cookies from a fresh login; app_key etc. derived from the old account/region are discarded and re-fetched. */
  async adoptCookies(cookies: Record<string, string>, region: Region): Promise<[boolean, string]> {
    this.region = region;
    this.cookies = cookies;
    this.savedAt = nowSeconds();
    this.deviceId = cookies.passport_web_did ?? '';
    this.csrfToken = cookies.swp_csrf_token ?? '';
    this.appKey = '';
    this.webAppId = '';
    this.userId = '';
    const result = await this.validate(true);
    this.save();
    return result;
  }

  async importCookieString(cookieStr: string, region?: Region): Promise<string> {
    const cookies: Record<string, string> = {};
    for (const raw of cookieStr.trim().split(';')) {
      const part = raw.trim();
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      cookies[part.slice(0, eq)] = part.slice(eq + 1);
    }
    if (!('session' in cookies))
      throw new Error('cookie has no session; make sure you copied all of it');
    const [ok, msg] = await this.adoptCookies(cookies, region ?? this.region);
    if (!ok) throw new AuthExpired(`imported cookie failed validation: ${msg}`);
    return msg;
  }

  /** Online check: valid if a long-connection ticket can be obtained. fetchProfile also fills in user_id, app_key and web_app_id. */
  async validate(fetchProfile = false): Promise<[boolean, string]> {
    if (!this.hasCredentials) return [false, 'no credentials; run lark auth import first'];
    if (!this.deviceId) this.deviceId = this.cookies.passport_web_did ?? '';
    try {
      const res = await request(urls.ticket(this.region), {
        params: { local_device_id: this.deviceId },
        cookies: this.cookies,
        timeoutMs: 10_000,
      });
      const j = (await res.json()) as Record<string, unknown>;
      if (!j.ticket) {
        const reason = String(j.message ?? JSON.stringify(j));
        return [
          false,
          `session revoked by server (credentials saved ${ageHours(this.savedAt)}h ago): ${reason}\nlog in again: lark auth qr or lark auth import`,
        ];
      }
    } catch (err) {
      return [
        false,
        `ticket probe network error (check your network; credentials may be fine): ${(err as Error).message}`,
      ];
    }
    if (fetchProfile) await this.fetchProfile();
    return [true, `valid (user_id=${this.userId || '?'}, saved ${ageHours(this.savedAt)}h ago)`];
  }

  async fetchProfile(): Promise<void> {
    const ua = { 'user-agent': USER_AGENT };
    try {
      const res = await request(urls.userInfo(this.region), {
        params: { app_id: '12', _t: Date.now() },
        headers: {
          ...ua,
          'x-app-id': '12',
          'x-api-version': '1.0.8',
          'x-csrf-token': this.csrfToken || (this.cookies.swp_csrf_token ?? ''),
          'x-device-info': 'platform=websdk',
          'x-lgw-os-type': '1',
          'x-lgw-terminal-type': '2',
          origin: webOrigin(this.region),
          referer: `${webOrigin(this.region)}/`,
        },
        cookies: this.cookies,
        timeoutMs: 10_000,
      });
      const j = (await res.json()) as { data: { user: { id: unknown } } };
      this.userId = String(j.data.user.id);
    } catch (err) {
      logger.warning(`failed to fetch user profile: ${(err as Error).message}`);
    }
    if (!this.appKey || !this.webAppId) {
      try {
        // The page 302-redirects to the tenant subdomain and sets cookies along the way; follow redirects carrying them, like a browser does
        const res = await new CookieJar(this.cookies).fetch(urls.messengerPage(this.region), {
          headers: ua,
        });
        const text = await res.text();
        const key = /appKey: "(.*?)"/.exec(text);
        if (key) this.appKey = key[1] as string;
        else logger.warning('appKey scrape failed: no appKey in page (UA or page layout changed?)');
        const tea = /teaAppId["']?\s*:\s*["']?(\d+)/.exec(text);
        if (tea) this.webAppId = tea[1] as string;
        else
          logger.debug(
            `no teaAppId in page; x-appid falls back to the ${this.region.name} default ${this.region.webAppId}`,
          );
      } catch (err) {
        logger.warning(`failed to fetch appKey: ${(err as Error).message}`);
      }
    }
    if (!this.appKey)
      logger.error('app_key is empty; WS will be rejected (cannot compute access_key)');
  }

  async requireValid(): Promise<string> {
    const [ok, msg] = await this.validate();
    if (!ok)
      throw new AuthExpired(
        `credentials expired or invalid: ${msg}\ncopy the cookie from your browser again and run: lark auth import`,
      );
    return msg;
  }

  /** Long-connection ticket; failing to get one means the credentials are no longer valid. */
  async getTicket(): Promise<string> {
    const res = await request(urls.ticket(this.region), {
      params: { local_device_id: this.deviceId },
      cookies: this.cookies,
      timeoutMs: 10_000,
    });
    const j = (await res.json()) as Record<string, unknown>;
    if (!j.ticket) throw new AuthExpired(`failed to get ticket: ${JSON.stringify(j)}`);
    return String(j.ticket);
  }

  status(): Record<string, unknown> {
    return {
      region: this.region.name,
      has_credentials: this.hasCredentials,
      saved_at: this.savedAt ? new PyFloat(this.savedAt) : 0,
      device_id: this.deviceId,
      user_id: this.userId,
      app_key: this.appKey,
      web_app_id: this.gatewayAppId,
      path: this.path,
    };
  }
}

export const QR_STATUS_NAMES: Record<number, string> = {
  0: 'SUCCESS',
  1: 'waiting for scan',
  2: 'scanned, awaiting confirmation',
  3: 'cancelled',
  4: 'error',
  5: 'expired',
};

/** QR login: init gets the QR token, then polls until login completes and hands the session cookies to LarkAuth. */
export class QrLogin {
  private readonly jar = new CookieJar();
  private flowKey = '';
  token = '';
  qrContent = '';

  private constructor(readonly region: Region) {}

  static async start(region: Region = getRegion(loadConfig().region)): Promise<QrLogin> {
    const ql = new QrLogin(region);
    const res = await ql.post('/accounts/qrlogin/init', { redirect_uri: urls.qrRedirect(region) });
    const j = (await res.json()) as { code?: number; data?: { step_info?: { token?: string } } };
    if (j.code !== 0) throw new AuthExpired(`QR init failed: ${JSON.stringify(j)}`);
    ql.flowKey = res.headers.get('x-flow-key') ?? '';
    ql.token = j.data?.step_info?.token ?? '';
    ql.qrContent = JSON.stringify({ qrlogin: { token: ql.token } });
    return ql;
  }

  private post(path: string, body: unknown): Promise<Response> {
    const origin = urls.accountsOrigin(this.region);
    return this.jar.fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'X-App-Id': '1',
        'X-Api-Version': '1.0.8',
        'X-Device-Info': 'platform=websdk',
        'X-Terminal-Type': '2',
        Origin: origin,
        Referer: `${origin}/accounts/page/login?app_id=1`,
        ...(this.flowKey ? { 'X-Flow-Key': this.flowKey } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** Poll QR scan status until login completes (true), is cancelled / errors / expires (false), or times out. */
  async wait(
    timeoutS = 180,
    intervalS = 2,
    onStatus?: (status: number | undefined, step: string | undefined) => void,
  ): Promise<[boolean, Record<string, unknown> | null]> {
    const deadline = Date.now() + timeoutS * 1000;
    let last: number | undefined | null = null;
    while (Date.now() < deadline) {
      const j = (await (await this.post('/accounts/qrlogin/polling', {})).json()) as {
        data?: { next_step?: string; step_info?: { status?: number } };
      };
      const data = j.data ?? {};
      const step = data.next_step;
      const status = data.step_info?.status;
      if (status !== last && onStatus) {
        onStatus(status, step);
        last = status;
      }
      if (step !== 'qr_login_polling' || this.jar.cookies.session || status === 0)
        return [true, data];
      if (status === 3 || status === 4 || status === 5) return [false, data];
      await sleep(intervalS * 1000);
    }
    return [false, null];
  }

  async finish(auth: LarkAuth): Promise<string> {
    const cookies = { ...this.jar.cookies };
    if (!('session' in cookies))
      throw new AuthExpired('login flow finished without a session cookie');
    const [ok, msg] = await auth.adoptCookies(cookies, this.region);
    if (!ok) throw new AuthExpired(`login succeeded but credential validation failed: ${msg}`);
    return msg;
  }
}
