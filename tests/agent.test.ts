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
  content: 'Can the monthly report export filter by department?',
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

describe('digital twin dispatch', () => {
  test('XML escaping and quoteattr (as in xml.sax.saxutils)', () => {
    expect(quoteAttr('a"b')).toBe(`'a"b'`);
    expect(quoteAttr(`a"b'c`)).toBe('"a&quot;b\'c"');
    expect(quoteAttr('x<y>&\n')).toBe('"x&lt;y&gt;&amp;&#10;"');
    const xml = buildXmlMessage({
      ...msg({ at_me: true, content: 'a<b>' }),
      _sender_name: 'Colleague A',
    });
    expect(xml).toContain('<sender id="u-peer" name="Colleague A"/>');
    expect(xml).toContain('<at_me>true</at_me>');
    expect(xml).toContain('<content>a&lt;b&gt;</content>');
    expect(xml).not.toContain('<quote');
  });

  test('when replying to someone the prompt includes the quoted original', () => {
    const xml = buildXmlMessage({
      ...msg({ parent_id: 'm0', content: 'Sure' }),
      _quote: {
        id: 'm0',
        sender_id: 'u-me',
        sender_name: 'me',
        content: 'Can you send the <draft> by Friday?',
      },
    });
    expect(xml).toContain(
      '<quote id="m0" sender_id="u-me" sender_name="me">Can you send the &lt;draft&gt; by Friday?</quote>',
    );
    expect(xml.indexOf('<quote')).toBeLessThan(xml.indexOf('<content>'));
  });

  test('trigger rules: own messages, prefix, chat types, excluded chats, groups only on @me', () => {
    process.env.LARKX_TRIGGER_PREFIX = '/run';
    process.env.LARKX_TRIGGER_CHAT_TYPES = 'group,p2p';
    process.env.LARKX_TRIGGER_EXCLUDE_CHATS = '["c9"]';
    process.env.LARKX_TRIGGER_GROUP_AT_ONLY = 'true';
    const d = new AgentDispatcher(new FakeBackend(), async () => {});
    expect(d.shouldHandle(msg({ content: '/run export', at_me: true }), 'me')).toBe(true);
    expect(d.shouldHandle(msg({ content: '/run export', at_me: true, from_id: 'me' }), 'me')).toBe(
      false,
    );
    expect(d.shouldHandle(msg({ content: 'export', at_me: true }), 'me')).toBe(false);
    expect(d.shouldHandle(msg({ content: '/run export' }), 'me')).toBe(false);
    expect(d.shouldHandle(msg({ content: '/run export', chat_type: 1 }), 'me')).toBe(true);
    expect(d.shouldHandle(msg({ content: '/run export', chat_type: 3, at_me: true }), 'me')).toBe(
      false,
    );
    expect(d.shouldHandle(msg({ content: '/run x', chat_id: 'c9', at_me: true }), 'me')).toBe(
      false,
    );
    expect(d.parseCommand('/run /clear start over')).toEqual(['clear', 'start over']);
    expect(d.parseCommand('/stop')).toEqual(['stop', '']);
    expect(d.parseCommand('/stopped')).toEqual([null, null]);
  });

  test('one chat queues serially; /stop clears the queue, /clear resets the session', async () => {
    process.env.LARKX_CONTEXT_SCOPE = 'anchor';
    const backend = new FakeBackend();
    const replies: [string, string, string | undefined][] = [];
    const d = new AgentDispatcher(backend, async (c, t, r) => void replies.push([c, t, r]));
    await d.submit(msg({ content: 'first', anchor: 't1' }), 'Project team', 'Colleague A', 'me');
    await d.submit(msg({ content: 'second', anchor: 't1' }), 'Project team', 'Colleague A', 'me');
    await d.submit(msg({ content: 'third', anchor: 't1' }), 'Project team', 'Colleague A', 'me');
    expect(backend.runs).toHaveLength(1);
    expect(backend.runs[0]?.key).toBe('c1:t1');
    expect(backend.runs[0]?.prompt).toContain(
      'To reply, run: lark send c1 "<reply text>" --root t1',
    );
    await d.submit(msg({ content: '/stop', anchor: 't1' }), '', '', 'me');
    expect(replies).toEqual([['c1', '⏹ Cleared 2 queued messages', 't1']]);
    await d.submit(msg({ content: '/clear' }), '', '', 'me');
    expect(backend.resets).toEqual(['c1:']);
    expect(replies.at(-1)).toEqual(['c1', '✅ Started a new session', undefined]);
    backend.release?.();
    await Bun.sleep(10);
    expect(backend.runs).toHaveLength(1);
  });
});

describe('filtering by chat label', () => {
  test('with LARKX_TRIGGER_INCLUDE_TAGS only chats in the label are handled; none until the label is resolved', () => {
    process.env.LARKX_TRIGGER_INCLUDE_TAGS = 'Clients';
    const d = new AgentDispatcher(new FakeBackend(), async () => undefined);
    expect(d.shouldHandle(msg({ chat_id: 'c1' }), 'me')).toBe(false);
    d.setTagChats(['c1']);
    expect(d.shouldHandle(msg({ chat_id: 'c1' }), 'me')).toBe(true);
    expect(d.shouldHandle(msg({ chat_id: 'c2' }), 'me')).toBe(false);
  });
});

