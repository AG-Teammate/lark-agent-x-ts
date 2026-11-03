import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import type { LarkMessage } from '../src/proto/decoders.js';
import { nowStamp, parseStorageUrl, Storage } from '../src/storage/index.js';

const msg = (over: Partial<LarkMessage> = {}): LarkMessage => ({
  msg_id: '7000000000000000001',
  msg_type: 4,
  msg_type_name: 'TEXT',
  from_id: '7100000000000000001',
  chat_id: '7200000000000000001',
  chat_type: 2,
  chat_type_name: 'GROUP',
  scope: 'chat',
  anchor: '',
  at_me: false,
  root_id: '',
  parent_id: '',
  cid: '',
  position: 5,
  create_time: 1_790_000_000,
  content: '月报导出能加个按部门筛选吗',
  content_data: { text: 'x', richText: { elementIds: ['1'] }, raw: new Uint8Array(3) },
  ...over,
});

test('连接串沿用 SQLAlchemy 写法', () => {
  expect(parseStorageUrl('sqlite:////abs/x.db')).toEqual({
    dialect: 'sqlite',
    url: 'sqlite:///abs/x.db',
  });
  expect(parseStorageUrl('mysql+pymysql://u:p@h:3306/db')).toEqual({
    dialect: 'mysql',
    url: 'mysql://u:p@h:3306/db',
  });
  expect(() => parseStorageUrl('postgres://x')).toThrow('不支持的存储连接串');
});

test('时间戳格式与 SQLAlchemy 一致', () => {
  expect(nowStamp(new Date(2026, 9, 13, 1, 2, 3, 45))).toBe('2026-10-13 01:02:03.045000');
});

// MySQL needs a writable empty database, e.g.:
//   docker run -d --rm -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=larkx -p 33306:3306 mysql:8.4
//   LARKX_TEST_MYSQL_URL=mysql+pymysql://root:test@127.0.0.1:33306/larkx bun test
type Env = { url: string; cleanup: () => Promise<void> };
const backends: Array<[string, () => Promise<Env>]> = [
  [
    'SQLite',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'larkx-st-'));
      return {
        url: `sqlite:///${join(dir, 'm.db')}`,
        cleanup: async () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  ],
];
const MYSQL_URL = process.env.LARKX_TEST_MYSQL_URL;
if (MYSQL_URL) {
  backends.push([
    'MySQL',
    async () => {
      const admin = new SQL(parseStorageUrl(MYSQL_URL).url);
      for (const t of ['messages', 'chats', 'agent_sessions'])
        await admin.unsafe(`DROP TABLE IF EXISTS ${t}`);
      await admin.close();
      return { url: MYSQL_URL, cleanup: async () => {} };
    },
  ]);
}

