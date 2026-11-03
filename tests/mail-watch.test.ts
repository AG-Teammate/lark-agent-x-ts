import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { create, toBinary } from '@bufbuild/protobuf';
import { keepListening } from '../src/cli/listen-loop.js';
import type { LarkClient, MailChangeHandler } from '../src/client.js';
import { type MailEvent, toMailEvent } from '../src/mail.js';
import type { Dict } from '../src/proto/dict.js';
import { larkType, protoType } from '../src/proto/registry.js';
import { newClient } from './helpers.js';

const T1 = '7000000000000000001';
const T2 = '7000000000000000002';
const M1 = '7000000000000000011';
const M2 = '7000000000000000012';
const M3 = '7000000000000000013';

type Handler = (data: Dict) => Dict | Promise<Dict>;

/** Replace the client's gateway with per-request-type handlers and record every call. */
function fakeApi(c: LarkClient, handlers: Record<string, Handler>): [string, Dict][] {
  const calls: [string, Dict][] = [];
  c.api = async (type, data) => {
    calls.push([String(type), (data ?? {}) as Dict]);
    const h = handlers[String(type)];
    if (!h) throw new Error(`unexpected request: ${String(type)}`);
    return h((data ?? {}) as Dict);
  };
  return calls;
}

const log = (id: number, change: Dict, changeType = 'x'): Dict => ({
  serverChangeId: id,
  changeType,
  change,
});

const received = (id: number, messageId: string, threadId = T1): Dict =>
  log(
    id,
    {
      messageReceivedSummary: {
        meta: { messageBizId: messageId, threadBizId: threadId, labelIds: ['INBOX', 'UNREAD'] },
      },
    },
    'message_receive',
  );

/** Message summary entry as GetMailMessageSummary returns it. */
const summary = (messageId: string, from: Dict, subject = `Subject ${messageId.slice(-2)}`) => ({
  messageBizId: messageId,
  content: { from, subject, bodySummary: 'Preview text' },
});

/**
 * Change log server: MailInitSync without changelog returns the head; with changelog it returns the entries after
 * lastSyncedCommitId, at most `page` at a time.
 */
function changeLogServer(entries: Dict[], page = 100) {
  const state = { entries, page, coldStart: false };
  const head = () => Math.max(0, ...state.entries.map((e) => Number(e.serverChangeId)));
  const handler: Handler = (d) => {
    if (!d.shouldReturnChangeLogs) return { lastChangeId: head() };
    const after = Number(d.lastSyncedCommitId);
    const logs = state.entries
      .filter((e) => Number(e.serverChangeId) > after)
      .sort((a, b) => Number(a.serverChangeId) - Number(b.serverChangeId))
      .slice(0, state.page);
    return {
      lastChangeId: head(),
      coldStart: state.coldStart,
      changeLogResponse: { changeLogs: logs },
    };
  };
  return { state, handler };
}

