import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand paths starting with `~` to the user's home directory. */
export function expandUser(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/** Data directory (credentials, message DB, QR code): `LARKX_HOME`, default `~/.larkx`. Reads the env var on every call so tests can switch it. */
export function dataDir(): string {
  return expandUser(process.env.LARKX_HOME || join(homedir(), '.larkx'));
}

export const credentialsPath = (): string => join(dataDir(), 'credentials.json');
export const dbDefaultPath = (): string => join(dataDir(), 'messages.db');

export interface Triggers {
  prefix: string;
  chat_types: string[];
  include_chats: string[];
  exclude_chats: string[];
  include_senders: string[];
  /** Only handle chats in these chat tags (name or id). */
  include_tags: string[];
  keywords: string[];
  group_at_only: boolean;
}

export interface Config {
  region: string;
  storage_url: string;
  /** Agent context boundary: anchor (chat + thread) | chat (chat) | global (all shared). */
  context_scope: string;
  agent_backend: string;
  system_prompt: string;
  /** Mark messages as read on receipt. */
  mark_read: boolean;
  /** Hand others' reactions added / removed on my messages to the digital twin (e.g. treat a thumbs-up as approval to proceed); off by default. */
  agent_reactions: boolean;
  triggers: Triggers;
}

const TRIGGER_ENV: Record<keyof Triggers, string> = {
  prefix: 'LARKX_TRIGGER_PREFIX',
  chat_types: 'LARKX_TRIGGER_CHAT_TYPES',
  include_chats: 'LARKX_TRIGGER_INCLUDE_CHATS',
  exclude_chats: 'LARKX_TRIGGER_EXCLUDE_CHATS',
  include_senders: 'LARKX_TRIGGER_INCLUDE_SENDERS',
  include_tags: 'LARKX_TRIGGER_INCLUDE_TAGS',
  keywords: 'LARKX_TRIGGER_KEYWORDS',
  group_at_only: 'LARKX_TRIGGER_GROUP_AT_ONLY',
};

/** Comma-separated or a JSON array. */
export function asList(v: string): string[] {
  const s = v.trim();
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export const asBool = (v: string): boolean =>
  ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

/**
 * Effective config: defaults overridden by `LARKX_*` environment variables (empty string counts as unset). Bun auto-loads `.env` from the current directory at startup.
 */
export function loadConfig(): Config {
  const env = (key: string) => process.env[`LARKX_${key.toUpperCase()}`] || undefined;
  const markRead = env('mark_read');
  const triggers: Triggers = {
    prefix: '',
    chat_types: [],
    include_chats: [],
    exclude_chats: [],
    include_senders: [],
    include_tags: [],
    keywords: [],
    group_at_only: false,
  };
  for (const [key, name] of Object.entries(TRIGGER_ENV) as [keyof Triggers, string][]) {
    const v = process.env[name];
    if (v === undefined) continue;
    if (key === 'group_at_only') triggers.group_at_only = asBool(v);
    else if (key === 'prefix') triggers.prefix = v;
    else triggers[key] = asList(v);
  }
  return {
    region: env('region') ?? 'feishu',
    storage_url: env('storage_url') ?? `sqlite:///${dbDefaultPath()}`,
    context_scope: env('context_scope') ?? 'anchor',
    agent_backend: env('agent_backend') ?? 'claude',
    system_prompt: env('system_prompt') ?? '',
    mark_read: markRead === undefined ? true : asBool(markRead),
    agent_reactions: asBool(env('agent_reactions') ?? ''),
    triggers,
  };
}
