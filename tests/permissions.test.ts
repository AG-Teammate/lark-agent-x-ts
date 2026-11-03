import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { LarkAuth } from '../src/auth.js';
import { parse } from '../src/cli/args.js';
import { COMMANDS } from '../src/cli/commands.js';
import { PermissionEditor } from '../src/cli/permissions-editor.js';
import { LarkClient } from '../src/client.js';
import {
  decide,
  GROUPS,
  guardMethods,
  loadRules,
  PERMISSIONS,
  type Permission,
  PermissionDenied,
  saveAccountRules,
} from '../src/permissions.js';

const ME = '7000000000000000001';
const KEYS = ['LARKX_HOME', 'LARKX_ALLOW', 'LARKX_DENY'];
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'larkx-perm-'));
  process.env.LARKX_HOME = home;
  delete process.env.LARKX_ALLOW;
  delete process.env.LARKX_DENY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Offline credentials: permissions only use user_id and the credentials path; create only calls requireValid. */
const fakeAuth = (userId = ME) =>
  ({
    userId,
    appKey: 'app',
    path: join(home, 'credentials.json'),
    requireValid: async () => {},
  }) as unknown as LarkAuth;

const cmd = (name: string) => COMMANDS.find((c) => c.name === name) as (typeof COMMANDS)[number];
const permissionFor = (name: string, argv: string[]): Permission => {
  const { access } = cmd(name);
  return typeof access === 'string' ? access : access(parse('lark', cmd(name), argv));
};

describe('permission catalog', () => {
  test('every permission maps to a command, and group names never clash with command names', () => {
    const names = new Set(COMMANDS.map((c) => c.name));
    for (const p of Object.keys(PERMISSIONS))
      expect(names.has(p.split('.')[0] as string)).toBe(true);
    for (const g of Object.keys(GROUPS)) expect(names.has(g)).toBe(false);
  });

  test('commands mixing reads and writes map to different permissions by argument', () => {
    expect(permissionFor('scheduled', ['c1'])).toBe('scheduled.list');
    expect(permissionFor('scheduled', ['c1', '--cancel', 'm1'])).toBe('scheduled.cancel');
    expect(permissionFor('shortcut', [])).toBe('shortcut.list');
    expect(permissionFor('shortcut', ['c1,c2', '--remove'])).toBe('shortcut.remove');
    expect(permissionFor('auth', ['qr'])).toBe('auth.qr');
    expect(permissionFor('group', ['add', 'c1', 'u1'])).toBe('group.add');
    expect(permissionFor('permissions', [])).toBe('permissions.show');
    expect(permissionFor('send-image', ['c1', 'a.png'])).toBe('send-image');
  });

  test('more specific rules win, deny wins at the same level, and no match means allowed', () => {
    expect(decide({ allow: [], deny: [] }, 'send')).toEqual({ allowed: true });
    expect(decide({ allow: ['send'], deny: ['*'] }, 'send')).toEqual({
      allowed: true,
      rule: 'allow send',
    });
    expect(decide({ allow: ['send'], deny: ['outbound'] }, 'forward').allowed).toBe(false);
    expect(decide({ allow: ['manage'], deny: ['group.add'] }, 'group.add')).toEqual({
      allowed: false,
      rule: 'deny group.add',
    });
    expect(decide({ allow: ['group.add'], deny: ['group'] }, 'group.add').allowed).toBe(true);
    expect(decide({ allow: [], deny: ['group'] }, 'group.rename').rule).toBe('deny group');
    expect(decide({ allow: ['outbound'], deny: ['outbound'] }, 'send').allowed).toBe(false);
  });

  test('chats: the local list is local-only, the remote list is a query; a rule on chats covers both', () => {
    expect(permissionFor('chats', [])).toBe('chats.local');
    expect(permissionFor('chats', ['--remote'])).toBe('chats.remote');
    expect(decide({ allow: [], deny: ['query'] }, 'chats.local').allowed).toBe(true);
    expect(decide({ allow: [], deny: ['query'] }, 'chats.remote').allowed).toBe(false);
    expect(decide({ allow: [], deny: ['chats'] }, 'chats.local').rule).toBe('deny chats');
    expect(decide({ allow: ['chats'], deny: ['query'] }, 'chats.remote').allowed).toBe(true);
  });

  test("global rules come from the environment; an account's own rules replace them entirely", () => {
    process.env.LARKX_DENY = 'outbound, manage';
    process.env.LARKX_ALLOW = '["send"]';
    expect(loadRules(fakeAuth()).rules).toEqual({ allow: ['send'], deny: ['outbound', 'manage'] });

    saveAccountRules(fakeAuth(), { allow: ['query'], deny: ['*'] });
    expect(loadRules(fakeAuth())).toMatchObject({
      rules: { allow: ['query'], deny: ['*'] },
      own: true,
    });
    expect(loadRules(fakeAuth('7000000000000000002')).rules.deny).toEqual(['outbound', 'manage']);
    expect(loadRules(fakeAuth('')).rules.allow).toEqual(['send']);

    saveAccountRules(fakeAuth(), null);
    expect(JSON.parse(readFileSync(join(home, 'permissions.json'), 'utf8'))).toEqual({});
    expect(loadRules(fakeAuth()).own).toBe(false);
  });

  test('unknown names in rules or a corrupt permissions file raise an error instead of allowing', () => {
    process.env.LARKX_DENY = 'outbund';
    expect(() => loadRules(fakeAuth())).toThrow(
      'unknown names in global rules (LARKX_ALLOW / LARKX_DENY): outbund (',
    );
    delete process.env.LARKX_DENY;
    expect(() => saveAccountRules(fakeAuth(), { allow: ['sned'], deny: [] })).toThrow('sned');
    writeFileSync(join(home, 'permissions.json'), '{');
    expect(() => loadRules(fakeAuth())).toThrow('failed to read permissions file ');
    writeFileSync(join(home, 'permissions.json'), '[]');
    expect(() => loadRules(fakeAuth())).toThrow(
      /^permissions file .* must be an object mapping user_id/,
    );
  });
});

