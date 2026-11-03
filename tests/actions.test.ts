import { describe, expect, test } from 'bun:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { extractRichText } from '../src/proto/decoders.js';
import { type Dict, toDict } from '../src/proto/dict.js';
import { larkType, protoType } from '../src/proto/registry.js';
import { newClient } from './helpers.js';

/** Intercept gateway requests: decode cmd and request body (as the given lark type) and return an empty response. */
function capture(c: ReturnType<typeof newClient>, reqType: string) {
  const seen: { cmd: number; body: Dict }[] = [];
  c.gatewayPost = async (pkt) => {
    const p = pkt as unknown as { cmd: number; payload: Uint8Array };
    seen.push({
      cmd: p.cmd,
      body: toDict(larkType(reqType), fromBinary(larkType(reqType), p.payload)),
    });
    return toBinary(protoType('Packet'), create(protoType('Packet')));
  };
  return seen;
}

describe('撤回、编辑与表情', () => {
  test('撤回：服务端回 ok 才算成功', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    let reply: Dict = { message: 'ok' };
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      return reply;
    };
    await c.recallMessage('7000000000000000001');
    expect(reqs).toEqual([['messages.DeleteMessageRequest', { id: '7000000000000000001' }]]);
    reply = {};
    await expect(c.recallMessage('7000000000000000001')).rejects.toThrow('撤回失败');
  });

  test('编辑：文本按 TEXT、结构化内容按 POST 整条替换，消息 id 按 int64 发送', async () => {
    const c = newClient();
    const seen = capture(c, 'messages.EditMessageRequest');
    await c.editMessage('7000000000000000001', {
      text: '改过的 [文档](https://example.com/d)',
      links: true,
    });
    await c.editMessage('7000000000000000002', {
      blocks: [{ type: 'p', runs: [{ text: '结论：', bold: true }, { text: '周五上线' }] }],
      text: '结论：周五上线',
    });
    expect(seen.map((s) => [s.cmd, s.body.msgId, s.body.type])).toEqual([
      [900010, 7000000000000000001n, 4],
      [900010, 7000000000000000002n, 2],
    ]);
    const rt = (s: { body: Dict }) => (s.body.content as Dict).richText as Dict;
    expect(extractRichText(rt(seen[0] as { body: Dict }))).toBe('改过的 '); // link elements are not counted in the plain-text summary
    expect(rt(seen[0] as { body: Dict }).anchorIds).toEqual(['2']);
    expect(extractRichText(rt(seen[1] as { body: Dict }))).toBe('结论：周五上线');
    expect(seen.every((s) => typeof s.body.cid === 'string' && s.body.cid.length === 10)).toBe(
      true,
    );
  });

  test('表情：加、去与查询（加过的人取自更新时间表）', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      if (type !== 'reactions.PullReactionsRequest') return {};
      return {
        messageReactions: [
          {
            messageId: 'm1',
            reactions: [
              { type: 'THUMBSUP', count: 2, nanoUpdateTimes: { u1: 1n, u2: 2n } },
              { type: 'DONE', count: 1, userIds: ['u3'] },
              { type: 'OK', count: 0, nanoUpdateTimes: {} },
            ],
          },
        ],
      };
    };
    await c.addReaction('m1', 'THUMBSUP');
    await c.removeReaction('m1', 'THUMBSUP');
    expect(await c.reactions(['m1'])).toEqual([
      {
        messageId: 'm1',
        reactions: [
          { type: 'THUMBSUP', count: 2, userIds: ['u1', 'u2'] },
          { type: 'DONE', count: 1, userIds: ['u3'] },
        ],
      },
    ]);
    expect(reqs.slice(0, 2)).toEqual([
      ['reactions.PutReactionRequest', { messageId: 'm1', reactionType: 'THUMBSUP' }],
      ['reactions.DeleteReactionRequest', { messageId: 'm1', reactionType: 'THUMBSUP' }],
    ]);
  });
});

describe('Markdown 消息', () => {
  test('整段放进一个 MARKDOWN 元素并登记 markdownIds；解码时按原文取回', async () => {
    const { buildMarkdownMessagePacket } = await import('../src/proto/builders.js');
    const { decodeMessageContent } = await import('../src/proto/decoders.js');
    const md = '## 结论\n\n- 周五上线\n\n```ts\nconst a = 1;\n```';
    const pkt = buildMarkdownMessagePacket(md, { chatId: 'c1' }, 'r1', '周报') as unknown as {
      cmd: number;
      payload: Uint8Array;
    };
    const req = toDict(
      protoType('PutMessageRequest'),
      fromBinary(protoType('PutMessageRequest'), pkt.payload),
    );
    expect([pkt.cmd, req.type, (req.content as Dict).title]).toEqual([5, 2, '周报']);
    const rt = (req.content as Dict).richText as Dict;
    expect([rt.elementIds, rt.markdownIds, rt.innerText]).toEqual([['1'], ['1'], md]);
    const el = ((rt.elements as Dict).dictionary as Record<string, Dict>)['1'] as Dict;
    expect(el.tag).toBe(49);
    expect(extractRichText(rt)).toBe(md);
    const content = toBinary(
      protoType('PostContent'),
      create(protoType('PostContent'), { title: '周报', richText: rt } as Record<string, unknown>),
    );
    expect(decodeMessageContent(2, content)[0]).toBe(`[富文本] 周报\n${md}`);
  });
});