describe('recall and edit', () => {
  test('recalled queued messages are dropped; edited queued messages get the new content, already-handled ones go back to the agent with <edited>', async () => {
    process.env.LARKX_CONTEXT_SCOPE = 'chat';
    const backend = new FakeBackend();
    const d = new AgentDispatcher(backend, async () => undefined);
    await d.submit(
      msg({ msg_id: 'm1', content: 'What time is the weekly meeting moved to?' }),
      'Project team',
      'Colleague A',
      'me',
    );
    await d.submit(
      msg({ msg_id: 'm2', content: 'Wrong chat, sorry' }),
      'Project team',
      'Colleague A',
      'me',
    );
    await d.submit(
      msg({ msg_id: 'm3', content: 'Report export needs a department filter' }),
      'Project team',
      'Colleague A',
      'me',
    );
    expect(d.withdraw('m2')).toBe(1);
    expect(d.withdraw('m2')).toBe(0);
    await d.revise(
      msg({ msg_id: 'm3', content: 'Report export needs department and month filters' }),
      'Project team',
      'Colleague A',
      'me',
    );
    await d.revise(
      msg({ msg_id: 'm1', content: 'What time is the weekly meeting moved to (next week)?' }),
      'Project team',
      'Colleague A',
      'me',
    );
    // Messages edited by oneself do not trigger
    await d.revise(msg({ msg_id: 'm9', from_id: 'me', content: 'x' }), '', '', 'me');
    backend.release?.();
    await Bun.sleep(20);
    const contents = backend.runs.map((r) => /<content>(.*)<\/content>/.exec(r.prompt)?.[1]);
    expect(contents).toEqual([
      'What time is the weekly meeting moved to?',
      'Report export needs department and month filters',
      'What time is the weekly meeting moved to (next week)?',
    ]);
    expect(backend.runs[1]?.prompt).not.toContain('<edited>');
    expect(backend.runs[2]?.prompt).toContain('<edited>true</edited>');
  });
});

describe('reaction events reach the digital twin', () => {
  test('prefix and group @me-only rules do not block reactions, excluded chats are still excluded; the prompt has <reaction> and the reacted-to message', async () => {
    process.env.LARKX_TRIGGER_PREFIX = '/run';
    process.env.LARKX_TRIGGER_GROUP_AT_ONLY = 'true';
    process.env.LARKX_TRIGGER_EXCLUDE_CHATS = 'c9';
    const backend = new FakeBackend();
    backend.release = () => undefined;
    const d = new AgentDispatcher(backend, async () => undefined);
    const ev = { message_id: 'm1', reaction_type: 'THUMBSUP', user_id: 'u-peer', cancelled: false };
    const quote = {
      id: 'm1',
      sender_id: 'me',
      sender_name: 'me',
      content: 'Should I publish now?',
    };
    await d.submitReaction(
      ev,
      msg({ msg_id: 'm1', chat_id: 'c9', from_id: 'me' }),
      quote,
      '',
      'Colleague A',
      'me',
    );
    expect(backend.runs).toHaveLength(0);
    await d.submitReaction(
      ev,
      msg({ msg_id: 'm1', from_id: 'me' }),
      quote,
      'Project team',
      'Colleague A',
      'me',
    );
    await Bun.sleep(10);
    expect(backend.runs).toHaveLength(1);
    const prompt = backend.runs[0]?.prompt ?? '';
    expect(prompt).toContain('<sender id="u-peer" name="Colleague A"/>');
    expect(prompt).toContain('<reaction type="THUMBSUP" cancelled="false"/>');
    expect(prompt).toContain(
      '<quote id="m1" sender_id="me" sender_name="me">Should I publish now?</quote>',
    );
  });
});

describe('Claude Code backend', () => {
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

  test('uuid5 matches Python uuid.uuid5(NAMESPACE_URL, …)', () => {
    const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
    expect(uuid5(NS, 'larkx:7200000000000000001:')).toBe('da879cd2-3ef5-5f06-8442-2e269d217aa0');
    expect(uuid5(NS, 'larkx:global')).toBe('1a18c93e-cc33-5827-8f43-ccb4380898b6');
  });

  test('first --session-id creates, later --resume continues; prompt goes via stdin; a non-zero exit does not count as created', async () => {
    const log = join(dir, 'calls.log');
    const fake = join(dir, 'fake-claude');
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> ${log}\ncat >> ${log}\necho >> ${log}\n[ "$FAIL" = 1 ] && exit 3\necho ok\n`,
    );
    chmodSync(fake, 0o755);
    const backend = new ClaudeCodeBackend(st, fake);
    process.env.FAIL = '1';
    expect(await backend.run('c1:', 'first', 'c1', '')).toBe('');
    expect((await st.sessionGet('c1:'))?.started).toBe(0);
    process.env.FAIL = '';
    expect(await backend.run('c1:', 'second', 'c1', '')).toBe('ok');
    expect(await backend.run('c1:', 'third', 'c1', '')).toBe('ok');
    const sid = uuid5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'larkx:c1:');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(`--session-id ${sid}\nfirst`);
    expect(calls).toContain(`--session-id ${sid}\nsecond`);
    expect(calls).toContain(`--resume ${sid}\nthird`);
    expect(await st.sessionGet('c1:')).toMatchObject({ started: 1, msg_count: 2 });
    await backend.resetSession('c1:');
    const fresh = await st.sessionGet('c1:');
    expect(fresh?.started).toBe(0);
    expect(fresh?.agent_session_id).not.toBe(sid);
  });

  test('returns an empty string instead of throwing when the claude command is missing', async () => {
    const backend = new ClaudeCodeBackend(st, join(dir, 'no-such-claude'));
    expect(await backend.run('k', 'x')).toBe('');
  });

  test('legacy agent_sessions.json migrates into the session table and is renamed for the record', async () => {
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
