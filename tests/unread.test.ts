import { describe, expect, test } from 'bun:test';
import type { Dict } from '../src/proto/dict.js';
import { entity, newClient } from './helpers.js';

const ME = '7100000000000000009';

describe('unread and @me', () => {
  test('unread chats: keep only chats with unread messages or new topics', async () => {
    const c = newClient();
    c.recentChats = async () => [
      {
        chatId: 'g1',
        updatedAt: 3,
        chat: { name: 'Project team', type: 2, chatMode: 1, newMessageCount: 2 },
      },
      { chatId: 'g2', updatedAt: 2, chat: { name: 'Read group', type: 2, newMessageCount: 0 } },
      {
        chatId: 't1',
        updatedAt: 1,
        chat: { name: 'Thread group', type: 2, chatMode: 3, newThreadCount: 1 },
      },
    ];
    expect(await c.unreadChats()).toEqual([
      {
        chatId: 'g1',
        name: 'Project team',
        chatType: 2,
        threadChat: false,
        unread: 2,
        unreadThreads: 0,
      },
      {
        chatId: 't1',
        name: 'Thread group',
        chatType: 2,
        threadChat: true,
        unread: 0,
        unreadThreads: 1,
      },
    ]);
  });

  test('regular chats pull after the read position, drop own and recalled messages, and compute at_me from the @ list', async () => {
    const c = newClient();
    Object.assign(c.auth, { userId: ME });
    c.getChatInfo = async () => ({
      type: 2,
      chatMode: 1,
      readPosition: 10,
      lastMessagePosition: 13,
    });
    const reqs: Dict[] = [];
    c.api = async (_type, data) => {
      reqs.push(data as Dict);
      return {
        messages: {
          '11': entity('7000000000000000011', { createTime: 1n, atUserIdList: [BigInt(ME)] }),
          '12': entity('7000000000000000012', { createTime: 2n, fromId: ME }),
          '13': entity('7000000000000000013', { createTime: 3n, status: 2 }),
        },
      };
    };
    const got = await c.unreadMessages('g1');
    expect(reqs).toEqual([{ chatId: 'g1', positions: [11, 12, 13] }]);
    expect(got.map((m) => [m.msg_id, m.at_me])).toEqual([['7000000000000000011', true]]);
  });

  test("thread groups: new topics after the read topic position, plus replies after each topic's read position", async () => {
    const c = newClient();
    Object.assign(c.auth, { userId: ME });
    c.getChatInfo = async () => ({
      type: 2,
      chatMode: 3,
      lastThreadPosition: 1,
      readThreadPosition: 0,
    });
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      if (type === 'thread.PullThreadsByPositionsRequest')
        return {
          threads: {
            '0': { id: 'ta', position: 0, readPosition: 1, lastMessagePosition: 3 },
            '1': { id: 'tb', position: 1, readPosition: -1, lastMessagePosition: -1 },
          },
          rootMessages: {
            ta: entity('7000000000000000020', { createTime: 1n }),
            tb: entity('7000000000000000021', { createTime: 5n }),
          },
        };
      return {
        messages: {
          '2': entity('7000000000000000022', { rootId: 'ta', threadId: 'ta', createTime: 2n }),
          '3': entity('7000000000000000023', { rootId: 'ta', threadId: 'ta', createTime: 3n }),
        },
      };
    };
    const got = await c.unreadMessages('t1');
    expect(got.map((m) => [m.msg_id, m.scope, m.anchor])).toEqual([
      ['7000000000000000022', 'topic', 'ta'],
      ['7000000000000000023', 'topic', 'ta'],
      ['7000000000000000021', 'topic', '7000000000000000021'],
    ]);
    expect(reqs.find(([t]) => t === 'thread.PullThreadMessagesByPositionsRequest')?.[1]).toEqual({
      threadId: 'ta',
      positions: [2, 3],
    });
  });

  test('unreadMentions keeps only messages that @me', async () => {
    const c = newClient();
    c.unreadChats = async () => [
      { chatId: 'g1', name: '', chatType: 2, threadChat: false, unread: 1, unreadThreads: 0 },
    ];
    const { toLarkMessage } = await import('../src/proto/decoders.js');
    c.unreadMessages = async () => [
      toLarkMessage(entity('7000000000000000031'), { atMe: true }),
      toLarkMessage(entity('7000000000000000032'), { atMe: false }),
    ];
    expect((await c.unreadMentions()).map((m) => m.msg_id)).toEqual(['7000000000000000031']);
  });
});
