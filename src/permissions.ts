/**
 * Permissions: allow / deny execution per group or per item (a command, or `command.action` for commands that mix reads and writes); the CLI and the library share one catalog and rule set.
 *
 * Rules are two name lists, allow / deny; a name can be `*`, a group, a command, or `command.action`. Evaluation goes level by level from most specific to broadest
 * (`command.action` → command → group → `*`); the first level with a matching rule wins, with deny taking precedence within a level; if nothing matches, allow.
 * Global rules come from `LARKX_ALLOW` / `LARKX_DENY`; if the account has its own rules in `permissions.json` next to the credentials, they replace the global rules entirely.
 *
 * This is a guardrail against mistakes, not a security boundary: any caller that can change env vars or the data directory can bypass it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LarkAuth } from './auth.js';
import { asList } from './config.js';

/** Groups are divided by their effect on the outside world; the order here is the listing order of `lark permissions`. */
export const GROUPS = {
  local: '只读本机数据(凭证状态、配置、本地消息库),不联网',
  query: '只读飞书数据(消息、会话、成员、已读情况、翻译等),不留下别人看得见的变化',
  outbound: '以本人身份发出新消息(发送、定时、转发)',
  modify: '改动已有消息或别人看得见的状态(撤回、编辑、表情、Pin、标已读)',
  organize: '只影响自己的整理(标记、会话置顶)',
  manage: '群管理(建群、拉人、移出、改群名)',
  system: '账号与进程级操作(登录、常驻接收、调任意网关接口、改权限)',
} as const;

export type Group = keyof typeof GROUPS;

/** All permission items and their groups: one item per CLI command (or `command.action`); library methods map onto the same items. */
export const PERMISSIONS = {
  'auth.status': 'local',
  config: 'local',
  'chats.local': 'local',
  sessions: 'local',
  messages: 'local',
  'permissions.show': 'local',

  'auth.check': 'query',
  history: 'query',
  get: 'query',
  thread: 'query',
  search: 'query',
  'search-messages': 'query',
  unread: 'query',
  members: 'query',
  users: 'query',
  reactions: 'query',
  'read-status': 'query',
  pins: 'query',
  flags: 'query',
  tags: 'query',
  translate: 'query',
  'message-link': 'query',
  'self-chat': 'query',
  download: 'query',
  'scheduled.list': 'query',
  'shortcut.list': 'query',
  'chats.remote': 'query',

  send: 'outbound',
  'send-image': 'outbound',
  'send-file': 'outbound',
  schedule: 'outbound',
  forward: 'outbound',
  'scheduled.cancel': 'outbound',
  'scheduled.reschedule': 'outbound',

  recall: 'modify',
  edit: 'modify',
  react: 'modify',
  pin: 'modify',
  read: 'modify',

  flag: 'organize',
  'shortcut.add': 'organize',
  'shortcut.remove': 'organize',

  'group.create': 'manage',
  'group.add': 'manage',
  'group.remove': 'manage',
  'group.rename': 'manage',

  'auth.qr': 'system',
  'auth.import': 'system',
  listen: 'system',
  api: 'system',
  'permissions.edit': 'system',
  'permissions.clear': 'system',
} as const satisfies Record<string, Group>;

export type Permission = keyof typeof PERMISSIONS;

export const isPermission = (name: string): name is Permission => Object.hasOwn(PERMISSIONS, name);

export interface Rules {
  allow: string[];
  deny: string[];
}

export interface Verdict {
  allowed: boolean;
  /** The rule that took effect, e.g. `deny outbound`; empty if no rule matched. */
  rule?: string;
}

/** The command part of `command.action`; empty string for items without per-action granularity. */
const commandOf = (p: string) => (p.includes('.') ? p.slice(0, p.indexOf('.')) : '');

/** Search the given names level by level from most specific to broadest; the first level with a match wins, with deny taking precedence within a level; if nothing matches, allow. */
export function match(rules: Rules, levels: string[]): Verdict {
  for (const name of levels) {
    if (rules.deny.includes(name)) return { allowed: false, rule: `deny ${name}` };
    if (rules.allow.includes(name)) return { allowed: true, rule: `allow ${name}` };
  }
  return { allowed: true };
}

export const decide = (rules: Rules, p: Permission): Verdict =>
  match(rules, [p, commandOf(p), PERMISSIONS[p], '*'].filter(Boolean));

/** A misspelled name in the rules would let an operation that should be denied run, so unknown names are always an error. */
function validate(rules: Rules, where: string): void {
  const known = new Set<string>(['*', ...Object.keys(GROUPS)]);
  for (const p of Object.keys(PERMISSIONS)) known.add(p).add(commandOf(p));
  const unknown = [...rules.allow, ...rules.deny].filter((n) => !n || !known.has(n));
  if (unknown.length)
    throw new Error(
      `${where}里有不认识的名字: ${unknown.join(', ')}(可用: *、分组 ${Object.keys(GROUPS).join('/')}、命令名或 命令.动作,见 README 的"命令权限")`,
    );
}

