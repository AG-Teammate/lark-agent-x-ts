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
      logger.warning(`读取凭证文件失败: ${(err as Error).message}`);
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
    logger.info(`凭证已保存到 ${this.path}`);
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
    if (!('session' in cookies)) throw new Error('cookie 中缺少 session,请确认复制完整');
    const [ok, msg] = await this.adoptCookies(cookies, region ?? this.region);
    if (!ok) throw new AuthExpired(`导入的 cookie 校验失败: ${msg}`);
    return msg;
  }

  /** Online check: valid if a long-connection ticket can be obtained. fetchProfile also fills in user_id, app_key and web_app_id. */
  async validate(fetchProfile = false): Promise<[boolean, string]> {
    if (!this.hasCredentials) return [false, '无凭证,请先 lark auth import'];
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
          `会话已被服务端注销(凭证保存于 ${ageHours(this.savedAt)}h 前): ${reason}\n请重新登录: lark auth qr 或 lark auth import`,
        ];
      }
    } catch (err) {
      return [false, `ticket 探针网络异常(先检查网络,不一定是凭证问题): ${(err as Error).message}`];
    }
    if (fetchProfile) await this.fetchProfile();
    return [true, `有效(user_id=${this.userId || '?'}, 已保存 ${ageHours(this.savedAt)}h)`];
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
      logger.warning(`获取用户信息失败: ${(err as Error).message}`);
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
        else logger.warning('appKey 抓取失败: 页面里没有 appKey(UA/页面结构变化?)');
        const tea = /teaAppId["']?\s*:\s*["']?(\d+)/.exec(text);
        if (tea) this.webAppId = tea[1] as string;
        else
          logger.debug(
            `页面里没有 teaAppId,x-appid 沿用 ${this.region.name} 默认值 ${this.region.webAppId}`,
          );
      } catch (err) {
        logger.warning(`获取 appKey 失败: ${(err as Error).message}`);
      }
    }
    if (!this.appKey) logger.error('app_key 为空,WS 会被拒(access_key 无法计算)');
  }

  async requireValid(): Promise<string> {
    const [ok, msg] = await this.validate();
    if (!ok)
      throw new AuthExpired(
        `凭证已过期或无效: ${msg}\n请从浏览器重新复制 cookie 后执行: lark auth import`,
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
    if (!j.ticket) throw new AuthExpired(`获取 ticket 失败: ${JSON.stringify(j)}`);
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
  1: '等待扫码',
  2: '已扫码待确认',
  3: '已取消',
  4: '错误',
  5: '已过期',
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
    if (j.code !== 0) throw new AuthExpired(`qr init 失败: ${JSON.stringify(j)}`);
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
    if (!('session' in cookies)) throw new AuthExpired('登录流程结束但未拿到 session cookie');
    const [ok, msg] = await auth.adoptCookies(cookies, this.region);
    if (!ok) throw new AuthExpired(`登录成功但凭证校验失败: ${msg}`);
    return msg;
  }
}
