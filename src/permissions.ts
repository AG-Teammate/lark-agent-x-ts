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
  local: 'Read-only local data (credential status, config, local message store); no network',
  query:
    'Read-only Lark data (messages, chats, members, read status, translation, etc.); leaves no changes visible to others',
  outbound: 'Send new messages as yourself (send, schedule, forward)',
  modify:
    'Change existing messages or state visible to others (recall, edit, reactions, pin, mark read)',
  organize: 'Personal organization only (flags, pinned chats)',
  manage: 'Group management (create groups, add/remove members, rename)',
  system:
    'Account- and process-level operations (login, long-running receive, raw gateway calls, permission changes)',
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
  'mail.labels': 'query',
  'mail.addresses': 'query',
  'mail.list': 'query',
  'mail.thread': 'query',
  'mail.get': 'query',
  'mail.search': 'query',
  'mail.download': 'query',

  send: 'outbound',
  'send-image': 'outbound',
  'send-file': 'outbound',
  schedule: 'outbound',
  forward: 'outbound',
  'scheduled.cancel': 'outbound',
  'scheduled.reschedule': 'outbound',
  'mail.send': 'outbound',
  'mail.reply': 'outbound',
  'mail.forward': 'outbound',
  'mail.send-draft': 'outbound',

  recall: 'modify',
  edit: 'modify',
  react: 'modify',
  pin: 'modify',
  read: 'modify',

  flag: 'organize',
  'shortcut.add': 'organize',
  'shortcut.remove': 'organize',
  'mail.draft': 'organize',
  'mail.delete-draft': 'organize',
  'mail.read': 'organize',
  'mail.flag': 'organize',
  'mail.label': 'organize',
  'mail.archive': 'organize',
  'mail.trash': 'organize',

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
      `unknown names in ${where}: ${unknown.join(', ')} (valid: *, groups ${Object.keys(GROUPS).join('/')}, a command name, or command.action; see "Command permissions" in the README)`,
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
    super(
      `permission denied: ${permission} (group ${PERMISSIONS[permission]}) by rule ${rule} in ${source}`,
    );
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
    throw new Error(`failed to read permissions file ${path}: ${(e as Error).message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`permissions file ${path} must be an object mapping user_id → {allow, deny}`);
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
    ? { rules: own, source: `rules for account ${auth.userId} (${path})`, own: true }
    : {
        rules: {
          allow: asList(process.env.LARKX_ALLOW ?? ''),
          deny: asList(process.env.LARKX_DENY ?? ''),
        },
        source: 'global rules (LARKX_ALLOW / LARKX_DENY)',
        own: false,
      };
  validate(eff.rules, eff.source);
  return eff;
}

/** Set the account's own rules (clears them when `rules` is null). */
export function saveAccountRules(auth: LarkAuth, rules: Rules | null): void {
  if (!auth.userId)
    throw new Error('no user_id in credentials; log in before setting per-account rules');
  if (rules) validate(rules, 'the rules to save');
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
    source === true ? loadRules(auth) : { rules: source, source: 'the supplied rules' };
  const v = decide(eff.rules, p);
  if (!v.allowed) throw new PermissionDenied(p, v.rule as string, eff.source);
}

/** When enabling, validate the rules once so misconfiguration fails early. */
export function checkSource(auth: LarkAuth, source: PermissionSource): void {
  if (source === true) loadRules(auth);
  else validate(source, 'the supplied rules');
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