describe('已读情况', () => {
  test('发送方视角的已读/未读名单，与我自己是否读过', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      if (type === 'messages.PullMessageReadStateRequest')
        return {
          readStates: {
            m1: {
              readUserIds: ['u1'],
              unreadUserIds: ['u2', 'u3'],
              readCount: 1,
              unreadCount: 2,
              lastUserReadInfo: { userId: 'u1', readTime: 1_790_000_100n },
            },
          },
        };
      return { readStatus: { m1: true, m2: false }, readTimes: { m1: 1_790_000_200n } };
    };
    expect(await c.readStates('g1', ['m1', 'nope'])).toEqual([
      {
        messageId: 'm1',
        readCount: 1,
        unreadCount: 2,
        readUserIds: ['u1'],
        unreadUserIds: ['u2', 'u3'],
        lastRead: { userId: 'u1', time: 1_790_000_100 },
      },
    ]);
    expect(reqs[0]?.[1]).toEqual({
      pairs: [
        { chatId: 'g1', messageId: 'm1' },
        { chatId: 'g1', messageId: 'nope' },
      ],
    });
    expect(await c.myReadStates(['m1', 'm2', 'm3'])).toEqual(
      new Map<string, number | null>([
        ['m1', 1_790_000_200],
        ['m2', null],
      ]),
    );
  });
});

describe('转发', () => {
  test('每个目标会话各带一个 cid，返回会话 → 新消息 id，没转成的不在结果里', async () => {
    const c = newClient();
    let req: Dict = {};
    c.api = async (type, data) => {
      expect(type).toBe('messages.PutTransmitMessageRequest');
      req = data as Dict;
      return { messages: { c1: { id: '7000000000000000101' } } };
    };
    const got = await c.forwardMessage('7000000000000000001', ['c1', 'c2']);
    expect(got).toEqual(new Map([['c1', '7000000000000000101']]));
    expect([req.chatIds, req.messageId]).toEqual([['c1', 'c2'], '7000000000000000001']);
    const cids = req.cids as Record<string, string>;
    expect(Object.keys(cids)).toEqual(['c1', 'c2']);
    expect(cids.c1).not.toBe(cids.c2);
  });
});

describe('标记', () => {
  test('标记消息与会话、取消标记、按游标翻页列出并带上消息', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    const pages: Dict[] = [
      {
        items: [{ itemId: 7000000000000000001n, flagType: 2, createTime: 100n }],
        messages: {
          '7000000000000000001': { id: '7000000000000000001', type: 4, fromId: 'u1', chatId: 'g1' },
        },
        hasMore: true,
        nextCursor: '100:1',
      },
      {
        items: [{ itemId: 7200000000000000001n, flagType: 1, createTime: 200n }],
        hasMore: false,
        nextCursor: '0:0',
      },
    ];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      if (type === 'feed.PullFlagsRequest')
        return pages[reqs.filter(([t]) => t === type).length - 1] ?? {};
      return {};
    };
    await c.flagMessages(['m1']);
    await c.flagMessages(['m1'], true);
    await c.flagChats(['g1']);
    const got = await c.flags();
    expect(reqs.slice(0, 3)).toEqual([
      ['feed.UpdateFlagsRequest', { items: [{ itemId: 'm1', flagType: 2 }] }],
      ['feed.UpdateFlagsRequest', { deletedItems: [{ itemId: 'm1', flagType: 2 }] }],
      ['feed.UpdateFlagsRequest', { items: [{ itemId: 'g1', itemType: 1, flagType: 1 }] }],
    ]);
    expect(reqs.slice(3).map(([, d]) => d.cursor)).toEqual([undefined, '100:1']);
    expect(got.map((f) => [f.type, f.id, f.createTime, f.message?.chat_id ?? null])).toEqual([
      ['chat', '7200000000000000001', 200, null],
      ['message', '7000000000000000001', 100, 'g1'],
    ]);
  });
});

