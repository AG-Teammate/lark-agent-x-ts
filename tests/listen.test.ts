import { describe, expect, test } from 'bun:test';
import { create, toBinary } from '@bufbuild/protobuf';
import { keepListening } from '../src/cli/listen-loop.js';
import type { LarkMessage } from '../src/proto/decoders.js';
import type { Dict } from '../src/proto/dict.js';
import { larkType, protoType } from '../src/proto/registry.js';
import { Storage } from '../src/storage/index.js';
import { entity, newClient, pushFrame } from './helpers.js';

const T = 1_790_000_000; // disconnect time (seconds)
const at = (dt: number) => BigInt(T + dt);

describe('补收断线期间的消息', () => {
  test('话题回复：按话题内 position 拉最近 limit 条，不请求根消息', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      if (type === 'thread.PullThreadsByIDsRequest')
        return { threads: { r1: { id: 'r1', lastMessagePosition: 4 } } };
      return {
        messages: {
          '4': entity('7000000000000000014', { rootId: 'r1', threadId: 'r1' }),
          '3': entity('7000000000000000013', { rootId: 'r1', threadId: 'r1' }),
        },
      };
    };
    const got = await c.threadReplies('r1', 2);
    expect(got.map((m) => [m.msg_id, m.scope, m.anchor])).toEqual([
      ['7000000000000000013', 'topic', 'r1'],
      ['7000000000000000014', 'topic', 'r1'],
    ]);
    expect(reqs[1]).toEqual([
      'thread.PullThreadMessagesByPositionsRequest',
      { threadId: 'r1', positions: [3, 4] },
    ]);
    c.api = async () => ({ threads: {} });
    expect(await c.threadReplies('nope')).toEqual([]);
  });

  test('普通会话从本地 position 之后拉，话题群按话题拉，只留断线之后的消息', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    const card = (id: string) => ({ id, type: 1, updateTimeMs: at(30) * 1000n, rankTime: at(30) });
    c.api = async (type, data) => {
      const d = data as Dict;
      reqs.push([String(type), d]);
      switch (type) {
        case 'feed.PullFeedCardsRequest':
          return {
            cards: [card('g1'), card('p1'), card('t1')],
            chats: {
              g1: { id: 'g1', type: 2, chatMode: 1, lastMessagePosition: 12 },
              p1: { id: 'p1', type: 1, lastMessagePosition: 3 },
              t1: { id: 't1', type: 2, chatMode: 3, lastThreadPosition: 1 },
            },
          };
        case 'messages.PullMessagesByPositionsRequest':
          if (d.chatId === 'g1')
            return {
              messages: {
                '10': entity('7000000000000000010', { chatId: 'g1', createTime: at(-60) }),
                '11': entity('7000000000000000011', {
                  chatId: 'g1',
                  createTime: at(3),
                  replyCount: '1',
                }),
                '12': entity('7000000000000000012', { chatId: 'g1', createTime: at(9) }),
              },
            };
          return {
            messages: {
              '3': entity('7000000000000000030', { chatId: 'p1', chatType: 1, createTime: at(1) }),
            },
          };
        case 'thread.PullThreadsByIDsRequest': {
          const all: Record<string, Dict> = {
            '7000000000000000011': {
              id: '7000000000000000011',
              updateTime: at(4),
              lastMessagePosition: 0,
            },
            r5: { id: 'r5', updateTime: at(5), lastMessagePosition: 0 },
            r6: { id: 'r6', updateTime: at(-5), lastMessagePosition: 0 },
            ta: { id: 'ta', updateTime: at(7), lastMessagePosition: 0 },
          };
          const ids = d.threadIds as string[];
          return { threads: Object.fromEntries(ids.filter((i) => all[i]).map((i) => [i, all[i]])) };
        }
        case 'thread.PullThreadMessagesByPositionsRequest': {
          const tid = String(d.threadId);
          const ct = { '7000000000000000011': 4, r5: 5, ta: 7 }[tid] ?? -100;
          const chatId = tid === 'ta' ? 't1' : 'g1';
          return {
            messages: {
              '0': entity(`70000000000000001${ct}`, {
                chatId,
                rootId: tid,
                threadId: tid,
                createTime: at(ct),
              }),
            },
          };
        }
        case 'thread.PullThreadsByPositionsRequest':
          return {
            threads: {
              '0': { id: 'tb', updateTime: at(-30), lastMessagePosition: 0 },
              '1': { id: 'ta', updateTime: at(7), lastMessagePosition: 0 },
            },
            rootMessages: {
              ta: entity('7000000000000000020', { chatId: 't1', createTime: at(2) }),
              tb: entity('7000000000000000021', { chatId: 't1', createTime: at(-30) }),
            },
          };
      }
      throw new Error(`未预期的请求 ${String(type)}`);
    };
    const known: string[] = [];
    const got = await c.missedMessages(T * 1000, {
      localPosition: async (chatId) => (chatId === 'g1' ? 9 : -1),
      knownThreads: async (chatId) => {
        known.push(chatId);
        return ['r5', 'r6'];
      },
    });
    expect(got.map((m) => [m.msg_id, m.chat_id, m.scope, m.anchor])).toEqual([
      ['7000000000000000030', 'p1', 'chat', ''],
      ['7000000000000000020', 't1', 'topic', '7000000000000000020'],
      ['7000000000000000011', 'g1', 'chat', ''],
      ['700000000000000014', 'g1', 'topic', '7000000000000000011'],
      ['700000000000000015', 'g1', 'topic', 'r5'],
      ['700000000000000017', 't1', 'topic', 'ta'],
      ['7000000000000000012', 'g1', 'chat', ''],
    ]);
    const positions = reqs
      .filter(([t]) => t === 'messages.PullMessagesByPositionsRequest')
      .map(([, d]) => [d.chatId, d.positions]);
    expect(positions).toEqual([
      ['g1', [10, 11, 12]],
      ['p1', [0, 1, 2, 3]],
    ]);
    // 1:1 chats have no threads, so local threads are not queried
    expect(known).toEqual(['g1']);
    expect(reqs.find(([t]) => t === 'thread.PullThreadsByPositionsRequest')?.[1]).toEqual({
      channelId: 't1',
      type: 1,
      positions: [0, 1],
    });
  });

  test('断线重连后补收，已经收到的消息不会再交给 agent', async () => {
    let conns = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          conns++;
          if (conns === 1) {
            ws.send(pushFrame([entity('7000000000000000001', { position: 1 })]));
            setTimeout(() => ws.close(4001, 'bye'), 50);
          }
        },
        message() {},
      },
    });
    const st = new Storage('sqlite:///:memory:');
    try {
      const c = newClient();
      c.wsTiming = { openTimeoutMs: 500, heartbeatMs: 1000, idleTimeoutMs: 2000 };
      c.buildWsUrl = async () => `ws://localhost:${server.port}`;
      c.isThreadChat = async () => false;
      const handled: string[] = [];
      const sinces: number[] = [];
      const abort = new AbortController();
      const before = Date.now();
      await keepListening(
        c,
        async (m: LarkMessage) => {
          if (await st.saveMessage(m)) handled.push(m.msg_id);
          if (handled.length === 2) abort.abort();
        },
        {
          retryMs: 20,
          signal: abort.signal,
          missed: async (since) => {
            sinces.push(since);
            const { toLarkMessage } = await import('../src/proto/decoders.js');
            return [
              toLarkMessage(entity('7000000000000000001', { position: 1 }), {}),
              toLarkMessage(entity('7000000000000000002', { position: 2 }), {}),
            ];
          },
        },
      );
      expect(handled).toEqual(['7000000000000000001', '7000000000000000002']);
      expect(conns).toBe(2);
      expect(sinces).toHaveLength(1);
      expect(sinces[0]).toBeLessThanOrEqual(Date.now() - 2000);
      expect(sinces[0]).toBeGreaterThanOrEqual(before - 2000);
    } finally {
      await st.close();
      server.stop(true);
    }
  });
});