describe('toMailEvent', () => {
  const kindOf = (key: string) => toMailEvent(log(1, { [key]: {} })).kind;

  test('maps the change key to an event kind', () => {
    const expected: Record<string, string> = {
      messageReceivedSummary: 'received',
      draftSendSummary: 'sent',
      draftSend: 'sent',
      mailSendStatusChange: 'send-status',
      draftCreateOrUpdate: 'draft',
      draftCreateOrUpdateSummary: 'draft',
      draftDelete: 'draft',
      threadModify: 'labels',
      multiThreadsModify: 'labels',
      messageModify: 'labels',
      trashThreads: 'trash',
      messageTrash: 'trash',
      untrashThreads: 'untrash',
      somethingNew: 'other',
    };
    for (const [key, kind] of Object.entries(expected))
      expect([key, kindOf(key)]).toEqual([key, kind]);
    expect(toMailEvent({}).kind).toBe('other');
  });

  test('received mail from others: ids, thread and labels come from meta', () => {
    const raw = received(42, M1);
    const e = toMailEvent(raw);
    expect(e).toEqual({
      changeId: 42,
      kind: 'received',
      type: 'message_receive',
      messageIds: [M1],
      threadIds: [T1],
      labels: ['INBOX', 'UNREAD'],
      added: [],
      removed: [],
      raw,
    });
  });

  test('received mail sent to yourself: priorMeta (the received copy) wins over meta (the sent copy)', () => {
    const e = toMailEvent(
      log(43, {
        messageReceivedSummary: {
          meta: { messageBizId: M1, threadBizId: T1, labelIds: ['SENT'] },
          priorMeta: { messageBizId: M2, threadBizId: T2, labelIds: ['INBOX', 'UNREAD'] },
        },
      }),
    );
    expect(e.messageIds).toEqual([M2]);
    expect(e.threadIds).toEqual([T2]);
    expect(e.labels).toEqual(['INBOX', 'UNREAD']);
  });

  test('priorMeta without a message id is ignored; priorMeta only matters for received mail', () => {
    const withEmptyPrior = toMailEvent(
      log(44, {
        messageReceivedSummary: {
          meta: { messageBizId: M1, threadBizId: T1, labelIds: ['INBOX'] },
          priorMeta: { labelIds: ['SENT'] },
        },
      }),
    );
    expect(withEmptyPrior.messageIds).toEqual([M1]);
    expect(withEmptyPrior.labels).toEqual(['INBOX']);
    const sent = toMailEvent(
      log(45, {
        draftSendSummary: {
          meta: { messageBizId: M1, threadBizId: T1, labelIds: ['SENT'] },
          priorMeta: { messageBizId: M2, threadBizId: T2 },
        },
      }),
    );
    expect(sent.kind).toBe('sent');
    expect(sent.messageIds).toEqual([M1]);
    expect(sent.labels).toEqual(['SENT']);
  });

  test('label changes collect ids from messageBizIds and threadSelector and report added/removed', () => {
    const e = toMailEvent(
      log(
        50,
        {
          multiThreadsModify: {
            threadSelector: [
              { threadBizId: T1, messageBizIds: [M1, M2] },
              { threadBizId: T2, messageBizIds: [M2, M3] },
            ],
            addLabelIds: ['FLAGGED'],
            removeLabelIds: ['UNREAD'],
          },
        },
        'multi_threads_modify',
      ),
    );
    expect(e.kind).toBe('labels');
    expect(e.type).toBe('multi_threads_modify');
    expect(e.messageIds).toEqual([M1, M2, M3]);
    expect(e.threadIds).toEqual([T1, T2]);
    expect(e.added).toEqual(['FLAGGED']);
    expect(e.removed).toEqual(['UNREAD']);
    expect(e.labels).toEqual([]);

    const t = toMailEvent(
      log(51, {
        threadModify: { threadBizId: T1, messageBizIds: [M1], removeLabelIds: ['INBOX'] },
      }),
    );
    expect(t.threadIds).toEqual([T1]);
    expect(t.messageIds).toEqual([M1]);
    expect(t.removed).toEqual(['INBOX']);
  });

  test('changeId accepts bigint / string ids as decoded from protobuf', () => {
    expect(toMailEvent({ serverChangeId: 77n }).changeId).toBe(77);
    expect(toMailEvent({ serverChangeId: '78' }).changeId).toBe(78);
  });
});