describe('Pin 与会话置顶', () => {
  test('Pin、按消息找到 pin id 后取消、列出 Pin（带消息）', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      switch (type) {
        case 'pin.PutPinRequest':
          return { pin: { id: 9n } };
        case 'pin.PullPinsByMessageIDsRequest':
          return {
            pins: {
              '1': { id: 8n, messageId: 1n, deletedTime: 5n },
              '2': { id: 9n, messageId: 7000000000000000001n },
            },
          };
        case 'pin.PullChatPinsRequest':
          return {
            pins: [
              { id: 9n, messageId: 7000000000000000001n, chatterId: 71n, createTime: 100n },
              { id: 10n, messageId: 7000000000000000002n, chatterId: 72n, createTime: 200n },
            ],
            pinedMessages: {
              '7000000000000000001': {
                id: '7000000000000000001',
                type: 4,
                fromId: 'u1',
                chatId: 'g1',
              },
            },
            hasMore: false,
          };
      }
      return {};
    };
    expect(await c.pinMessage('g1', '7000000000000000001')).toBe('9');
    expect(await c.unpinMessage('g1', '7000000000000000001')).toBe(true);
    expect(reqs.at(-1)).toEqual(['pin.DeletePinRequest', { id: '9', chatId: 'g1' }]);
    expect(await c.unpinMessage('g1', '7000000000000000003')).toBe(false);
    const pins = await c.chatPins('g1');
    expect(
      pins.map((p) => [p.messageId, p.pinnedBy, p.pinnedAt, p.message?.msg_id ?? null]),
    ).toEqual([
      ['7000000000000000002', '72', 200, null],
      ['7000000000000000001', '71', 100, '7000000000000000001'],
    ]);
  });

  test('会话置顶：只取会话类型，按位置排序；增删带上类型', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      return type === 'feed.PullShortcutsRequest'
        ? {
            shortcuts: [
              { id: 'g2', type: 1, position: 2 },
              { id: 'd1', type: 3, position: 0 },
              { id: 'g1', type: 1, position: 1 },
            ],
          }
        : {};
    };
    expect(await c.shortcuts()).toEqual(['g1', 'g2']);
    await c.addShortcuts(['g3', 'g4']);
    await c.removeShortcuts(['g3']);
    expect(reqs.slice(1)).toEqual([
      [
        'feed.PutShortcutsRequest',
        {
          shortcuts: [
            { id: 'g3', type: 1, position: 0 },
            { id: 'g4', type: 1, position: 1 },
          ],
        },
      ],
      ['feed.DeleteShortcutsRequest', { shortcuts: [{ id: 'g3', type: 1 }] }],
    ]);
  });
});

describe('定时消息', () => {
  test('定时发送把发送包装进 putRequest，时间按秒；列出、改时间、取消', async () => {
    const c = newClient();
    c.isThreadChat = async () => false;
    let scheduleReq: Dict = {};
    c.gatewayPost = async (pkt) => {
      const p = pkt as unknown as { cmd: number; payload: Uint8Array };
      expect(p.cmd).toBe(900030);
      const T = larkType('messages.PutScheduleMessageRequest');
      scheduleReq = toDict(T, fromBinary(T, p.payload));
      const R = larkType('messages.PutScheduleMessageResponse');
      return toBinary(
        protoType('Packet'),
        create(protoType('Packet'), {
          payload: toBinary(R, create(R, { message: { messageId: '7000000000000000201' } })),
        } as Record<string, unknown>),
      );
    };
    expect(
      await c.scheduleMessage('c1', { markdown: '**周报**' }, 1_790_000_600_500, { rootId: 'r1' }),
    ).toBe('7000000000000000201');
    expect([scheduleReq.scheduleTime, scheduleReq.chatId, scheduleReq.entityId]).toEqual([
      1_790_000_600n,
      'c1',
      'r1',
    ]);
    const put = scheduleReq.putRequest as Dict;
    expect([put.type, put.chatId, put.rootId]).toEqual([2, 'c1', 'r1']);

    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      return type === 'messages.PullChatScheduleMessagesRequest'
        ? {
            messages: [
              { messageId: 'm2', scheduleTime: 300n, status: 2 },
              {
                messageId: 'm1',
                scheduleTime: 200n,
                status: 1,
                scheduleMessage: { id: 'm1', type: 4, fromId: 'u1' },
              },
            ],
          }
        : {};
    };
    const list = await c.scheduledMessages('c1');
    expect(list.map((m) => [m.messageId, m.at, m.status, m.message?.chat_id ?? null])).toEqual([
      ['m1', 200_000, 'pending', 'c1'],
      ['m2', 300_000, 'suspended', null],
    ]);
    await c.rescheduleMessage('c1', 'm1', 400_900);
    await c.cancelScheduledMessage('c1', 'm1');
    expect(reqs.slice(1)).toEqual([
      [
        'messages.PatchScheduleMessageRequest',
        { patchType: 1, messageId: 'm1', chatId: 'c1', scheduleTime: '400' },
      ],
      ['messages.PatchScheduleMessageRequest', { patchType: 3, messageId: 'm1', chatId: 'c1' }],
    ]);
  });
});