describe('library permission checks', () => {
  test('only the outermost call is checked; callbacks passed in run outside the check', async () => {
    const checked: Permission[] = [];
    const obj = {
      async outer(cb?: () => Promise<unknown>) {
        await this.inner();
        return cb ? cb() : 'ok';
      },
      async inner() {
        return 1;
      },
    };
    guardMethods(obj, { outer: 'listen', inner: 'get' }, (p) => {
      checked.push(p);
      if (p === 'get') throw new PermissionDenied(p, 'deny get', 'the supplied rules');
    });
    expect(await obj.outer()).toBe('ok');
    expect(checked).toEqual(['listen']);
    await expect(obj.inner()).rejects.toBeInstanceOf(PermissionDenied);
    await expect(obj.outer(() => obj.inner())).rejects.toThrow('deny get');
    // Concurrent outer calls are each checked
    await Promise.all([obj.outer(), obj.outer()]);
    expect(checked.filter((p) => p === 'listen')).toHaveLength(4);
  });

  test('client: no checks without permissions; with them, denied methods throw PermissionDenied', async () => {
    const api = spyOn(LarkClient.prototype, 'api').mockImplementation(async () => ({}));
    try {
      process.env.LARKX_DENY = '*';
      const open = await LarkClient.create(fakeAuth());
      expect(await open.scheduledMessages('c1')).toEqual([]);

      const c = await LarkClient.create(fakeAuth(), { permissions: { allow: [], deny: ['api'] } });
      expect(await c.scheduledMessages('c1')).toEqual([]); // internal gateway calls are not subject to the api rule
      const err = await c.api('x').catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDenied);
      expect(err).toMatchObject({ permission: 'api', group: 'system', rule: 'deny api' });

      await expect(
        LarkClient.create(fakeAuth(), { permissions: { allow: ['x'], deny: [] } }),
      ).rejects.toThrow('unknown names in the supplied rules: x (');
    } finally {
      api.mockRestore();
    }
  });

  test('client: permissions true checks account rules, and rule changes apply immediately', async () => {
    const api = spyOn(LarkClient.prototype, 'api').mockImplementation(async () => ({}));
    try {
      const c = await LarkClient.create(fakeAuth(), { permissions: true });
      expect(await c.scheduledMessages('c1')).toEqual([]);
      saveAccountRules(fakeAuth(), { allow: [], deny: ['scheduled'] });
      await expect(c.scheduledMessages('c1')).rejects.toThrow('deny scheduled');
      // Sends map to send / send-image / send-file by content; a denial throws before any network call
      saveAccountRules(fakeAuth(), { allow: [], deny: ['outbound'] });
      await expect(c.sendMessage('c1', { file: new Uint8Array(), name: 'a.txt' })).rejects.toThrow(
        'permission denied: send-file (group outbound) by rule deny outbound in rules for account ',
      );
      await expect(c.sendMessage('c1', { image: new Uint8Array() })).rejects.toThrow('send-image');
      await expect(c.sendMsg('hello', 'c1')).rejects.toThrow('permission denied: send (');
    } finally {
      api.mockRestore();
    }
  });
});

