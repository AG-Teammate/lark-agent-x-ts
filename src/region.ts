/**
 * Site differences between Feishu (China) and Lark (international).
 *
 * Both share the same web client code and protocol: endpoint paths, proto, and the access_key algorithm are identical; they differ only in domains,
 * the web appId (gateway request header x-appid), and default language. The region is chosen at login and stored in the credentials; all later requests use the hosts of that region
 * (cookies are only valid for their own domain and cannot be mixed).
 */
export interface Region {
  name: 'feishu' | 'lark' | 'lark-jp';
  label: string;
  domain: string;
  /** Fallback for the page's `__feishuMeta.teaAppId`; after login the actual value is scraped from the messenger page and stored in the credentials. */
  webAppId: string;
  locale: string;
  /** For separately deployed data centers whose gateway / long-connection / file hosts don't follow the `domain` rules (e.g. Lark Japan), override here; otherwise derived from `domain`. */
  hosts?: {
    api?: string;
    ws?: string;
    file?: string;
    space?: string;
    driveStream?: string;
    internal?: string;
  };
}

export const REGIONS: Record<Region['name'], Region> = {
  feishu: {
    name: 'feishu',
    label: 'Feishu',
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
    // From window.__domains on the messenger page: the login domain is *.jp.larksuite.com, but service hosts are *-jp.larksuite.com
    hosts: {
      api: 'internal-api-lark-api-jp.larksuite.com',
      ws: 'msg16-frontier-jp.larksuite.com',
      file: 'internal-api-lark-file-jp.larksuite.com',
      space: 'internal-api-space-jp.larksuite.com',
      driveStream: 'internal-api-drive-stream-jp.larksuite.com',
      internal: 'internal-api-jp.larksuite.com',
    },
  },
};

export function getRegion(name: string): Region {
  const region = REGIONS[(name || '').trim().toLowerCase() as Region['name']];
  if (!region)
    throw new Error(`unknown region: '${name}' (valid: ${Object.keys(REGIONS).join(', ')})`);
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
  /** Drive file service used by Lark Mail attachments: upload prepare/finish, block upload, download. */
  spaceHost: (r: Region) => `https://${r.hosts?.space ?? `internal-api-space.${r.domain}`}`,
  driveStreamHost: (r: Region) =>
    `https://${r.hosts?.driveStream ?? `internal-api-drive-stream.${r.domain}`}`,
  internalHost: (r: Region) => `https://${r.hosts?.internal ?? `internal-api.${r.domain}`}`,
};
