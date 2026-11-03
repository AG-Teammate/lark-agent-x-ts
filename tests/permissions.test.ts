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

describe('权限目录', () => {
  test('每个权限项都对应一个命令，分组名不和命令名重名', () => {
    const names = new Set(COMMANDS.map((c) => c.name));
    for (const p of Object.keys(PERMISSIONS))
      expect(names.has(p.split('.')[0] as string)).toBe(true);
    for (const g of Object.keys(GROUPS)) expect(names.has(g)).toBe(false);
  });

  test('读写混用的命令按参数取到不同的项', () => {
    expect(permissionFor('scheduled', ['c1'])).toBe('scheduled.list');
    expect(permissionFor('scheduled', ['c1', '--cancel', 'm1'])).toBe('scheduled.cancel');
    expect(permissionFor('shortcut', [])).toBe('shortcut.list');
    expect(permissionFor('shortcut', ['c1,c2', '--remove'])).toBe('shortcut.remove');
    expect(permissionFor('auth', ['qr'])).toBe('auth.qr');
    expect(permissionFor('group', ['add', 'c1', 'u1'])).toBe('group.add');
    expect(permissionFor('permissions', [])).toBe('permissions.show');
    expect(permissionFor('send-image', ['c1', 'a.png'])).toBe('send-image');
  });

  test('越具体的规则越优先，同一级 deny 优先，都没命中则允许', () => {
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

  test('全局规则来自环境变量；账号有自己的规则时整体替代全局规则', () => {
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

  test('规则里有不认识的名字或权限文件损坏时报错，不放行', () => {
    process.env.LARKX_DENY = 'outbund';
    expect(() => loadRules(fakeAuth())).toThrow('不认识的名字: outbund');
    delete process.env.LARKX_DENY;
    expect(() => saveAccountRules(fakeAuth(), { allow: ['sned'], deny: [] })).toThrow('sned');
    writeFileSync(join(home, 'permissions.json'), '{');
    expect(() => loadRules(fakeAuth())).toThrow('读取权限文件');
    writeFileSync(join(home, 'permissions.json'), '[]');
    expect(() => loadRules(fakeAuth())).toThrow('权限文件');
  });
});

describe('库的权限检查', () => {
  test('只检查最外层调用；传入的回调在检查范围之外执行', async () => {
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
      if (p === 'get') throw new PermissionDenied(p, 'deny get', '传入的规则');
    });
    expect(await obj.outer()).toBe('ok');
    expect(checked).toEqual(['listen']);
    await expect(obj.inner()).rejects.toBeInstanceOf(PermissionDenied);
    await expect(obj.outer(() => obj.inner())).rejects.toThrow('deny get');
    // Concurrent outer calls are each checked
    await Promise.all([obj.outer(), obj.outer()]);
    expect(checked.filter((p) => p === 'listen')).toHaveLength(4);
  });

  test('客户端：不传 permissions 时不检查；传了时被拒绝的方法抛 PermissionDenied', async () => {
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
      ).rejects.toThrow('不认识的名字: x');
    } finally {
      api.mockRestore();
    }
  });

  test('客户端：permissions 为 true 时按账号规则检查，改了规则立即生效', async () => {
    const api = spyOn(LarkClient.prototype, 'api').mockImplementation(async () => ({}));
    try {
      const c = await LarkClient.create(fakeAuth(), { permissions: true });
      expect(await c.scheduledMessages('c1')).toEqual([]);
      saveAccountRules(fakeAuth(), { allow: [], deny: ['scheduled'] });
      await expect(c.scheduledMessages('c1')).rejects.toThrow('deny scheduled');
      // Sends map to send / send-image / send-file by content; a denial throws before any network call
      saveAccountRules(fakeAuth(), { allow: [], deny: ['outbound'] });
      await expect(c.sendMessage('c1', { file: new Uint8Array(), name: 'a.txt' })).rejects.toThrow(
        '权限不允许执行 send-file(分组 outbound)',
      );
      await expect(c.sendMessage('c1', { image: new Uint8Array() })).rejects.toThrow('send-image');
      await expect(c.sendMsg('你好', 'c1')).rejects.toThrow('权限不允许执行 send(');
    } finally {
      api.mockRestore();
    }
  });
});

describe('命令行的权限检查', () => {
  test('被拒绝时退出码 126 并说明规则，帮助不受影响；账号规则替代全局规则', () => {
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
    expect(denied.stderr.toString()).toContain('权限不允许执行 config(分组 local)');
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
    expect(edit.stderr.toString()).toContain('需要在终端里运行');
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

describe('权限编辑器', () => {
  test('分组折叠展开、逐项切换，结果实时反映生效规则', () => {
    const ed = new PermissionEditor({ allow: [], deny: ['outbound'] }, '标题');
    expect(ed.rows().map((r) => r.key)).toEqual(['*', ...Object.keys(GROUPS)]);
    expect(line(ed, 'outbound')).toMatch(/outbound\s+拒绝 {2}→ 拒绝/);

    press(ed, 'down', 'down', 'down', 'right'); // move cursor to outbound and expand
    expect(ed.rows().some((r) => r.key === 'send')).toBe(true);
    expect(line(ed, 'send')).toMatch(/send\s+继承 {2}→ 拒绝 {2}由 deny outbound 决定/);

    press(ed, 'down', 'a'); // allow send individually
    expect(ed.rules()).toEqual({ allow: ['send'], deny: ['outbound'] });
    expect(line(ed, 'send')).toMatch(/send\s+允许 {2}→ 允许/);
    press(ed, 'space'); // allow → deny
    expect(ed.rules()).toEqual({ allow: [], deny: ['outbound', 'send'] });
    press(ed, 'space'); // deny → inherit
    expect(ed.rules()).toEqual({ allow: [], deny: ['outbound'] });

    press(ed, 'left'); // collapse on a child; cursor returns to the group
    expect(ed.rows()[ed.cursor]?.key).toBe('outbound');
    press(ed, 'i');
    expect(ed.rules().deny).toEqual([]);
    expect(line(ed, '*')).toMatch(/\*\s+继承 {2}→ 允许/);
  });

  test('树里没有的规则原样保留；有修改时退出要确认', () => {
    const ed = new PermissionEditor({ allow: [], deny: ['scheduled'] }, '标题', '说明');
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

  test('列表放不下时随光标滚动，行数不超过终端高度', () => {
    const ed = new PermissionEditor({ allow: [], deny: [] }, '标题');
    press(ed, 'down', 'right', 'down', 'down', 'right');
    for (let i = 0; i < ed.rows().length; i++) press(ed, 'down');
    const screen = plain(ed.render(60, 12));
    expect(screen.length).toBeLessThanOrEqual(12);
    expect(screen.some((l) => l.startsWith('› '))).toBe(true);
  });
});
