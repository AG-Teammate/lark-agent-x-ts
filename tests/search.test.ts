import { describe, expect, test } from 'bun:test';
import { parseTimeArg } from '../src/cli/time.js';
import type { Dict } from '../src/proto/dict.js';
import { newClient } from './helpers.js';

const hit = (id: string, over: Dict = {}) => ({
  id,
  type: 5,
  titleHighlighted: 'Project team',
  summaryHighlighted: `Colleague A: <h>monthly report</h> export ${id}`,
  resultMeta: {
    messageMeta: {
      id,
      type: 4,
      chatId: '7200000000000000001',
      fromId: '7100000000000000001',
      createTime: 1_790_000_000n,
      position: 7,
      ...over,
    },
  },
});

describe('cross-chat message search', () => {
  test('filters go into messageFilter; pages within one session until enough results or no more', async () => {
    const c = newClient();
    Object.assign(c.auth, { region: { locale: 'zh_CN' } });
    const reqs: Dict[] = [];
    const pages: Dict[] = [
      {
        header: { hasMore: true, paginationToken: 't1' },
        results: [hit('m1'), { id: 'u1', type: 1 }],
      },
      {
        header: { hasMore: true, paginationToken: 't2' },
        results: [hit('m2', { isP2pChat: true })],
      },
      { header: { hasMore: false }, results: [hit('m3')] },
    ];
    c.api = async (type, data) => {
      expect(type).toBe('usearch.UniversalSearchRequest');
      reqs.push((data as Dict).header as Dict);
      return pages[reqs.length - 1] ?? {};
    };
    const got = await c.searchMessages('monthly report', {
      chatIds: ['7200000000000000001'],
      fromIds: ['7100000000000000001'],
      since: 1_790_000_000_500,
      limit: 2,
    });
    expect(got).toEqual([
      {
        msgId: 'm1',
        chatId: '7200000000000000001',
        chatTitle: 'Project team',
        fromId: '7100000000000000001',
        createTime: 1_790_000_000,
        position: 7,
        msgType: 4,
        p2p: false,
        summary: 'Colleague A: monthly report export m1',
      },
      expect.objectContaining({ msgId: 'm2', p2p: true }),
    ]);
    expect(reqs).toHaveLength(2);
    const ctx = reqs[0]?.searchContext as Dict;
    expect(ctx.tagName).toBe('MESSAGE');
    expect(ctx.entityItems).toEqual([
      {
        type: 5,
        filter: {
          messageFilter: {
            chatIds: ['7200000000000000001'],
            creatorIds: ['7100000000000000001'],
            timeRange: { startTime: '1790000000' },
          },
        },
      },
    ]);
    expect([reqs[0]?.searchSession, reqs[0]?.sessionSeqId, reqs[0]?.paginationToken]).toEqual([
      reqs[1]?.searchSession,
      1,
      undefined,
    ]);
    expect([reqs[1]?.sessionSeqId, reqs[1]?.paginationToken]).toEqual([2, 't1']);
  });

  test('time arguments: relative durations, dates, date-times and timestamps', () => {
    const now = new Date(2026, 9, 14, 12, 0, 0).getTime();
    expect(parseTimeArg('30m', now)).toBe(now - 30 * 60_000);
    expect(parseTimeArg('3d', now)).toBe(now - 3 * 86_400_000);
    expect(parseTimeArg('2026-10-01', now)).toBe(new Date(2026, 9, 1).getTime());
    expect(parseTimeArg('2026-10-01 09:30', now)).toBe(new Date(2026, 9, 1, 9, 30).getTime());
    expect(parseTimeArg('1790000000', now)).toBe(1_790_000_000_000);
    expect(parseTimeArg('1790000000123', now)).toBe(1_790_000_000_123);
    expect(parseTimeArg('10m', now, true)).toBe(now + 10 * 60_000);
    expect(() => parseTimeArg('yesterday', now)).toThrow('unrecognized time: yesterday');
  });
});

describe('history by time range', () => {
  // position 0..99; message n is created at 1000+10n seconds; 40..55 is a gap (e.g. recalled without trace)
  const exists = (p: number) => p >= 0 && p <= 99 && (p < 40 || p > 55);
  const fakeChat = () => {
    const c = newClient();
    let calls = 0;
    c.getChatInfo = async () => ({ lastMessagePosition: 99 });
    c.isThreadChat = async () => false;
    c.api = async (_type, data) => {
      calls++;
      const positions = (data as { positions: number[] }).positions;
      return {
        messages: Object.fromEntries(
          positions.filter(exists).map((p) => [
            String(p),
            {
              id: `70000000000000${String(p).padStart(5, '0')}`,
              type: 4,
              fromId: 'u1',
              chatId: 'g1',
              position: p,
              createTime: BigInt(1000 + 10 * p),
            },
          ]),
        ),
      };
    };
    return { c, calls: () => calls };
  };

  test('binary search for the position bounds of a time, skipping gaps', async () => {
    const { c, calls } = fakeChat();
    expect(await c.positionAt('g1', 1_000_000, 99)).toBe(0);
    expect(await c.positionAt('g1', 1_300_000, 99)).toBe(30);
    expect(await c.positionAt('g1', 1_305_000, 99)).toBe(31);
    // Bounds may fall inside the gap: 40..55 has no messages
    expect(await c.positionAt('g1', 1_450_000, 99)).toBe(40);
    expect(await c.positionAt('g1', 9_999_000, 99)).toBe(100);
    expect(calls()).toBeLessThan(60);
  });

  test('take the latest limit messages in range, both ends inclusive', async () => {
    const { c } = fakeChat();
    const got = await c.historyRange('g1', { since: 1_300_000, until: 1_600_000, limit: 5 });
    expect(got.map((m) => m.position)).toEqual([56, 57, 58, 59, 60]);
    const all = await c.historyRange('g1', { since: 1_300_000, until: 1_600_000, limit: 100 });
    expect(all.map((m) => m.position)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => 30 + i),
      ...Array.from({ length: 5 }, (_, i) => 56 + i),
    ]);
    expect(await c.historyRange('g1', { since: 9_999_000 })).toEqual([]);
  });
});

describe('translation', () => {
  test('text translation keeps order; message translation uses the text content and skips messages without text', async () => {
    const c = newClient();
    const reqs: Dict[] = [];
    c.api = async (type, data) => {
      if (type === 'messages.PullMessagesByIdsRequest')
        return {
          messages: {
            m1: {
              id: 'm1',
              type: 4,
              chatId: 'g1',
              content: (await import('./helpers.js')).textContent('Ship on Friday'),
            },
            m2: {
              id: 'm2',
              type: 4,
              chatId: 'g1',
              content: (await import('./helpers.js')).textContent(''),
            },
          },
        };
      reqs.push(data as Dict);
      return { trgContents: ((data as Dict).srcContents as string[]).map((t) => `EN(${t})`) };
    };
    c.isThreadChat = async () => false;
    expect(await c.translateText(['first', 'second'], 'en')).toEqual(['EN(first)', 'EN(second)']);
    expect(reqs[0]).toEqual({
      srcContents: ['first', 'second'],
      srcLanguage: '',
      trgLanguage: 'en',
      contentType: 2,
    });
    expect(await c.translateMessages(['m1', 'm2', 'm3'], 'en')).toEqual([
      { msgId: 'm1', original: 'Ship on Friday', translated: 'EN(Ship on Friday)' },
    ]);
    expect(await c.translateText([], 'en')).toEqual([]);
  });
});