/** Execution not permitted; `permission` is the denied item and `rule` is the rule that took effect. */
export class PermissionDenied extends Error {
  readonly group: Group;

  constructor(
    readonly permission: Permission,
    readonly rule: string,
    readonly source: string,
  ) {
    super(`权限不允许执行 ${permission}(分组 ${PERMISSIONS[permission]}): ${source}里的 ${rule}`);
    this.name = 'PermissionDenied';
    this.group = PERMISSIONS[permission];
  }
}

/** Per-account rules live next to the credentials file: user_id → {allow, deny}. */
export const permissionsPath = (auth: LarkAuth): string =>
  join(dirname(auth.path), 'permissions.json');

type AccountRules = Record<string, Rules>;

function readAccounts(path: string): AccountRules {
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`读取权限文件 ${path} 失败: ${(e as Error).message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`权限文件 ${path} 应是 user_id → {allow, deny} 的对象`);
  const out: AccountRules = {};
  for (const [userId, r] of Object.entries(data as Record<string, Partial<Rules>>))
    out[userId] = { allow: (r?.allow ?? []).map(String), deny: (r?.deny ?? []).map(String) };
  return out;
}

export interface EffectiveRules {
  rules: Rules;
  /** Where the rules come from, for error messages and display. */
  source: string;
  /** Whether these are the account's own rules (otherwise the global rules). */
  own: boolean;
}

/** Effective rules for the account (user_id in the credentials); falls back to the global rules when the account has none of its own. */
export function loadRules(auth: LarkAuth): EffectiveRules {
  const path = permissionsPath(auth);
  const own = auth.userId ? readAccounts(path)[auth.userId] : undefined;
  const eff: EffectiveRules = own
    ? { rules: own, source: `账号 ${auth.userId} 的规则(${path})`, own: true }
    : {
        rules: {
          allow: asList(process.env.LARKX_ALLOW ?? ''),
          deny: asList(process.env.LARKX_DENY ?? ''),
        },
        source: '全局规则(LARKX_ALLOW / LARKX_DENY)',
        own: false,
      };
  validate(eff.rules, eff.source);
  return eff;
}

/** Set the account's own rules (clears them when `rules` is null). */
export function saveAccountRules(auth: LarkAuth, rules: Rules | null): void {
  if (!auth.userId) throw new Error('凭证里没有 user_id,跟随账号的规则需要先登录');
  if (rules) validate(rules, '要保存的规则');
  const path = permissionsPath(auth);
  const accounts = readAccounts(path);
  if (rules) accounts[auth.userId] = rules;
  else delete accounts[auth.userId];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
}

/**
 * Rule source: `true` behaves like the CLI (the account's own rules, else `LARKX_ALLOW` / `LARKX_DENY`), re-read on every check,
 * so rule changes need no restart; or pass a fixed rule set directly.
 */
export type PermissionSource = true | Rules;

/** Throws PermissionDenied when not allowed. */
export function authorize(auth: LarkAuth, source: PermissionSource, p: Permission): void {
  const eff: Pick<EffectiveRules, 'rules' | 'source'> =
    source === true ? loadRules(auth) : { rules: source, source: '传入的规则' };
  const v = decide(eff.rules, p);
  if (!v.allowed) throw new PermissionDenied(p, v.rule as string, eff.source);
}

/** When enabling, validate the rules once so misconfiguration fails early. */
export function checkSource(auth: LarkAuth, source: PermissionSource): void {
  if (source === true) loadRules(auth);
  else validate(source, '传入的规则');
}

const guarding = new AsyncLocalStorage<true>();

/**
 * Add permission checks to an object's methods: only the outermost call is checked; methods calling other methods internally (e.g. send calling the gateway) are not re-checked;
 * callbacks passed in (e.g. the long connection's onMessage) run outside the checked scope, so calls made inside them are checked as usual.
 */
export function guardMethods<T extends object>(
  target: T,
  table: { [K in keyof T]?: Permission | ((...args: never) => Permission) },
  check: (p: Permission) => void,
): void {
  const methods = target as Record<string, unknown>;
  for (const [name, entry] of Object.entries(table) as [
    string,
    Permission | ((...a: unknown[]) => Permission),
  ][]) {
    const original = methods[name] as (...a: unknown[]) => unknown;
    methods[name] = async function (this: unknown, ...args: unknown[]) {
      if (guarding.getStore()) return original.apply(this, args);
      check(typeof entry === 'function' ? entry(...args) : entry);
      const outside = args.map((a) =>
        typeof a === 'function' ? (...x: unknown[]) => guarding.exit(() => a(...x)) : a,
      );
      return guarding.run(true, () => original.apply(this, outside));
    };
  }
}
