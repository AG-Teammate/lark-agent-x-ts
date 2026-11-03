import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentBackend, ClaudeCodeBackend, uuid5 } from '../src/agent/backend.js';
import { AgentDispatcher, buildXmlMessage, quoteAttr } from '../src/agent/dispatcher.js';
import type { LarkMessage } from '../src/proto/decoders.js';
import { Storage } from '../src/storage/index.js';

const msg = (over: Partial<LarkMessage> = {}): LarkMessage => ({
  msg_id: 'm1',
  msg_type: 4,
  msg_type_name: 'TEXT',
  from_id: 'u-peer',
  chat_id: 'c1',
  chat_type: 2,
  chat_type_name: 'GROUP',
  scope: 'chat',
  anchor: '',
  at_me: false,
  root_id: '',
  parent_id: '',
  cid: '',
  position: 1,
  create_time: 1_790_000_000,
  content: '月报导出能加个按部门筛选吗',
  content_data: null,
  ...over,
});

const ENV_KEYS = [
  'LARKX_CONTEXT_SCOPE',
  'LARKX_TRIGGER_PREFIX',
  'LARKX_TRIGGER_CHAT_TYPES',
  'LARKX_TRIGGER_GROUP_AT_ONLY',
  'LARKX_TRIGGER_KEYWORDS',
  'LARKX_TRIGGER_EXCLUDE_CHATS',
  'LARKX_TRIGGER_INCLUDE_TAGS',
  'LARKX_HOME',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

class FakeBackend implements AgentBackend {
  readonly name = 'fake';
  runs: { key: string; prompt: string }[] = [];
  resets: string[] = [];
  release: (() => void) | null = null;
  async run(key: string, prompt: string) {
    this.runs.push({ key, prompt });
    if (this.runs.length === 1) await new Promise<void>((r) => (this.release = r));
    return '';
  }
  async resetSession(key: string) {
    this.resets.push(key);
  }
}

describe('数字人分发', () => {
  test('XML 转义与 quoteattr（对应 xml.sax.saxutils）', () => {
    expect(quoteAttr('a"b')).toBe(`'a"b'`);
    expect(quoteAttr(`a"b'c`)).toBe('"a&quot;b\'c"');
    expect(quoteAttr('x<y>&\n')).toBe('"x&lt;y&gt;&amp;&#10;"');
    const xml = buildXmlMessage({
      ...msg({ at_me: true, content: 'a<b>' }),
      _sender_name: '同事甲',
    });
    expect(xml).toContain('<sender id="u-peer" name="同事甲"/>');
    expect(xml).toContain('<at_me>true</at_me>');
    expect(xml).toContain('<content>a&lt;b&gt;</content>');
    expect(xml).not.toContain('<quote');
  });

  test('回复别人时提示词带上被引用的原文', () => {
    const xml = buildXmlMessage({
      ...msg({ parent_id: 'm0', content: '可以' }),
      _quote: { id: 'm0', sender_id: 'u-me', sender_name: '我', content: '周五前能交 <初稿> 吗' },
    });
    expect(xml).toContain(
      '<quote id="m0" sender_id="u-me" sender_name="我">周五前能交 &lt;初稿&gt; 吗</quote>',
    );
    expect(xml.indexOf('<quote')).toBeLessThan(xml.indexOf('<content>'));
  });

  test('触发规则：自己发的、前缀、会话类型、排除会话、群里只认 @我', () => {
    process.env.LARKX_TRIGGER_PREFIX = '/run';
    process.env.LARKX_TRIGGER_CHAT_TYPES = 'group,p2p';
    process.env.LARKX_TRIGGER_EXCLUDE_CHATS = '["c9"]';
    process.env.LARKX_TRIGGER_GROUP_AT_ONLY = 'true';
    const d = new AgentDispatcher(new FakeBackend(), async () => {});
    expect(d.shouldHandle(msg({ content: '/run 导出', at_me: true }), 'me')).toBe(true);
    expect(d.shouldHandle(msg({ content: '/run 导出', at_me: true, from_id: 'me' }), 'me')).toBe(
      false,
    );
    expect(d.shouldHandle(msg({ content: '导出', at_me: true }), 'me')).toBe(false);
    expect(d.shouldHandle(msg({ content: '/run 导出' }), 'me')).toBe(false);
    expect(d.shouldHandle(msg({ content: '/run 导出', chat_type: 1 }), 'me')).toBe(true);
    expect(d.shouldHandle(msg({ content: '/run 导出', chat_type: 3, at_me: true }), 'me')).toBe(
      false,
    );
    expect(d.shouldHandle(msg({ content: '/run x', chat_id: 'c9', at_me: true }), 'me')).toBe(
      false,
    );
    expect(d.parseCommand('/run /clear 重新来')).toEqual(['clear', '重新来']);
    expect(d.parseCommand('/stop')).toEqual(['stop', '']);
    expect(d.parseCommand('/stopped')).toEqual([null, null]);
  });

  test('同一会话串行排队；/stop 清空排队，/clear 重置会话', async () => {
    process.env.LARKX_CONTEXT_SCOPE = 'anchor';
    const backend = new FakeBackend();
    const replies: [string, string, string | undefined][] = [];
    const d = new AgentDispatcher(backend, async (c, t, r) => void replies.push([c, t, r]));
    await d.submit(msg({ content: '第一条', anchor: 't1' }), '项目协作群', '同事甲', 'me');
    await d.submit(msg({ content: '第二条', anchor: 't1' }), '项目协作群', '同事甲', 'me');
    await d.submit(msg({ content: '第三条', anchor: 't1' }), '项目协作群', '同事甲', 'me');
    expect(backend.runs).toHaveLength(1);
    expect(backend.runs[0]?.key).toBe('c1:t1');
    expect(backend.runs[0]?.prompt).toContain('要回复就执行: lark send c1 "<回复内容>" --root t1');
    await d.submit(msg({ content: '/stop', anchor: 't1' }), '', '', 'me');
    expect(replies).toEqual([['c1', '⏹ 已清空 2 条排队消息', 't1']]);
    await d.submit(msg({ content: '/clear' }), '', '', 'me');
    expect(backend.resets).toEqual(['c1:']);
    expect(replies.at(-1)).toEqual(['c1', '✅ 已开启新会话', undefined]);
    backend.release?.();
    await Bun.sleep(10);
    expect(backend.runs).toHaveLength(1);
  });
});

describe('按会话标签筛选', () => {
  test('设了 LARKX_TRIGGER_INCLUDE_TAGS 时只处理标签里的会话；标签还没解析到时都不处理', () => {
    process.env.LARKX_TRIGGER_INCLUDE_TAGS = '客户';
    const d = new AgentDispatcher(new FakeBackend(), async () => undefined);
    expect(d.shouldHandle(msg({ chat_id: 'c1' }), 'me')).toBe(false);
    d.setTagChats(['c1']);
    expect(d.shouldHandle(msg({ chat_id: 'c1' }), 'me')).toBe(true);
    expect(d.shouldHandle(msg({ chat_id: 'c2' }), 'me')).toBe(false);
  });
});

describe('撤回与编辑', () => {
  test('撤回的排队消息不再处理；编辑过的排队消息换成新内容，已处理过的带 <edited> 重新交给 agent', async () => {
    process.env.LARKX_CONTEXT_SCOPE = 'chat';
    const backend = new FakeBackend();
    const d = new AgentDispatcher(backend, async () => undefined);
    await d.submit(msg({ msg_id: 'm1', content: '周会改到几点' }), '项目协作群', '同事甲', 'me');
    await d.submit(msg({ msg_id: 'm2', content: '发错了' }), '项目协作群', '同事甲', 'me');
    await d.submit(
      msg({ msg_id: 'm3', content: '月报导出要按部门' }),
      '项目协作群',
      '同事甲',
      'me',
    );
    expect(d.withdraw('m2')).toBe(1);
    expect(d.withdraw('m2')).toBe(0);
    await d.revise(
      msg({ msg_id: 'm3', content: '月报导出要按部门和月份' }),
      '项目协作群',
      '同事甲',
      'me',
    );
    await d.revise(
      msg({ msg_id: 'm1', content: '周会改到几点（下周）' }),
      '项目协作群',
      '同事甲',
      'me',
    );
    // Messages edited by oneself do not trigger
    await d.revise(msg({ msg_id: 'm9', from_id: 'me', content: 'x' }), '', '', 'me');
    backend.release?.();
    await Bun.sleep(20);
    const contents = backend.runs.map((r) => /<content>(.*)<\/content>/.exec(r.prompt)?.[1]);
    expect(contents).toEqual(['周会改到几点', '月报导出要按部门和月份', '周会改到几点（下周）']);
    expect(backend.runs[1]?.prompt).not.toContain('<edited>');
    expect(backend.runs[2]?.prompt).toContain('<edited>true</edited>');
  });
});

describe('表情事件交给数字人', () => {
  test('前缀、群里只认 @我 不拦表情事件，排除的会话照常排除；提示词带 <reaction> 与被加表情的原消息', async () => {
    process.env.LARKX_TRIGGER_PREFIX = '/run';
    process.env.LARKX_TRIGGER_GROUP_AT_ONLY = 'true';
    process.env.LARKX_TRIGGER_EXCLUDE_CHATS = 'c9';
    const backend = new FakeBackend();
    backend.release = () => undefined;
    const d = new AgentDispatcher(backend, async () => undefined);
    const ev = { message_id: 'm1', reaction_type: 'THUMBSUP', user_id: 'u-peer', cancelled: false };
    const quote = { id: 'm1', sender_id: 'me', sender_name: '我', content: '要我现在发布吗？' };
    await d.submitReaction(
      ev,
      msg({ msg_id: 'm1', chat_id: 'c9', from_id: 'me' }),
      quote,
      '',
      '同事甲',
      'me',
    );
    expect(backend.runs).toHaveLength(0);
    await d.submitReaction(
      ev,
      msg({ msg_id: 'm1', from_id: 'me' }),
      quote,
      '项目协作群',
      '同事甲',
      'me',
    );
    await Bun.sleep(10);
    expect(backend.runs).toHaveLength(1);
    const prompt = backend.runs[0]?.prompt ?? '';
    expect(prompt).toContain('<sender id="u-peer" name="同事甲"/>');
    expect(prompt).toContain('<reaction type="THUMBSUP" cancelled="false"/>');
    expect(prompt).toContain(
      '<quote id="m1" sender_id="me" sender_name="我">要我现在发布吗？</quote>',
    );
  });
});

describe('Claude Code 后端', () => {
  let dir: string;
  let st: Storage;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'larkx-agent-'));
    process.env.LARKX_HOME = dir;
    st = new Storage(`sqlite:///${join(dir, 'm.db')}`);
  });
  afterEach(async () => {
    await st.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('uuid5 与 Python uuid.uuid5(NAMESPACE_URL, …) 一致', () => {
    const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
    expect(uuid5(NS, 'larkx:7200000000000000001:')).toBe('da879cd2-3ef5-5f06-8442-2e269d217aa0');
    expect(uuid5(NS, 'larkx:global')).toBe('1a18c93e-cc33-5827-8f43-ccb4380898b6');
  });

  test('首次 --session-id 建立，之后 --resume 续上；提示词走 stdin；非零退出不算建立', async () => {
    const log = join(dir, 'calls.log');
    const fake = join(dir, 'fake-claude');
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> ${log}\ncat >> ${log}\necho >> ${log}\n[ "$FAIL" = 1 ] && exit 3\necho ok\n`,
    );
    chmodSync(fake, 0o755);
    const backend = new ClaudeCodeBackend(st, fake);
    process.env.FAIL = '1';
    expect(await backend.run('c1:', '第一条', 'c1', '')).toBe('');
    expect((await st.sessionGet('c1:'))?.started).toBe(0);
    process.env.FAIL = '';
    expect(await backend.run('c1:', '第二条', 'c1', '')).toBe('ok');
    expect(await backend.run('c1:', '第三条', 'c1', '')).toBe('ok');
    const sid = uuid5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'larkx:c1:');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(`--session-id ${sid}\n第一条`);
    expect(calls).toContain(`--session-id ${sid}\n第二条`);
    expect(calls).toContain(`--resume ${sid}\n第三条`);
    expect(await st.sessionGet('c1:')).toMatchObject({ started: 1, msg_count: 2 });
    await backend.resetSession('c1:');
    const fresh = await st.sessionGet('c1:');
    expect(fresh?.started).toBe(0);
    expect(fresh?.agent_session_id).not.toBe(sid);
  });

  test('找不到 claude 命令时返回空串而不是抛错', async () => {
    const backend = new ClaudeCodeBackend(st, join(dir, 'no-such-claude'));
    expect(await backend.run('k', 'x')).toBe('');
  });

  test('旧版 agent_sessions.json 迁移进 session 表并改名留档', async () => {
    writeFileSync(
      join(dir, 'agent_sessions.json'),
      JSON.stringify({ global: { id: 'g', started: true }, 'c1:t1': { id: 's1' } }),
    );
    await new ClaudeCodeBackend(st).migrateJsonSessions();
    expect(await st.sessionGet('global')).toMatchObject({
      chat_id: 'global',
      anchor: '',
      started: 1,
    });
    expect(await st.sessionGet('c1:t1')).toMatchObject({ chat_id: 'c1', anchor: 't1', started: 0 });
    expect(readFileSync(join(dir, 'agent_sessions.json.migrated'), 'utf8')).toContain('global');
  });
});