describe('client.mail.changesSince', () => {
  test('requests the change log after the cursor and returns events oldest first, enriched', async () => {
    const c = newClient();
    const srv = changeLogServer([
      received(12, M2),
      log(11, { draftSendSummary: { meta: { messageBizId: M1, threadBizId: T1 } } }, 'draft_send'),
      log(10, { threadModify: { threadBizId: T1 } }),
    ]);
    // the server also returns entries at or below the cursor; those are skipped
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': (d) => {
        const r = srv.handler(d) as Dict;
        (r.changeLogResponse as Dict).changeLogs = srv.state.entries;
        return r;
      },
      'mails.GetMailMessageSummaryRequest': (d) => ({
        messageSummaries: (d.messageBizIds as string[]).map((id) =>
          id === M2
            ? summary(id, { name: 'Colleague A', address: 'colleague.a@example.com' })
            : summary(id, { address: 'me@example.com' }),
        ),
      }),
    });
    const r = await c.mail.changesSince(10);
    expect(calls[0]).toEqual([
      'mails.MailInitSyncRequest',
      { lastSyncedCommitId: 10, shouldReturnChangeLogs: true },
    ]);
    expect(r.lastChangeId).toBe(12);
    expect(r.events.map((e) => [e.changeId, e.kind])).toEqual([
      [11, 'sent'],
      [12, 'received'],
    ]);
    expect(r.events[0]).toMatchObject({ from: 'me@example.com', subject: 'Subject 11' });
    expect(r.events[1]).toMatchObject({
      from: 'Colleague A <colleague.a@example.com>',
      subject: 'Subject 12',
      summary: 'Preview text',
    });
    const summaryCalls = calls.filter(([t]) => t === 'mails.GetMailMessageSummaryRequest');
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls.flatMap(([, d]) => d.messageBizIds as string[]).sort()).toEqual([M1, M2]);
  });

  test('no_op entries are dropped but still advance the cursor', async () => {
    const c = newClient();
    const srv = changeLogServer([received(21, M1), log(22, {}, 'no_op'), log(23, {}, 'no_op')]);
    fakeApi(c, { 'mails.MailInitSyncRequest': srv.handler });
    const r = await c.mail.changesSince(20, { enrich: false });
    expect(r.events.map((e) => e.changeId)).toEqual([21]);
    expect(r.lastChangeId).toBe(23);
  });

  test('pages: pulls again from the last id until it reaches lastChangeId', async () => {
    const c = newClient();
    const entries = Array.from({ length: 7 }, (_, i) =>
      received(101 + i, `70000000000000001${i}0`),
    );
    const srv = changeLogServer(entries, 3);
    const calls = fakeApi(c, { 'mails.MailInitSyncRequest': srv.handler });
    const r = await c.mail.changesSince(100, { enrich: false });
    expect(r.events.map((e) => e.changeId)).toEqual([101, 102, 103, 104, 105, 106, 107]);
    expect(r.lastChangeId).toBe(107);
    expect(calls.map(([, d]) => d.lastSyncedCommitId)).toEqual([100, 103, 106]);
  });

  test('no changes: returns no events and the current id', async () => {
    const c = newClient();
    const srv = changeLogServer([received(5, M1)]);
    const calls = fakeApi(c, { 'mails.MailInitSyncRequest': srv.handler });
    expect(await c.mail.changesSince(5)).toEqual({ events: [], lastChangeId: 5 });
    expect(calls).toHaveLength(1);
  });

  test('cold start with no change log returns a single resync event at lastChangeId', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': () => ({ lastChangeId: 900, coldStart: true }),
    });
    const r = await c.mail.changesSince(10);
    expect(r.lastChangeId).toBe(900);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ kind: 'resync', changeId: 900, messageIds: [] });
    // resync events are not enriched
    expect(calls.map(([t]) => t)).toEqual(['mails.MailInitSyncRequest']);
  });

  test('cold start flag without a gap does not produce a resync event', async () => {
    const c = newClient();
    fakeApi(c, { 'mails.MailInitSyncRequest': () => ({ lastChangeId: 10, coldStart: true }) });
    expect((await c.mail.changesSince(10)).events).toEqual([]);
  });

  test('enrich batches summary requests by 30 ids; enrich:false makes no summary call', async () => {
    const entries = Array.from({ length: 65 }, (_, i) =>
      received(1001 + i, `7000000000000${String(1000 + i).padStart(6, '0')}`),
    );
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': changeLogServer(entries).handler,
      'mails.GetMailMessageSummaryRequest': (d) => ({
        messageSummaries: (d.messageBizIds as string[]).map((id) =>
          summary(id, { address: 'colleague.a@example.com' }),
        ),
      }),
    });
    const r = await c.mail.changesSince(1000);
    const sizes = calls
      .filter(([t]) => t === 'mails.GetMailMessageSummaryRequest')
      .map(([, d]) => (d.messageBizIds as string[]).length);
    expect(sizes).toEqual([30, 30, 5]);
    expect(r.events.every((e) => e.from === 'colleague.a@example.com')).toBe(true);

    const c2 = newClient();
    const calls2 = fakeApi(c2, { 'mails.MailInitSyncRequest': changeLogServer(entries).handler });
    const r2 = await c2.mail.changesSince(1000, { enrich: false });
    expect(r2.events).toHaveLength(65);
    expect(r2.events[0]?.subject).toBeUndefined();
    expect(calls2.every(([t]) => t === 'mails.MailInitSyncRequest')).toBe(true);
  });

  test('only received and sent events are enriched', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': changeLogServer([
        log(2, { threadModify: { threadBizId: T1, messageBizIds: [M1] } }),
        log(3, { messageTrash: { messageBizIds: [M2] } }),
      ]).handler,
    });
    const r = await c.mail.changesSince(1);
    expect(r.events.map((e) => e.kind)).toEqual(['labels', 'trash']);
    expect(calls.every(([t]) => t === 'mails.MailInitSyncRequest')).toBe(true);
  });
});