describe('CLI permission checks', () => {
  test('denial exits 126 and names the rule, help is unaffected; account rules replace global rules', () => {
    const main = join(import.meta.dir, '../src/cli/main.ts');
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      LARKX_HOME: home,
    };
    const run = (argv: string[], extra: Record<string, string> = {}) =>
      Bun.spawnSync(['bun', main, ...argv], { cwd: home, env: { ...env, ...extra } });

    const denied = run(['config'], { LARKX_DENY: 'local' });
    expect(denied.exitCode).toBe(126);
    expect(denied.stderr.toString()).toContain(
      'lark config: permission denied: config (group local) by rule deny local in global rules (LARKX_ALLOW / LARKX_DENY)',
    );
    expect(denied.stderr.toString()).toContain('deny local');
    expect(run(['config', '-h'], { LARKX_DENY: 'local' }).exitCode).toBe(0);
    expect(run(['config']).exitCode).toBe(0);
    expect(run(['config'], { LARKX_DENY: 'nope' }).exitCode).toBe(1);

    writeFileSync(join(home, 'credentials.json'), JSON.stringify({ user_id: ME, cookies: {} }));
    saveAccountRules(fakeAuth(), { allow: [], deny: ['config'] });
    expect(run(['config']).exitCode).toBe(126);
    expect(run(['chats'], { LARKX_DENY: 'chats' }).exitCode).toBe(0);
    const edit = run(['permissions', 'edit']);
    expect(edit.exitCode).toBe(2);
    expect(edit.stderr.toString()).toContain('permissions edit must run in a terminal');
    expect(run(['permissions', 'clear']).exitCode).toBe(0);
    expect(run(['config']).exitCode).toBe(0);
  });
});

const plain = (lines: string[]) => lines.map(stripVTControlCharacters);
const press = (ed: PermissionEditor, ...names: string[]) =>
  names.map((name) => ed.handle({ name }));
const line = (ed: PermissionEditor, key: string) =>
  plain(ed.render(200, 100)).find((l) =>
    l
      .slice(2)
      .trimStart()
      .replace(/^[▸▾] /, '')
      .startsWith(`${key} `),
  ) ?? '';

describe('permission editor', () => {
  test('groups collapse/expand, items toggle, and results reflect the effective rules live', () => {
    const ed = new PermissionEditor({ allow: [], deny: ['outbound'] }, 'Title');
    expect(ed.rows().map((r) => r.key)).toEqual(['*', ...Object.keys(GROUPS)]);
    expect(line(ed, 'outbound')).toMatch(/outbound\s+deny {5}→ deny /);

    press(ed, 'down', 'down', 'down', 'right'); // move cursor to outbound and expand
    expect(ed.rows().some((r) => r.key === 'send')).toBe(true);
    expect(line(ed, 'send')).toMatch(/send\s+inherit {2}→ deny {3}decided by deny outbound/);

    press(ed, 'down', 'a'); // allow send individually
    expect(ed.rules()).toEqual({ allow: ['send'], deny: ['outbound'] });
    expect(line(ed, 'send')).toMatch(/send\s+allow {4}→ allow/);
    press(ed, 'space'); // allow → deny
    expect(ed.rules()).toEqual({ allow: [], deny: ['outbound', 'send'] });
    press(ed, 'space'); // deny → inherit
    expect(ed.rules()).toEqual({ allow: [], deny: ['outbound'] });

    press(ed, 'left'); // collapse on a child; cursor returns to the group
    expect(ed.rows()[ed.cursor]?.key).toBe('outbound');
    press(ed, 'i');
    expect(ed.rules().deny).toEqual([]);
    expect(line(ed, '*')).toMatch(/\*\s+inherit {2}→ allow/);
  });

  test('rules not in the tree are kept as-is; quitting with changes asks for confirmation', () => {
    const ed = new PermissionEditor({ allow: [], deny: ['scheduled'] }, 'Title', 'Note');
    expect(plain(ed.render(200, 100)).join('\n')).toContain('deny scheduled');
    expect(press(ed, 'q')).toEqual(['quit']); // unchanged, so quit directly

    press(ed, 'd'); // cursor is on *
    expect(ed.rules().deny).toEqual(['scheduled', '*']);
    expect(press(ed, 'q')).toEqual([undefined]);
    expect(ed.confirming).toBe(true);
    expect(press(ed, 'x')).toEqual([undefined]); // other keys return "continue editing"
    expect(press(ed, 'escape', 's')).toEqual([undefined, 'save']);
    expect(ed.handle({ name: 'c', ctrl: true })).toBe('quit');
  });

  test('scrolls with the cursor when the list does not fit, never exceeding the terminal height', () => {
    const ed = new PermissionEditor({ allow: [], deny: [] }, 'Title');
    press(ed, 'down', 'right', 'down', 'down', 'right');
    for (let i = 0; i < ed.rows().length; i++) press(ed, 'down');
    const screen = plain(ed.render(60, 12));
    expect(screen.length).toBeLessThanOrEqual(12);
    expect(screen.some((l) => l.startsWith('› '))).toBe(true);
    // Item rows (the ones with a result arrow) stay within the terminal width, notes clipped to fit
    const rows = screen.filter((l) => l.includes(' → '));
    expect(rows.length).toBeGreaterThan(0);
    for (const l of rows) expect(l.length).toBeLessThan(60);
  });
});