describe('按 id 取消息与话题', () => {
  test('getMessages 按传入顺序返回、跳过不存在的；话题群的根消息归到自己的话题', async () => {
    const c = newClient();
    c.isThreadChat = async (chatId) => chatId === 'tc';
    c.api = async (_type, data) => {
      const all: Record<string, Dict> = {
        '7000000000000000001': entity('7000000000000000001', { chatId: 'g1' }),
        '7000000000000000002': entity('7000000000000000002', { chatId: 'tc' }),
      };
      const ids = (data as { messageIds: string[] }).messageIds;
      return { messages: Object.fromEntries(ids.filter((i) => all[i]).map((i) => [i, all[i]])) };
    };
    const got = await c.getMessages(['7000000000000000002', 'nope', '7000000000000000001']);
    expect(got.map((m) => [m.msg_id, m.scope, m.anchor])).toEqual([
      ['7000000000000000002', 'topic', '7000000000000000002'],
      ['7000000000000000001', 'chat', ''],
    ]);
    expect(await c.getMessages([])).toEqual([]);
  });

  test('threadMessages：根消息在前，随后是回复；根消息不存在时为空', async () => {
    const c = newClient();
    c.isThreadChat = async () => false;
    let rootExists = true;
    c.api = async (type) => {
      if (type === 'messages.PullMessagesByIdsRequest')
        return rootExists ? { messages: { r1: entity('r1') } } : { messages: {} };
      if (type === 'thread.PullThreadsByIDsRequest')
        return { threads: { r1: { id: 'r1', lastMessagePosition: 0 } } };
      return { messages: { '0': entity('7000000000000000011', { rootId: 'r1', threadId: 'r1' }) } };
    };
    expect((await c.threadMessages('r1')).map((m) => m.msg_id)).toEqual([
      'r1',
      '7000000000000000011',
    ]);
    rootExists = false;
    expect(await c.threadMessages('r1')).toEqual([]);
  });
});

