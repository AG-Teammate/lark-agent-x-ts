/**
 * 飞书（国内版）与 Lark（国际版）的站点差异。
 *
 * 两版共用同一套网页客户端代码与协议：接口路径、proto、access_key 算法完全一致，区别只在域名、
 * 网页端 appId（网关请求头 x-appid）和默认语言。登录时选定区域并写入凭证，之后所有请求都按凭证里的区域取地址
 * （cookie 只对所属域名有效，不能混用）。
 */
export interface Region {
  name: 'feishu' | 'lark' | 'lark-jp';
  label: string;
  domain: string;
  /** 页面 `__feishuMeta.teaAppId` 的兜底值；登录后会从 messenger 页面抓取实际值存进凭证。 */
  webAppId: string;
  locale: string;
  /** 数据中心独立部署时网关/长连接/文件主机与 `domain` 规则不同（如 Lark 日本），在此覆盖；缺省按 `domain` 推导。 */
  hosts?: { api?: string; ws?: string; file?: string };
}

export const REGIONS: Record<Region['name'], Region> = {
  feishu: {
    name: 'feishu',
    label: '飞书',
    domain: 'feishu.cn',
    webAppId: '161471',
    locale: 'zh_CN',
  },
  lark: {
    name: 'lark',
    label: 'Lark',
    domain: 'larksuite.com',
    webAppId: '161471',
    locale: 'en_US',
  },
  'lark-jp': {
    name: 'lark-jp',
    label: 'Lark (Japan)',
    domain: 'jp.larksuite.com',
    webAppId: '161471',
    locale: 'ja_JP',
    // 来自 messenger 页面的 window.__domains：登录域是 *.jp.larksuite.com，业务主机却是 *-jp.larksuite.com
    hosts: {
      api: 'internal-api-lark-api-jp.larksuite.com',
      ws: 'msg16-frontier-jp.larksuite.com',
      file: 'internal-api-lark-file-jp.larksuite.com',
    },
  },
};

export function getRegion(name: string): Region {
  const region = REGIONS[(name || '').trim().toLowerCase() as Region['name']];
  if (!region) throw new Error(`未知区域: '${name}',可选: ${Object.keys(REGIONS).join(', ')}`);
  return region;
}

const apiHost = (r: Region) => `https://${r.hosts?.api ?? `internal-api-lark-api.${r.domain}`}`;
export const webOrigin = (r: Region) => `https://open-dev.${r.domain}`;

export const urls = {
  ticket: (r: Region) => `https://login.${r.domain}/suite/passport/frontier_ticket/`,
  userInfo: (r: Region) => `${apiHost(r)}/accounts/web/user`,
  csrf: (r: Region) => `${apiHost(r)}/accounts/csrf`,
  gateway: (r: Region) => `${apiHost(r)}/im/gateway/`,
  messengerPage: (r: Region) => `${webOrigin(r)}/messenger/`,
  qrRedirect: (r: Region) => `${webOrigin(r)}/next/messenger`,
  accountsOrigin: (r: Region) => `https://accounts.${r.domain}`,
  ws: (r: Region) => `wss://${r.hosts?.ws ?? `msg-frontier.${r.domain}`}/ws/v2`,
  fileHost: (r: Region) => `https://${r.hosts?.file ?? `internal-api-lark-file.${r.domain}`}`,
};