describe('client.mail.watch', () => {
  const watchers: { stop(): void }[] = [];
  afterEach(() => {
    for (const w of watchers.splice(0)) w.stop();
  });

  test('without fromChangeId starts at the current head, so old changes are not reported', async () => {
    const c = newClient();
    const srv = changeLogServer([received(1, M1), received(2, M2)]);
    const calls = fakeApi(c, { 'mails.MailInitSyncRequest': srv.handler });
    const got: MailEvent[] = [];
    const w = await c.mail.watch((e) => void got.push(e), { enrich: false, pollMs: 1e9 });
    watchers.push(w);
    expect(calls).toEqual([['mails.MailInitSyncRequest', {}]]);
    expect(w.changeId).toBe(2);
    await w.trigger();
    expect(got).toEqual([]);
    srv.state.entries.push(received(3, M3));
    await w.trigger();
    expect(got.map((e) => e.changeId)).toEqual([3]);
    expect(w.changeId).toBe(3);
  });

  test('trigger delivers events in order exactly once', async () => {
    const c = newClient();
    const srv = changeLogServer([received(11, M1), received(12, M2)]);
    const calls = fakeApi(c, { 'mails.MailInitSyncRequest': srv.handler });
    const got: number[] = [];
    const w = await c.mail.watch((e) => void got.push(e.changeId), {
      fromChangeId: 10,
      enrich: false,
      pollMs: 1e9,
    });
    watchers.push(w);
    expect(calls).toHaveLength(0);
    await w.trigger();
    await w.trigger();
    srv.state.entries.push(received(13, M3), log(14, {}, 'no_op'));
    await w.trigger();
    expect(got).toEqual([11, 12, 13]);
    expect(w.changeId).toBe(14);
  });

  test('overlapping triggers coalesce: a trigger during a pull causes exactly one more pull', async () => {
    const c = newClient();
    const srv = changeLogServer([received(11, M1)]);
    let release: () => void = () => {};
    let gate: Promise<void> | null = new Promise((r) => {
      release = r;
    });
    let pulls = 0;
    fakeApi(c, {
      'mails.MailInitSyncRequest': async (d) => {
        pulls++;
        if (gate) {
          const g = gate;
          gate = null;
          await g;
        }
        return srv.handler(d);
      },
    });
    const got: number[] = [];
    const w = await c.mail.watch((e) => void got.push(e.changeId), {
      fromChangeId: 10,
      enrich: false,
      pollMs: 1e9,
    });
    watchers.push(w);
    const first = w.trigger();
    await Promise.resolve();
    srv.state.entries.push(received(12, M2));
    const others = [w.trigger(), w.trigger(), w.trigger()];
    release();
    await Promise.all([first, ...others]);
    expect(pulls).toBe(2);
    expect(got).toEqual([11, 12]);
  });

  test('the poll timer pulls; stop clears the interval and prevents further delivery', async () => {
    const intervals: { fn: () => void; ms: number | undefined }[] = [];
    const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      intervals.push({ fn, ms });
      return 4242;
    }) as unknown as typeof setInterval);
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      const c = newClient();
      const srv = changeLogServer([received(11, M1)]);
      const calls = fakeApi(c, { 'mails.MailInitSyncRequest': srv.handler });
      const got: number[] = [];
      const w = await c.mail.watch((e) => void got.push(e.changeId), {
        fromChangeId: 10,
        enrich: false,
        pollMs: 5000,
      });
      expect(intervals).toHaveLength(1);
      expect(intervals[0]?.ms).toBe(5000);
      intervals[0]?.fn();
      await w.trigger(); // joins the timer's pull
      expect(got).toEqual([11]);
      w.stop();
      expect(clearSpy).toHaveBeenCalledWith(4242);
      srv.state.entries.push(received(12, M2));
      const before = calls.length;
      intervals[0]?.fn();
      await w.trigger();
      expect(calls.length).toBe(before);
      expect(got).toEqual([11]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test('default poll interval is 30 seconds', async () => {
    const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((_fn: () => void, _ms?: number) => 1) as unknown as typeof setInterval,
    );
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      const c = newClient();
      fakeApi(c, {});
      const w = await c.mail.watch(() => {}, { fromChangeId: 1 });
      w.stop();
      expect(setSpy.mock.calls[0]?.[1]).toBe(30_000);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test('a failing pull calls onError and the next trigger works', async () => {
    const c = newClient();
    const srv = changeLogServer([received(11, M1)]);
    let fail = true;
    fakeApi(c, {
      'mails.MailInitSyncRequest': (d) => {
        if (fail) {
          fail = false;
          throw new Error('gateway unavailable');
        }
        return srv.handler(d);
      },
    });
    const errors: string[] = [];
    const got: number[] = [];
    const w = await c.mail.watch((e) => void got.push(e.changeId), {
      fromChangeId: 10,
      enrich: false,
      pollMs: 1e9,
      onError: (e) => errors.push(e.message),
    });
    watchers.push(w);
    await w.trigger();
    expect(errors).toEqual(['gateway unavailable']);
    expect(got).toEqual([]);
    await w.trigger();
    expect(got).toEqual([11]);
    expect(errors).toHaveLength(1);
  });

  test('a throwing handler is reported and the event is redelivered on the next pull', async () => {
    const c = newClient();
    fakeApi(c, {
      'mails.MailInitSyncRequest': changeLogServer([received(11, M1), received(12, M2)]).handler,
    });
    const errors: string[] = [];
    const got: number[] = [];
    let failOn12 = true;
    const w = await c.mail.watch(
      (e) => {
        if (e.changeId === 12 && failOn12) {
          failOn12 = false;
          throw new Error('handler failed');
        }
        got.push(e.changeId);
      },
      { fromChangeId: 10, enrich: false, pollMs: 1e9, onError: (e) => errors.push(e.message) },
    );
    watchers.push(w);
    await w.trigger();
    expect(errors).toEqual(['handler failed']);
    expect(w.changeId).toBe(11);
    await w.trigger();
    expect(got).toEqual([11, 12]);
  });

  test('stop during delivery prevents the remaining events', async () => {
    const c = newClient();
    fakeApi(c, {
      'mails.MailInitSyncRequest': changeLogServer([received(11, M1), received(12, M2)]).handler,
    });
    const got: number[] = [];
    let w: { stop(): void; trigger(): Promise<void> } | undefined;
    w = await c.mail.watch(
      (e) => {
        got.push(e.changeId);
        w?.stop();
      },
      { fromChangeId: 10, enrich: false, pollMs: 1e9 },
    );
    watchers.push(w);
    await w.trigger();
    expect(got).toEqual([11]);
  });
});

describe('mail change pushes over the long connection', () => {
  const mailFrame = () => {
    const desc = larkType('mailchanges.MailProcessedChangePushRequest');
    const payload = toBinary(
      desc,
      create(desc, {
        changeLog: {
          serverChangeId: 501n,
          changeType: 'message_receive',
          change: {
            change: {
              case: 'messageReceivedSummary',
              value: { meta: { messageBizId: M1, threadBizId: T1, labelIds: ['INBOX'] } },
            },
          },
        },
      } as Record<string, unknown>),
    );
    const packet = create(protoType('Packet'), { sid: 'sid-7', cmd: 3603, payload } as Record<
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

  test('push cmd=3603 decodes the change log and hands it to onMailChange', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(mailFrame());
          setTimeout(() => ws.close(1000), 50);
        },
        message() {},
      },
    });
    try {
      const c = newClient();
      c.buildWsUrl = async () => `ws://localhost:${server.port}`;
      const got: Dict[] = [];
      const messages: unknown[] = [];
      await c.connectWebsocket(
        async (m) => void messages.push(m),
        undefined,
        undefined,
        undefined,
        async (changeLog) => void got.push(changeLog),
      );
      expect(messages).toEqual([]);
      expect(got).toHaveLength(1);
      const e = toMailEvent(got[0] as Dict);
      expect(e).toMatchObject({
        changeId: 501,
        kind: 'received',
        type: 'message_receive',
        messageIds: [M1],
        threadIds: [T1],
        labels: ['INBOX'],
      });
    } finally {
      server.stop(true);
    }
  });
});

describe('keepListening and mail changes', () => {
  test('onConnected runs after every (re)connect and onMailChange is passed to connectWebsocket', async () => {
    const c = newClient();
    const abort = new AbortController();
    const handler: MailChangeHandler = () => {};
    const passed: unknown[] = [];
    let connects = 0;
    let connected = 0;
    c.connectWebsocket = async (_onMessage, _signal, onOpen, _onReaction, onMailChange) => {
      connects++;
      passed.push(onMailChange);
      onOpen?.();
      if (connects === 1) throw new Error('dropped');
      if (connects === 3) abort.abort();
    };
    await keepListening(c, async () => {}, {
      retryMs: 1,
      signal: abort.signal,
      missed: async () => [],
      onMailChange: handler,
      onConnected: () => connected++,
    });
    expect(connects).toBe(3);
    expect(connected).toBe(3);
    expect(passed).toEqual([handler, handler, handler]);
  });
});