describe('推送里的撤回与编辑', () => {
  test('同一条消息以撤回 / 编辑状态重推时带上标记，普通消息不带', async () => {
    const { decodePushMessages } = await import('../src/proto/decoders.js');
    const got = decodePushMessages(
      pushFrame([
        entity('7000000000000000001', { status: 1 }),
        entity('7000000000000000002', { status: 2, content: new Uint8Array() }),
        entity('7000000000000000003', { status: 3 }),
        entity('7000000000000000004', { status: 1, editVersion: 2 }),
        entity('7000000000000000005', { isRemoved: true }),
      ]),
    );
    const flags = Object.fromEntries(
      got.map((m) => [m.msg_id.slice(-1), [m.recalled ?? false, m.edited ?? false]]),
    );
    expect(flags).toEqual({
      '1': [false, false],
      '2': [true, false],
      '3': [false, true],
      '4': [false, true],
      '5': [true, false],
    });
    expect('recalled' in (got.find((m) => m.msg_id.endsWith('1')) as object)).toBe(false);
  });
});

describe('表情事件', () => {
  const reactionFrame = () => {
    const desc = larkType('reactions.PushReactions');
    const payload = toBinary(
      desc,
      create(desc, {
        messageReactions: [
          {
            messageId: '7000000000000000001',
            reactions: [
              { type: 'THUMBSUP', count: 2 },
              { type: 'OK', count: 0 },
            ],
          },
          { messageId: '7000000000000000002', reactions: [] },
        ],
        reactionExtraInfos: {
          '7000000000000000001': { reactionChatterId: '7100000000000000002', type: 'THUMBSUP' },
        },
      } as Record<string, unknown>),
    );
    const packet = create(protoType('Packet'), { sid: 'sid-9', cmd: 27, payload } as Record<
      string,
      unknown
    >);
    return toBinary(
      protoType('Frame'),
      create(protoType('Frame'), { payload: toBinary(protoType('Packet'), packet) } as Record<
        string,
        unknown
      >),
    );
  };

  test('推送 cmd=27 解出谁对哪条消息加了哪个表情，交给 onReaction', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(reactionFrame());
          setTimeout(() => ws.close(1000), 50);
        },
        message() {},
      },
    });
    try {
      const c = newClient();
      c.buildWsUrl = async () => `ws://localhost:${server.port}`;
      const got: unknown[] = [];
      await c.connectWebsocket(
        async () => undefined,
        undefined,
        undefined,
        async (ev) => void got.push(ev),
      );
      expect(got).toEqual([
        {
          message_id: '7000000000000000001',
          reaction_type: 'THUMBSUP',
          user_id: '7100000000000000002',
          cancelled: false,
          counts: { THUMBSUP: 2 },
        },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
