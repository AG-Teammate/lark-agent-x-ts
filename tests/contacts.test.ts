import { describe, expect, test } from 'bun:test';
import type { LarkAuth } from '../src/auth.js';
import { chatterName } from '../src/client.js';
import type { Dict } from '../src/proto/dict.js';
import { newClient } from './helpers.js';

const withLocale = (c: ReturnType<typeof newClient>) =>
  Object.assign(c.auth, { region: { locale: 'zh_CN' } } as Partial<LarkAuth>);

describe('names and group members', () => {
  test('display name: alias > current-locale display name > default display name > name', () => {
    const v: Dict = {
      name: 'tongshi',
      displayName: {
        defaultVal: 'Colleague A',
        i18nVals: { zh_cn: 'Colleague A (zh_cn)', en_us: '' },
      },
    };
    expect(chatterName({ ...v, alias: 'Alias A' })).toBe('Alias A');
    expect(chatterName(v)).toBe('Colleague A (zh_cn)');
    expect(chatterName(v, 'en_US')).toBe('Colleague A');
    expect(chatterName({ name: 'tongshi' })).toBe('tongshi');
  });

  test('group members: paging params passed back as-is, updateChatters merged, stops when the server gives no cursor', async () => {
    const c = newClient();
    withLocale(c);
    const reqs: Dict[] = [];
    const pages: Dict[] = [
      {
        chatters: { u1: { name: 'Colleague A', type: 1 }, b1: { name: 'Reminder bot', type: 2 } },
        nextCursor: 5n,
        nextOffset: 'o2',
      },
      {
        chatters: {},
        updateChatters: { u2: { name: 'Colleague B', type: 1 } },
        nextOrderCursor: 9n,
      },
      { chatters: { u3: { name: 'Colleague C', type: 1 } } },
    ];
    c.api = async (type, data) => {
      expect(type).toBe('chats.PullChatChattersRequest');
      reqs.push(data as Dict);
      return pages[reqs.length - 1] ?? {};
    };
    expect(await c.chatMembers('g1')).toEqual([
      { id: 'u1', name: 'Colleague A', type: 'user' },
      { id: 'b1', name: 'Reminder bot', type: 'bot' },
      { id: 'u2', name: 'Colleague B', type: 'user' },
      { id: 'u3', name: 'Colleague C', type: 'user' },
    ]);
    expect(reqs).toEqual([
      { chatId: 'g1', limit: 100 },
      { chatId: 'g1', limit: 100, cursor: 5n, offset: 'o2' },
      { chatId: 'g1', limit: 100, orderCursor: 9n },
    ]);
    // Names found among members are cached, so no further request
    c.api = async () => {
      throw new Error('should not request again');
    };
    expect(await c.userNames(['u2'])).toEqual(new Map([['u2', 'Colleague B']]));
  });

  test('batch name lookup: dedupe, 100 per batch, cached, unknown ids omitted', async () => {
    const c = newClient();
    withLocale(c);
    const batches: string[][] = [];
    c.api = async (_type, data) => {
      const ids = (data as { chatterIds: string[] }).chatterIds;
      batches.push(ids);
      return {
        chatters: Object.fromEntries(
          ids.filter((i) => i !== 'ghost').map((i) => [i, { name: `Name ${i}` }]),
        ),
      };
    };
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const got = await c.userNames([...ids, 'u0', 'ghost']);
    expect(got.size).toBe(150);
    expect(got.get('u7')).toBe('Name u7');
    expect(got.has('ghost')).toBe(false);
    expect(batches.map((b) => b.length)).toEqual([100, 51]);
    await c.userNames(['u1', 'u2']);
    expect(batches).toHaveLength(2);
  });
});

describe('group management', () => {
  test('request fields for create, add, remove and rename', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      return type === 'chats.PutChatRequest' ? { chat: { id: '7200000000000000009' } } : {};
    };
    expect(
      await c.createGroup('Project team', ['u1', 'u2'], {
        description: 'Weekly report',
        topic: true,
        cid: 'g1cid',
      }),
    ).toBe('7200000000000000009');
    await c.createGroup('Just me', [], { cid: 'g2cid' });
    await c.addMembers('7200000000000000009', ['u3']);
    await c.removeMembers('7200000000000000009', ['u2']);
    await c.updateGroup('7200000000000000009', { name: 'Project team (phase 2)' });
    await c.updateGroup('7200000000000000009', { description: '' });
    await c.updateGroup('7200000000000000009', {});
    expect(reqs).toEqual([
      [
        'chats.PutChatRequest',
        {
          type: 2,
          groupName: 'Project team',
          groupDesc: 'Weekly report',
          chatterIds: ['u1', 'u2'],
          chatMode: 3,
          cid: 'g1cid',
        },
      ],
      ['chats.PutChatRequest', { type: 2, groupName: 'Just me', chatterIds: [], cid: 'g2cid' }],
      ['chats.PutChatChatterRequest', { chatId: '7200000000000000009', chatterIds: ['u3'] }],
      ['chats.DeleteChatChatterRequest', { chatId: '7200000000000000009', chatterIds: ['u2'] }],
      [
        'chats.PatchGroupChatRequest',
        { chatId: '7200000000000000009', name: 'Project team (phase 2)', updateFields: [1] },
      ],
      [
        'chats.PatchGroupChatRequest',
        { chatId: '7200000000000000009', description: '', updateFields: [3] },
      ],
    ]);
    c.api = async () => ({});
    await expect(c.createGroup('x')).rejects.toThrow('create group failed: no chat id in response');
  });
});

describe('chat labels', () => {
  test('list labels (paged, sorted by position) and the chats in a label (chats only, exclusions removed)', async () => {
    const c = newClient();
    const reqs: [string, Dict][] = [];
    let groupPage = 0;
    c.api = async (type, data) => {
      reqs.push([String(type), data as Dict]);
      if (type === 'feed.PullFeedGroupsRequest')
        return groupPage++ === 0
          ? {
              feedGroups: [{ id: 2n, name: 'Clients', type: 1, pos: 2n }],
              hasMore: true,
              nextCursor: 'c1',
            }
          : {
              feedGroups: [{ id: 1n, name: 'To reply', type: 2, pos: 1n }],
              hasMore: false,
              nextCursor: 'c2',
            };
      return {
        data: {
          '2': {
            feedGroupItems: [
              { feedCardId: 71n, feedCardType: 1 },
              { feedCardId: 72n, feedCardType: 3 },
              { feedCardId: 73n, feedCardType: 1, exclude: true },
            ],
            hasMore: false,
          },
        },
      };
    };
    expect(await c.feedGroups()).toEqual([
      { id: '1', name: 'To reply', type: 'keyword' },
      { id: '2', name: 'Clients', type: 'normal' },
    ]);
    expect(reqs.map(([, d]) => d)).toEqual([{ count: '20' }, { count: '20', cursor: 'c1' }]);
    expect(await c.feedGroupChats('2')).toEqual(['71']);
    expect(reqs.at(-1)?.[1]).toEqual({ args: { '2': { count: '20' } } });
  });
});