for (const [name, setup] of backends) {
  describe(`Storage（${name}）`, () => {
    let st: Storage;
    let env: Env;
    beforeEach(async () => {
      env = await setup();
      st = new Storage(env.url);
    });
    afterEach(async () => {
      await st.close();
      await env.cleanup();
    });

    test('入库：content_data 按 Python 格式序列化，字节换成占位；会话记下名字与最新 position', async () => {
      expect(await st.saveMessage(msg(), { senderName: '同事甲', chatName: '项目协作群' })).toBe(
        true,
      );
      const [row] = await st.getMessages('7200000000000000001');
      expect(row).toMatchObject({
        msg_id: '7000000000000000001',
        sender_name: '同事甲',
        position: 5,
        direction: 'in',
      });
      expect(row?.content_data).toBe(
        '{"text": "x", "richText": {"elementIds": ["1"]}, "raw": "<3 bytes>"}',
      );
      expect(row?.create_time).toBe(1_790_000_000);
      expect(row?.stored_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{6})?$/);
      const [chat] = await st.listChats();
      expect(chat).toMatchObject({
        chat_id: '7200000000000000001',
        name: '项目协作群',
        chat_type: 2,
        last_position: 5,
      });
    });

    test('重复消息不再入库；先落库没有 position 的记录由回显补全并视作首次入库', async () => {
      expect(await st.saveMessage(msg({ position: null }), { direction: 'out' })).toBe(true);
      expect(await st.saveMessage(msg({ position: null }))).toBe(false);
      expect(
        await st.saveMessage(msg({ position: 9, content: '回显' }), { direction: 'out' }),
      ).toBe(true);
      expect(await st.saveMessage(msg({ position: 9 }))).toBe(false);
      const rows = await st.getMessages('7200000000000000001');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ position: 9, content: '回显' });
      expect((await st.listChats())[0]?.last_position).toBe(9);
    });

    test('按话题筛选、按时间倒序取最近 N 条后升序返回', async () => {
      for (let i = 1; i <= 4; i++)
        await st.saveMessage(
          msg({ msg_id: `m${i}`, create_time: 1000 + i, anchor: i % 2 ? 't1' : '', position: i }),
        );
      const ids = (rows: { msg_id: string }[]) => rows.map((r) => r.msg_id);
      expect(ids(await st.getMessages('7200000000000000001', { limit: 2 }))).toEqual(['m3', 'm4']);
      expect(ids(await st.getMessages('7200000000000000001', { anchor: 't1' }))).toEqual([
        'm1',
        'm3',
      ]);
      expect(ids(await st.getMessages('7200000000000000001', { anchor: '' }))).toEqual([
        'm2',
        'm4',
      ]);
      expect((await st.getMessage('m2'))?.msg_id).toBe('m2');
      expect(await st.getMessage('m9')).toBeUndefined();
      expect(ids(await st.findMessages('m3'))).toEqual(['m3']);
    });

    test('补收用的本地进度：会话最大 position（没有记录为 -1）与最近活跃的话题', async () => {
      expect(await st.lastPosition('7200000000000000001')).toBe(-1);
      await st.saveMessage(msg({ msg_id: 'm1', position: 7 }));
      await st.saveMessage(
        msg({ msg_id: 'm2', scope: 'topic', anchor: 'r1', position: -3, create_time: 1003 }),
      );
      await st.saveMessage(
        msg({ msg_id: 'm3', scope: 'topic', anchor: 'r2', position: -3, create_time: 1005 }),
      );
      await st.saveMessage(
        msg({ msg_id: 'm4', scope: 'topic', anchor: 'r1', position: -3, create_time: 1001 }),
      );
      expect(await st.lastPosition('7200000000000000001')).toBe(7);
      expect(await st.recentAnchors('7200000000000000001')).toEqual(['r2', 'r1']);
      expect(await st.recentAnchors('7200000000000000001', 1)).toEqual(['r2']);
    });

    test('撤回与编辑：只更新本地已有的消息', async () => {
      await st.saveMessage(msg({ msg_id: 'm1' }));
      await st.saveMessage(msg({ msg_id: 'm2' }));
      expect(await st.markRecalled('m1', '7200000000000000001')).toBe(true);
      expect(await st.markRecalled('m1', '7200000000000000001')).toBe(false);
      expect(await st.markRecalled('m9', '7200000000000000001')).toBe(false);
      const edited = msg({
        msg_id: 'm2',
        content: '月报导出能按部门和月份筛选吗',
        content_data: { text: 'y' },
      });
      expect(await st.reviseMessage(edited)).toBe(true);
      expect(await st.reviseMessage(edited)).toBe(false);
      expect(await st.reviseMessage(msg({ msg_id: 'm9' }))).toBe(false);
      const rows = await st.getMessages('7200000000000000001');
      expect(
        rows
          .map((r) => [r.msg_id, r.content, r.content_data])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ['m1', '[已撤回]', ''],
        ['m2', '月报导出能按部门和月份筛选吗', '{"text": "y"}'],
      ]);
    });

    test('会话名与 agent 会话', async () => {
      await st.updateChatName('c1', '群一', 2);
      await st.updateChatName('c1', '群一改名', 2);
      expect(await st.getChatName('c1')).toBe('群一改名');
      await st.sessionUpsert('c1:', 'c1', '', 'sid-1', false);
      await st.sessionTouch('c1:');
      await st.sessionUpsert('c1:', 'c1', '', 'sid-1', true);
      expect(await st.sessionGet('c1:')).toMatchObject({
        agent_session_id: 'sid-1',
        started: 1,
        msg_count: 1,
      });
      expect((await st.listSessions()).map((s) => s.session_key)).toEqual(['c1:']);
      expect((await st.listChats())[0]?.updated_at).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{6})?$/,
      );
    });
  });
}
