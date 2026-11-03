import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import type { LarkMessage } from '../src/proto/decoders.js';
import {
  LEGACY_RECALLED,
  nowStamp,
  parseStorageUrl,
  RECALLED,
  Storage,
} from '../src/storage/index.js';

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
  content: 'Can the monthly report export filter by department?',
  content_data: { text: 'x', richText: { elementIds: ['1'] }, raw: new Uint8Array(3) },
  ...over,
});

test('connection strings use SQLAlchemy syntax', () => {
  expect(parseStorageUrl('sqlite:////abs/x.db')).toEqual({
    dialect: 'sqlite',
    url: 'sqlite:///abs/x.db',
  });
  expect(parseStorageUrl('mysql+pymysql://u:p@h:3306/db')).toEqual({
    dialect: 'mysql',
    url: 'mysql://u:p@h:3306/db',
  });
  expect(() => parseStorageUrl('postgres://x')).toThrow('unsupported storage URL: postgres://x');
});

test('timestamp format matches SQLAlchemy', () => {
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
  describe(`Storage (${name})`, () => {
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

    test('save: content_data serialized Python-style with bytes replaced by placeholders; chat records name and latest position', async () => {
      expect(
        await st.saveMessage(msg(), { senderName: 'Colleague A', chatName: 'Project team' }),
      ).toBe(true);
      const [row] = await st.getMessages('7200000000000000001');
      expect(row).toMatchObject({
        msg_id: '7000000000000000001',
        sender_name: 'Colleague A',
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
        name: 'Project team',
        chat_type: 2,
        last_position: 5,
      });
    });

    test('duplicates are not saved again; a row saved without position is completed by the echo and counts as a first save', async () => {
      expect(await st.saveMessage(msg({ position: null }), { direction: 'out' })).toBe(true);
      expect(await st.saveMessage(msg({ position: null }))).toBe(false);
      expect(
        await st.saveMessage(msg({ position: 9, content: 'echo' }), { direction: 'out' }),
      ).toBe(true);
      expect(await st.saveMessage(msg({ position: 9 }))).toBe(false);
      const rows = await st.getMessages('7200000000000000001');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ position: 9, content: 'echo' });
      expect((await st.listChats())[0]?.last_position).toBe(9);
    });

    test('filter by topic; take the latest N by time and return them in ascending order', async () => {
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

    test('local catch-up progress: max position per chat (-1 when empty) and recently active topics', async () => {
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

    test('recall and edit: only update messages already stored locally', async () => {
      await st.saveMessage(msg({ msg_id: 'm1' }));
      await st.saveMessage(msg({ msg_id: 'm2' }));
      expect(await st.markRecalled('m1', '7200000000000000001')).toBe(true);
      expect(await st.markRecalled('m1', '7200000000000000001')).toBe(false);
      expect(await st.markRecalled('m9', '7200000000000000001')).toBe(false);
      const edited = msg({
        msg_id: 'm2',
        content: 'Can the monthly report export filter by department and month?',
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
        ['m1', '[Recalled]', ''],
        ['m2', 'Can the monthly report export filter by department and month?', '{"text": "y"}'],
      ]);
      expect(RECALLED).toBe('[Recalled]');
    });

    test('a row stored with the legacy recall marker counts as already recalled', async () => {
      expect(LEGACY_RECALLED).toBe('[已撤回]');
      await st.saveMessage(msg({ msg_id: 'm3', content: LEGACY_RECALLED }));
      expect(await st.markRecalled('m3', '7200000000000000001')).toBe(false);
      const [row] = await st.getMessages('7200000000000000001');
      expect(row?.content).toBe(LEGACY_RECALLED);
    });

    test('chat names and agent sessions', async () => {
      await st.updateChatName('c1', 'Group one', 2);
      await st.updateChatName('c1', 'Group one renamed', 2);
      expect(await st.getChatName('c1')).toBe('Group one renamed');
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
