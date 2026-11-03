import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient } from '../src/client.js';
import { HttpError } from '../src/http.js';
import {
  adler32,
  htmlToText,
  MAIL_METHOD_PERMISSIONS,
  textToHtml,
  toMailMessage,
} from '../src/mail.js';
import { PERMISSIONS, PermissionDenied } from '../src/permissions.js';
import type { Dict } from '../src/proto/dict.js';
import { urls } from '../src/region.js';
import { newClient } from './helpers.js';

const ME = 'me@example.com';
const ME_ALIAS = 'me.alias@example.com';
const PEER = 'colleague.a@example.org';
const OTHER = 'colleague.b@example.org';
const T1 = '7000000000000000001';
const T2 = '7000000000000000002';
const M1 = '7000000000000000011';
const M2 = '7000000000000000012';
const M3 = '7000000000000000013';
const M4 = '7000000000000000014';

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

const settings: Handler = () => ({
  setting: {
    emailAlias: {
      defaultAddress: {
        name: 'Me',
        address: ME,
        larkEntityId: '7100000000000000009',
        larkEntityType: 1,
      },
      allAddresses: [
        { name: 'Me', address: ME },
        { name: 'Me', address: ME_ALIAS },
      ],
    },
  },
});

/** Change log that hands out increasing server change ids and a send summary for draftSend. */
function changeLog(start = 100): Handler {
  let id = start;
  return (d) => {
    id += 1;
    const change = d.change as Dict;
    return {
      changeLog: {
        serverChangeId: id,
        change: change.draftSend
          ? { draftSendSummary: { meta: { messageBizId: M3, threadBizId: T2 } } }
          : {},
      },
    };
  };
}

const changes = (calls: [string, Dict][]) =>
  calls.filter(([t]) => t === 'mailchanges.MailAddChangeRequest').map(([, d]) => d);

/** Full-message response entry as GetMailMessageFullByMessageIDs returns it. */
const full = (meta: Dict, content: Dict): Dict => ({
  meta,
  content: { messageBizId: meta.messageBizId, content },
});

describe('mail helpers', () => {
  test('adler32 matches the known value for "Wikipedia"', () => {
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe('300286872');
    expect(adler32(new Uint8Array())).toBe('1');
  });

  test('adler32 handles input longer than one 5552-byte chunk', () => {
    const reference = (data: Uint8Array) => {
      let a = 1;
      let b = 0;
      for (const x of data) {
        a = (a + x) % 65521;
        b = (b + a) % 65521;
      }
      return String(b * 65536 + a);
    };
    for (const size of [5551, 5552, 5553, 100_000]) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = 255 - (i % 7);
      expect(adler32(data)).toBe(reference(data));
    }
  });

  test('textToHtml escapes HTML, linkifies URLs and keeps empty lines', () => {
    const html = textToHtml('a <b> & "c"\nsee https://example.com/x?a=1&b=2\n');
    expect(html).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
    expect(html).toContain(
      '<a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://example.com/x?a=1&amp;b=2</a>',
    );
    expect(html.match(/<div style="font-size: 14px;">/g)).toHaveLength(3);
    expect(html).toContain('<div style="font-size: 14px;"><br></div>');
    expect(html).not.toContain('<b>');
  });

  test('htmlToText round-trips textToHtml and handles basic markup', () => {
    const text = 'Hello <world> & "friends"\nsee https://example.com/a';
    // Each line becomes two nested divs, so line breaks come back doubled; the content survives
    expect(htmlToText(textToHtml('Hello <world> & "friends"'))).toBe('Hello <world> & "friends"');
    expect(htmlToText(textToHtml(text)).split(/\n+/)).toEqual(text.split('\n'));
    expect(htmlToText('<p>One&nbsp;two</p><p>three<br>four</p><ul><li>x</li></ul>')).toBe(
      'One two\nthree\nfour\nx',
    );
    expect(htmlToText('a<br><br><br><br>b')).toBe('a\n\nb');
  });

  test('toMailMessage maps meta and content and converts timestamp units', () => {
    const m = toMailMessage(
      {
        messageBizId: M1,
        threadBizId: T1,
        labelIds: ['INBOX', 'UNREAD'],
        createdTime: { unit: 1, value: 1_790_000_000 },
      },
      {
        replyToMessageBizId: M2,
        content: {
          from: { displayName: 'Colleague A', address: PEER },
          to: [{ name: 'Me', address: ME }],
          subject: 'Weekly report',
          bodyPlaintext: 'body',
          attachments: [{ fileName: 'a.txt', fileKey: 'box_0001', fileSize: '12' }],
        },
      },
    );
    expect(m).toMatchObject({
      messageId: M1,
      threadId: T1,
      replyTo: M2,
      labels: ['INBOX', 'UNREAD'],
      draft: false,
      createdAt: 1_790_000_000_000,
      from: { name: 'Colleague A', address: PEER },
      to: [{ name: 'Me', address: ME }],
      cc: [],
      summary: 'body',
      attachments: [{ name: 'a.txt', fileKey: 'box_0001', size: 12 }],
    });
    expect(toMailMessage({ createdTime: { unit: 3, value: 5_000_000 } }, null).createdAt).toBe(
      5000,
    );
    expect(toMailMessage({ createdTime: { unit: 4, value: 5_000_000_000 } }, null).createdAt).toBe(
      5000,
    );
  });
});

describe('mail reads', () => {
  test('threads(): pages newest first, then older than the last thread, stops on hasMore false', async () => {
    const c = newClient();
    const pages: Dict[] = [
      {
        hasMore: true,
        threads: [
          {
            threadBizId: T1,
            sortTimestamp: '2000',
            messages: [
              { messageBizId: M1, labelIds: ['INBOX', 'UNREAD'] },
              { messageBizId: M2, labelIds: ['SENT'] },
            ],
          },
        ],
      },
      {
        hasMore: false,
        threads: [
          {
            threadBizId: T2,
            sortTimestamp: '1000',
            messages: [{ messageBizId: M3, labelIds: ['INBOX'] }],
          },
        ],
      },
    ];
    const calls = fakeApi(c, {
      'mails.GetMailThreadMetaRequest': () => pages.shift() as Dict,
      'mails.GetMailMessageSummaryRequest': (d) => ({
        messageSummaries: (d.messageBizIds as string[]).map((id) => ({
          messageBizId: id,
          content: { subject: `subject ${id.slice(-2)}`, from: { address: PEER } },
        })),
      }),
      'mails.GetThreadMetaByThreadIDsRequest': () => ({
        metas: [
          {
            threadBizId: T1,
            messages: [
              { messageBizId: M1, threadBizId: T1, createdTime: { unit: 2, value: 1000 } },
              { messageBizId: M2, threadBizId: T1, createdTime: { unit: 2, value: 2000 } },
              // A newer draft must not become the latest message
              {
                messageBizId: '7000000000000000019',
                threadBizId: T1,
                isDraft: true,
                createdTime: { unit: 2, value: 3000 },
              },
            ],
          },
          {
            threadBizId: T2,
            messages: [{ messageBizId: M3, threadBizId: T2, createdTime: { unit: 2, value: 500 } }],
          },
        ],
      }),
    });
    const got = await c.mail.threads('INBOX', { limit: 10 });
    const listCalls = calls
      .filter(([t]) => t === 'mails.GetMailThreadMetaRequest')
      .map(([, d]) => d);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]).toMatchObject({
      labelId: 'INBOX',
      pageSize: 10,
      requestParams: { timestampOperator: 1, timestamp: 0, orderBy: 2 },
    });
    expect(listCalls[1]).toMatchObject({
      pageSize: 9,
      requestParams: { timestampOperator: 3, timestamp: 2000 },
    });
    expect(got.map((t) => [t.threadId, t.messageIds, t.unread, t.updatedAt])).toEqual([
      [T1, [M1, M2], true, 2000],
      [T2, [M3], false, 1000],
    ]);
    expect(got[0]?.labels).toEqual(['INBOX', 'UNREAD', 'SENT']);
    expect(got[0]?.latest).toMatchObject({ messageId: M2, subject: 'subject 12', draft: false });
    expect(got[1]?.latest?.messageId).toBe(M3);
  });

  test('threads(): before continues an earlier listing and an empty page stops', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.GetMailThreadMetaRequest': () => ({ hasMore: true, threads: [] }),
    });
    expect(await c.mail.threads('SENT', { before: 1234 })).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      labelId: 'SENT',
      requestParams: { timestampOperator: 3, timestamp: 1234 },
    });
  });

  test('threads(): summaries are fetched at most 30 ids per request (server limit)', async () => {
    const c = newClient();
    const ids = Array.from(
      { length: 35 },
      (_, i) => `70000000000000001${String(i).padStart(2, '0')}`,
    );
    const sizes: number[] = [];
    fakeApi(c, {
      'mails.GetMailThreadMetaRequest': () => ({
        hasMore: false,
        threads: ids.map((id, i) => ({
          threadBizId: id,
          sortTimestamp: String(10_000 - i),
          messages: [{ messageBizId: id, labelIds: ['TRASH'] }],
        })),
      }),
      'mails.GetMailMessageSummaryRequest': (d) => {
        sizes.push((d.messageBizIds as string[]).length);
        return { messageSummaries: [] };
      },
      'mails.GetThreadMetaByThreadIDsRequest': () => ({ metas: [] }),
    });
    expect((await c.mail.threads('TRASH', { limit: 35 })).length).toBe(35);
    expect(sizes).toEqual([30, 5]);
  });

  test('thread(): full messages oldest first, including copies found by subject search', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.GetThreadMetaByThreadIDsRequest': (d) => ({
        metas: (d.threadBizIds as string[]).includes(T1)
          ? [{ threadBizId: T1, messages: [{ messageBizId: M2 }, { messageBizId: M1 }] }]
          : [],
      }),
      'mails.GetMailMessageSummaryRequest': () => ({
        messageSummaries: [{ messageBizId: M2, content: { subject: 'Re: a' } }],
      }),
      'mails.MailAdvancedSearchRequest': (d) => ({
        msgSummary: d.label === 'TRASH' ? [{ messageId: M4, threadId: T1 }] : [],
      }),
      'mails.GetMailMessageFullByMessageIDsRequest': () => ({
        messages: [
          full(
            { messageBizId: M1, threadBizId: T1, createdTime: { unit: 2, value: 1 } },
            { subject: 'a', bodyPlaintext: 'x' },
          ),
          full(
            { messageBizId: M2, threadBizId: T1, createdTime: { unit: 2, value: 2 } },
            { subject: 'Re: a' },
          ),
          full(
            { messageBizId: M4, threadBizId: T1, createdTime: { unit: 2, value: 3 } },
            { subject: 'Re: a', bodyPlaintext: 'trashed copy' },
          ),
        ],
      }),
    });
    expect((await c.mail.thread(T1)).map((m) => [m.messageId, m.text])).toEqual([
      [M1, 'x'],
      [M2, ''],
      [M4, 'trashed copy'],
    ]);
    // thread() includes the trash
    expect(
      calls.filter(([t]) => t === 'mails.MailAdvancedSearchRequest').map(([, d]) => d.label),
    ).toEqual(['', 'TRASH']);
    await expect(c.mail.thread(T2)).rejects.toThrow(`Mail thread not found: ${T2}`);
  });

  test('threadMembers(): adds subject-search hits from the same thread only, Re:/Fw: stripped', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.GetThreadMetaByThreadIDsRequest': () => ({
        metas: [
          { threadBizId: T1, messages: [{ messageBizId: M1 }] },
          { threadBizId: T2, messages: [{ messageBizId: M3 }] },
        ],
      }),
      'mails.GetMailMessageSummaryRequest': () => {
        return {
          messageSummaries: [
            { messageBizId: M1, content: { subject: 'Re: FW:  Project update' } },
            // Nothing left after stripping: no search for this thread
            { messageBizId: M3, content: { subject: 'Re:' } },
          ],
        };
      },
      'mails.MailAdvancedSearchRequest': (d) => ({
        msgSummary:
          d.label === 'TRASH'
            ? [{ messageId: M4, threadId: T1 }]
            : [
                { messageId: M1, threadId: T1 },
                { messageId: M2, threadId: T1 },
                // Same subject in another conversation: ignored
                { messageId: '7000000000000000015', threadId: T2 },
              ],
      }),
    });
    const members = await c.mail.threadMembers([T1, T2]);
    expect([...members]).toEqual([
      [T1, [M1, M2]],
      [T2, [M3]],
    ]);
    const searches = calls
      .filter(([t]) => t === 'mails.MailAdvancedSearchRequest')
      .map(([, d]) => [d.keyword, d.label]);
    expect(searches).toEqual([['Project update', '']]);
    // One batched summary request with the first message of each thread
    expect(
      calls
        .filter(([t]) => t === 'mails.GetMailMessageSummaryRequest')
        .map(([, d]) => d.messageBizIds),
    ).toEqual([[M1, M3]]);

    calls.length = 0;
    expect((await c.mail.threadMembers([T1], true)).get(T1)).toEqual([M1, M2, M4]);
    expect(
      calls.filter(([t]) => t === 'mails.MailAdvancedSearchRequest').map(([, d]) => d.label),
    ).toEqual(['', 'TRASH']);
  });
});

describe('mail search and listing', () => {
  const hit = (id: string, over: Dict = {}): Dict => ({
    messageId: id,
    threadId: T1,
    subjectSummary: `subject ${id.slice(-2)}`,
    bodyPlaintextSummary: 'summary',
    from: PEER,
    createdTimestamp: { unit: 2, value: Number(id.slice(-2)) * 1000 },
    messageLabels: ['INBOX'],
    ...over,
  });

  test('search(): message mode, pages with session and offset, maps and sorts hits', async () => {
    const c = newClient();
    const pages: Dict[] = [
      {
        hasMore: true,
        searchSession: 'session-1',
        msgSummary: [
          hit(M1, {
            subjectSummary: '<em>Weekly</em> report',
            bodyPlaintextSummary: 'see <b>attached</b> <span class="hl">notes</span>',
            messageLabels: ['INBOX', 'UNREAD'],
            hasAttachment: true,
          }),
          hit(M3, { messageLabels: undefined, labels: ['SENT'] }),
        ],
      },
      { hasMore: false, searchSession: 'session-1', msgSummary: [hit(M2)] },
    ];
    const calls = fakeApi(c, { 'mails.MailAdvancedSearchRequest': () => pages.shift() as Dict });
    const got = await c.mail.search('report', {
      label: 'INBOX',
      from: [PEER],
      since: 1_790_000_000_500,
      until: 1_790_100_000_900,
      limit: 10,
    });
    const reqs = calls.map(([, d]) => d);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({
      keyword: 'report',
      fromList: [PEER],
      label: 'INBOX',
      startDate: 1_790_000_000,
      endDate: 1_790_100_000,
      isConversationModeEnable: false,
      pageSize: 50,
      searchSession: '',
      offset: 0,
    });
    expect(reqs[0]).not.toHaveProperty('folder');
    expect(reqs[0]).not.toHaveProperty('isFolderEnabled');
    expect(reqs[1]).toMatchObject({ searchSession: 'session-1', offset: 2 });
    // Newest first by createdAt
    expect(got.map((h) => h.messageId)).toEqual([M3, M2, M1]);
    expect(got[2]).toEqual({
      messageId: M1,
      threadId: T1,
      subject: 'Weekly report',
      summary: 'see attached notes',
      from: PEER,
      createdAt: 11_000,
      labels: ['INBOX', 'UNREAD'],
      unread: true,
      hasAttachment: true,
    });
    expect(got[0]).toMatchObject({ labels: ['SENT'], unread: false, hasAttachment: false });
  });

  test('search(): results are cut to limit; no time range sends zero dates', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.MailAdvancedSearchRequest': () => ({
        hasMore: true,
        msgSummary: [hit(M1), hit(M3), hit(M2)],
      }),
    });
    const got = await c.mail.search('', { limit: 2 });
    expect(got.map((h) => h.messageId)).toEqual([M3, M2]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({ keyword: '', label: '', startDate: 0, endDate: 0 });
  });

  test('search(): folder sends folder + isFolderEnabled instead of a label', async () => {
    const c = newClient();
    const calls = fakeApi(c, { 'mails.MailAdvancedSearchRequest': () => ({ msgSummary: [] }) });
    expect(await c.mail.search('', { folder: '7300000000000000002' })).toEqual([]);
    expect(calls[0]?.[1]).toMatchObject({
      folder: '7300000000000000002',
      isFolderEnabled: true,
      label: '',
    });
  });

  test('search(): unreadOnly filters client-side and keeps paging until enough matches', async () => {
    const c = newClient();
    const pages: Dict[] = [
      { hasMore: true, msgSummary: [hit(M1), hit(M2, { messageLabels: ['UNREAD'] }), hit(M3)] },
      { hasMore: true, msgSummary: [hit(M4, { messageLabels: ['INBOX', 'UNREAD'] })] },
      { hasMore: true, msgSummary: [hit('7000000000000000019')] },
    ];
    const calls = fakeApi(c, { 'mails.MailAdvancedSearchRequest': () => pages.shift() as Dict });
    const got = await c.mail.search('', { unreadOnly: true, limit: 2 });
    expect(got.map((h) => h.messageId)).toEqual([M4, M2]);
    expect(got.every((h) => h.unread)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  const labelList: Handler = () => ({
    coldStart: {
      mailUnreadCount: { INBOX: '3', '7300000000000000001': 1 },
      labelList: {
        systemLabels: [{ id: 'INBOX', name: 'Inbox', totalCount: '10' }],
        userLabels: [{ id: '7300000000000000001', name: 'Project team' }],
        userFolders: [{ id: '7300000000000000002', nodeName: 'Receipts' }],
      },
    },
  });

  test('labels(): system, user labels and folders with counts', async () => {
    const c = newClient();
    fakeApi(c, { 'mails.MailInitSyncRequest': labelList });
    expect(await c.mail.labels()).toEqual([
      { id: 'INBOX', name: 'Inbox', kind: 'system', unread: 3, total: 10 },
      { id: '7300000000000000001', name: 'Project team', kind: 'label', unread: 1, total: 0 },
      { id: '7300000000000000002', name: 'Receipts', kind: 'folder', unread: 0, total: 0 },
    ]);
  });

  test('resolveTarget(): system names, user labels and folders by name or id; unknown names throw', async () => {
    const c = newClient();
    const calls = fakeApi(c, { 'mails.MailInitSyncRequest': labelList });
    expect(await c.mail.resolveTarget('inbox')).toEqual({ id: 'INBOX', folder: false });
    expect(await c.mail.resolveTarget(' Trash ')).toEqual({ id: 'TRASH', folder: false });
    expect(await c.mail.resolveTarget('FLAGGED')).toEqual({ id: 'FLAGGED', folder: false });
    // System names never need the label list
    expect(calls).toHaveLength(0);
    expect(await c.mail.resolveTarget('project TEAM')).toEqual({
      id: '7300000000000000001',
      folder: false,
    });
    expect(await c.mail.resolveTarget('receipts')).toEqual({
      id: '7300000000000000002',
      folder: true,
    });
    expect(await c.mail.resolveTarget('7300000000000000002')).toEqual({
      id: '7300000000000000002',
      folder: true,
    });
    // An unknown numeric id is passed through as a label id
    expect(await c.mail.resolveTarget('7300000000000000009')).toEqual({
      id: '7300000000000000009',
      folder: false,
    });
    await expect(c.mail.resolveTarget('No such label')).rejects.toThrow(
      'Unknown mail label or folder: No such label',
    );
    expect(await c.mail.resolveLabel('Receipts')).toBe('7300000000000000002');
  });

  test('list(): searches everything under a label or folder', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': labelList,
      'mails.MailAdvancedSearchRequest': () => ({
        msgSummary: [hit(M1, { messageLabels: ['INBOX', 'UNREAD'] }), hit(M2)],
      }),
    });
    const searches = () =>
      calls.filter(([t]) => t === 'mails.MailAdvancedSearchRequest').map(([, d]) => d);

    expect((await c.mail.list()).map((h) => h.messageId)).toEqual([M2, M1]);
    expect(searches()[0]).toMatchObject({ keyword: '', label: 'INBOX', endDate: 0 });
    expect(searches()[0]).not.toHaveProperty('folder');

    calls.length = 0;
    const got = await c.mail.list('Receipts', {
      limit: 5,
      until: 1_790_000_000_000,
      unreadOnly: true,
    });
    expect(got.map((h) => h.messageId)).toEqual([M1]);
    expect(searches()[0]).toMatchObject({
      keyword: '',
      label: '',
      folder: '7300000000000000002',
      isFolderEnabled: true,
      endDate: 1_790_000_000,
    });

    calls.length = 0;
    await c.mail.list('Project team');
    expect(searches()[0]).toMatchObject({ label: '7300000000000000001' });
    expect(searches()[0]).not.toHaveProperty('folder');
  });
});

/**
 * Fake mailbox: message id → thread and labels. Label changes from the change log are applied to the listed message
 * ids right away (so the re-read after a write sees the new state), except for ids in `stuck`.
 */
function mailbox(init: Record<string, [thread: string, labels: string[]]>, stuck: string[] = []) {
  const state = new Map(
    Object.entries(init).map(([id, [thread, labels]]) => [id, { thread, labels: [...labels] }]),
  );
  const log = changeLog();
  const edit = (sel: unknown, add: unknown, remove: unknown) => {
    for (const s of sel as Dict[])
      for (const id of s.messageBizIds as string[]) {
        const m = state.get(id);
        if (!m || stuck.includes(id)) continue;
        const rm = (remove ?? []) as string[];
        m.labels = [
          ...new Set([...m.labels.filter((l) => !rm.includes(l)), ...((add ?? []) as string[])]),
        ];
      }
  };
  const handlers: Record<string, Handler> = {
    'mails.MailInitSyncRequest': () => ({ lastChangeId: '1' }),
    'mails.GetMailMessageFullByMessageIDsRequest': (d) => ({
      messages: (d.messageBizIds as string[]).flatMap((id) => {
        const m = state.get(id);
        return m
          ? [full({ messageBizId: id, threadBizId: m.thread, labelIds: [...m.labels] }, {})]
          : [];
      }),
    }),
    'mailchanges.MailAddChangeRequest': (d) => {
      const ch = d.change as Dict;
      const tm = ch.threadModify as Dict | undefined;
      if (tm) edit([tm], tm.addLabelIds, tm.removeLabelIds);
      const mm = ch.multiThreadsModify as Dict | undefined;
      if (mm) {
        const add = mm.addLabelIds as string[];
        // Like the server: archiving leaves the inbox, moving to the inbox leaves the archive
        const implied = add.includes('ARCHIVED')
          ? ['INBOX']
          : add.includes('INBOX')
            ? ['ARCHIVED']
            : [];
        edit(mm.threadSelector, add, [...(mm.removeLabelIds as string[]), ...implied]);
      }
      if (ch.trashThreads) edit((ch.trashThreads as Dict).threadSelector, ['TRASH'], []);
      if (ch.untrashThreads) edit((ch.untrashThreads as Dict).threadSelector, [], ['TRASH']);
      return log(d);
    },
  };
  return { state, handlers };
}

/** Run timers immediately and record their delays (the write verification waits between re-reads). */
function instantTimers() {
  const delays: number[] = [];
  const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  return { delays, restore: () => spy.mockRestore() };
}

describe('mail writes', () => {
  const L1 = '7300000000000000001';
  // M1 and M2 in thread T1, M3 in T2; M4 is another message of T1 that is never targeted
  const box = (stuck: string[] = []) =>
    mailbox(
      {
        [M1]: [T1, ['INBOX', 'UNREAD']],
        [M2]: [T1, ['INBOX', 'UNREAD']],
        [M3]: [T2, ['INBOX', 'UNREAD']],
        [M4]: [T1, ['INBOX', 'UNREAD']],
      },
      stuck,
    );
  let timers: ReturnType<typeof instantTimers>;
  beforeEach(() => {
    timers = instantTimers();
  });
  afterEach(() => timers.restore());

  test('the first change syncs, later changes carry the previous serverChangeId', async () => {
    const c = newClient();
    const { handlers } = box();
    const calls = fakeApi(c, {
      ...handlers,
      'mails.MailInitSyncRequest': () => ({ lastChangeId: '42' }),
    });
    await c.mail.flag([M1]);
    await c.mail.flag([M1], false);
    expect(calls.filter(([t]) => t === 'mails.MailInitSyncRequest')).toHaveLength(1);
    const sent = changes(calls);
    expect(sent.map((d) => (d.meta as Dict).lastSyncedServerChangeId)).toEqual([42, 101]);
    expect(typeof ((sent[0] as Dict).meta as Dict).clientTimestampMs).toBe('number');
    expect(sent[0]?.uuid).not.toBe(sent[1]?.uuid);
  });

  test('"user inbox out of sync" resyncs once and retries; a second failure is thrown', async () => {
    const c = newClient();
    let syncs = 0;
    let failures = 1;
    const outOfSync = () => new HttpError(400, 'Bad Request', 'gateway', 'user inbox out of sync');
    const { handlers } = box();
    const apply = handlers['mailchanges.MailAddChangeRequest'] as Handler;
    const calls = fakeApi(c, {
      ...handlers,
      'mails.MailInitSyncRequest': () => ({ lastChangeId: String(10 + syncs++) }),
      'mailchanges.MailAddChangeRequest': (d) => {
        if (failures-- > 0) throw outOfSync();
        return apply(d);
      },
    });
    expect(await c.mail.archive([M1])).toEqual({ messageIds: [M1], failed: [] });
    expect(changes(calls).map((d) => (d.meta as Dict).lastSyncedServerChangeId)).toEqual([10, 11]);

    failures = Number.POSITIVE_INFINITY;
    calls.length = 0;
    const err = await c.mail.archive([M1]).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).reason).toContain('out of sync');
    expect(changes(calls)).toHaveLength(2);
    expect(calls.filter(([t]) => t === 'mails.MailInitSyncRequest')).toHaveLength(1);
  });

  test('other HTTP errors are not retried; a reply without changeLog is an error', async () => {
    const c = newClient();
    let reply: () => Dict = () => {
      throw new HttpError(500, 'Server Error', 'gateway', 'boom');
    };
    const calls = fakeApi(c, {
      ...box().handlers,
      'mailchanges.MailAddChangeRequest': () => reply(),
    });
    await expect(c.mail.flag([M1])).rejects.toBeInstanceOf(HttpError);
    expect(changes(calls)).toHaveLength(1);
    reply = () => ({});
    await expect(c.mail.flag([M1])).rejects.toThrow('Mail change rejected');
  });

  test('changes list exactly the given messages, grouped into one selector per thread', async () => {
    const c = newClient();
    const calls = fakeApi(c, box().handlers);
    const sel = [
      { threadBizId: T1, messageBizIds: [M1, M2] },
      { threadBizId: T2, messageBizIds: [M3] },
    ];
    const multi = (add: string[], remove: string[]) => ({
      multiThreadsModify: {
        threadSelector: sel,
        addLabelIds: add,
        removeLabelIds: remove,
        isFromSearch: true,
      },
    });
    const ids = [M1, M3, M2];

    await c.mail.markRead(ids);
    await c.mail.markRead([M1], false);
    await c.mail.flag(ids);
    await c.mail.flag(ids, false);
    await c.mail.archive(ids);
    await c.mail.archive(ids, false);
    await c.mail.modify(ids, { add: [L1], remove: ['INBOX'] });
    await c.mail.trash(ids);
    await c.mail.trash(ids, false);

    expect(changes(calls).map((d) => d.change)).toEqual([
      { threadModify: { ...sel[0], removeLabelIds: ['UNREAD'] } },
      { threadModify: { ...sel[1], removeLabelIds: ['UNREAD'] } },
      { threadModify: { threadBizId: T1, messageBizIds: [M1], addLabelIds: ['UNREAD'] } },
      multi(['FLAGGED'], []),
      multi([], ['FLAGGED']),
      multi(['ARCHIVED'], []),
      multi(['INBOX'], []),
      multi([L1], ['INBOX']),
      { trashThreads: { threadSelector: sel, isFromSearch: true } },
      { untrashThreads: { threadSelector: sel } },
    ]);
  });

  test('success: the result lists every message and nothing waits when the state is already there', async () => {
    const c = newClient();
    const { state, handlers } = box();
    const calls = fakeApi(c, handlers);
    expect(await c.mail.markRead([M1, M2, M3])).toEqual({ messageIds: [M1, M2, M3], failed: [] });
    expect(state.get(M1)?.labels).toEqual(['INBOX']);
    // The untargeted message of the same thread is left alone
    expect(state.get(M4)?.labels).toEqual(['INBOX', 'UNREAD']);
    expect(timers.delays).toEqual([]);
    // One read to build the selectors, one to verify
    expect(calls.filter(([t]) => t === 'mails.GetMailMessageFullByMessageIDsRequest')).toHaveLength(
      2,
    );
  });

  test('a message that keeps its old state is reported as failed after retries', async () => {
    const c = newClient();
    const calls = fakeApi(c, box([M2]).handlers);
    expect(await c.mail.flag([M1, M2, M3])).toEqual({
      messageIds: [M1, M3],
      failed: [{ messageId: M2, reason: 'state unchanged after the update' }],
    });
    expect(timers.delays).toEqual([1000, 2000]);
    const reads = calls
      .filter(([t]) => t === 'mails.GetMailMessageFullByMessageIDsRequest')
      .map(([, d]) => d.messageBizIds);
    // Retries only re-read what is still pending
    expect(reads).toEqual([[M1, M2, M3], [M1, M2, M3], [M2], [M2]]);
  });

  test('each action checks for its own expected state', async () => {
    // The fake applies nothing, so the initial labels are what the verification sees:
    // M1 starts in the expected state, M3 doesn't
    const cases: [string, (c: LarkClient) => Promise<unknown>, string[], string[]][] = [
      ['read', (c) => c.mail.markRead([M1, M3]), ['INBOX'], ['INBOX', 'UNREAD']],
      ['unread', (c) => c.mail.markRead([M1, M3], false), ['UNREAD'], ['INBOX']],
      ['flag', (c) => c.mail.flag([M1, M3]), ['FLAGGED'], ['INBOX']],
      ['unflag', (c) => c.mail.flag([M1, M3], false), ['INBOX'], ['FLAGGED']],
      ['archive', (c) => c.mail.archive([M1, M3]), ['ARCHIVED'], ['ARCHIVED', 'INBOX']],
      ['archive (still inbox)', (c) => c.mail.archive([M1, M3]), ['ARCHIVED'], ['INBOX']],
      ['unarchive', (c) => c.mail.archive([M1, M3], false), ['INBOX', 'ARCHIVED'], ['ARCHIVED']],
      ['trash', (c) => c.mail.trash([M1, M3]), ['TRASH'], ['INBOX']],
      ['untrash', (c) => c.mail.trash([M1, M3], false), ['INBOX'], ['TRASH', 'INBOX']],
      [
        'modify (add missing)',
        (c) => c.mail.modify([M1, M3], { add: [L1], remove: ['INBOX'] }),
        [L1],
        ['ARCHIVED'],
      ],
      [
        'modify (remove left)',
        (c) => c.mail.modify([M1, M3], { add: [L1], remove: ['INBOX'] }),
        [L1, 'ARCHIVED'],
        [L1, 'INBOX'],
      ],
    ];
    for (const [name, run, good, bad] of cases) {
      const c = newClient();
      fakeApi(c, mailbox({ [M1]: [T1, good], [M3]: [T2, bad] }, [M1, M3]).handlers);
      expect([name, await run(c)]).toEqual([
        name,
        {
          messageIds: [M1],
          failed: [{ messageId: M3, reason: 'state unchanged after the update' }],
        },
      ]);
    }
  });

  test('an unknown message id is rejected before any change is sent', async () => {
    const c = newClient();
    const calls = fakeApi(c, box().handlers);
    const missing = '7000000000000000099';
    await expect(c.mail.flag([M1, missing])).rejects.toThrow(`Mail message not found: ${missing}`);
    await expect(c.mail.markRead([missing])).rejects.toThrow('Mail message not found');
    expect(changes(calls)).toHaveLength(0);
  });

  test('{threads: true}: thread ids expand to all their messages, including search-found copies', async () => {
    const c = newClient();
    const { state, handlers } = box();
    const calls = fakeApi(c, {
      ...handlers,
      'mails.GetThreadMetaByThreadIDsRequest': (d) => ({
        metas: (d.threadBizIds as string[]).flatMap((id) =>
          id === T1
            ? [{ threadBizId: T1, messages: [{ messageBizId: M1 }, { messageBizId: M2 }] }]
            : [],
        ),
      }),
      'mails.GetMailMessageSummaryRequest': () => ({
        messageSummaries: [{ messageBizId: M1, content: { subject: 'Fw: Project update' } }],
      }),
      'mails.MailAdvancedSearchRequest': (d) => ({
        msgSummary:
          d.label === 'TRASH'
            ? []
            : [
                { messageId: M4, threadId: T1 },
                { messageId: M3, threadId: T2 },
              ],
      }),
    });
    expect(await c.mail.archive([T1], true, { threads: true })).toEqual({
      messageIds: [M1, M2, M4],
      failed: [],
    });
    expect(changes(calls).map((d) => d.change)).toEqual([
      {
        multiThreadsModify: {
          threadSelector: [{ threadBizId: T1, messageBizIds: [M1, M2, M4] }],
          addLabelIds: ['ARCHIVED'],
          removeLabelIds: [],
          isFromSearch: true,
        },
      },
    ]);
    expect(state.get(M3)?.labels).toEqual(['INBOX', 'UNREAD']);
    // Writes look in the trash too
    expect(
      calls.filter(([t]) => t === 'mails.MailAdvancedSearchRequest').map(([, d]) => d.label),
    ).toEqual(['', 'TRASH']);

    calls.length = 0;
    await expect(c.mail.trash([T1, T2], true, { threads: true })).rejects.toThrow(
      `Mail thread not found: ${T2}`,
    );
    expect(changes(calls)).toHaveLength(0);
  });
});

describe('mail compose', () => {
  const setup = (extra: Record<string, Handler> = {}) => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.GetMailSettingsRequest': settings,
      'mails.MailInitSyncRequest': () => ({ lastChangeId: '1' }),
      'mailchanges.MailAddChangeRequest': changeLog(),
      ...extra,
    });
    return { c, calls };
  };
  const draftOf = (d: Dict) => {
    const ch = d.change as Dict;
    return ((ch.draftCreateOrUpdate ?? ch.draftSend) as Dict).draft as Dict;
  };
  const contentOf = (d: Dict) => ((draftOf(d).content as Dict).content ?? {}) as Dict;

  test('send(): rejects without recipients unless draftOnly', async () => {
    const { c, calls } = setup();
    await expect(c.mail.send({ subject: 'x', text: 'y' })).rejects.toThrow('No recipients');
    await expect(c.mail.send({ to: [''], subject: 'x' })).rejects.toThrow('No recipients');
    expect(calls).toHaveLength(0);
    const r = await c.mail.send({ subject: 'x', text: 'y' }, { draftOnly: true });
    expect(r.messageId).toBe(r.threadId);
    const sent = changes(calls);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.change as Dict)).toEqual(['draftCreateOrUpdate']);
    expect(draftOf(sent[0] as Dict).meta).toMatchObject({
      messageBizId: r.messageId,
      threadBizId: r.threadId,
      labelIds: ['DRAFT'],
      isDraft: true,
    });
  });

  test('send(): saves the draft, then sends it, and returns ids from the send summary', async () => {
    const { c, calls } = setup();
    const r = await c.mail.send({
      to: [PEER],
      cc: [OTHER],
      subject: 'Weekly report',
      text: 'line 1\nline 2',
    });
    expect(r).toEqual({ messageId: M3, threadId: T2 });
    const sent = changes(calls);
    expect(sent.map((d) => Object.keys(d.change as Dict))).toEqual([
      ['draftCreateOrUpdate'],
      ['draftSend'],
    ]);
    expect(((sent[1] as Dict).change as Dict).draftSend).toMatchObject({ undoSendEnable: false });
    expect(draftOf(sent[1] as Dict)).toEqual(draftOf(sent[0] as Dict));
    const content = contentOf(sent[0] as Dict);
    expect(content).toMatchObject({
      from: { name: 'Me', address: ME, larkEntityId: '7100000000000000009', larkEntityType: 1 },
      to: [{ name: '', address: PEER, mailGroupType: 0 }],
      cc: [{ name: '', address: OTHER, mailGroupType: 0 }],
      bcc: [],
      subject: 'Weekly report',
      bodyPlaintext: 'line 1\nline 2',
      attachments: [],
    });
    expect(content.bodyHtml).toBe(textToHtml('line 1\nline 2'));
  });

  test('send(): html-only body derives the text; from picks an alias; unknown from throws', async () => {
    const { c, calls } = setup();
    await c.mail.send({ to: [PEER], html: '<p>Hi&amp;bye</p>', from: ME_ALIAS.toUpperCase() });
    const content = contentOf(changes(calls)[0] as Dict);
    expect(content).toMatchObject({ bodyPlaintext: 'Hi&bye', bodyHtml: '<p>Hi&amp;bye</p>' });
    expect(content.from).toEqual({ name: 'Me', address: ME_ALIAS, mailGroupType: 0 });
    expect(await c.mail.addresses()).toEqual([
      { name: 'Me', address: ME },
      { name: 'Me', address: ME_ALIAS },
    ]);
    await expect(c.mail.send({ to: [PEER], from: 'someone@example.org' })).rejects.toThrow(
      "Not one of this account's addresses: someone@example.org",
    );
  });

  test('send(): no send summary in the reply is an error; no mail address is an error', async () => {
    const { c } = setup({
      'mailchanges.MailAddChangeRequest': () => ({ changeLog: { serverChangeId: 5 } }),
    });
    await expect(c.mail.send({ to: [PEER] })).rejects.toThrow('Send not confirmed');
    const { c: c2 } = setup({ 'mails.GetMailSettingsRequest': () => ({ setting: {} }) });
    await expect(c2.mail.send({ to: [PEER] })).rejects.toThrow(
      'This account has no Lark Mail address',
    );
  });

  const original = (from: string, over: Dict = {}): Dict =>
    full(
      { messageBizId: M1, threadBizId: T1, createdTime: { unit: 2, value: 1_790_000_000_000 } },
      {
        from: { name: from === ME ? 'Me' : 'Colleague A', address: from },
        to: [{ name: 'Me', address: from === ME ? PEER : ME }],
        cc: [
          { name: 'Colleague B', address: OTHER },
          { name: 'Me', address: ME_ALIAS },
        ],
        subject: 'Project update',
        bodyHtml: '<div>original</div>',
        attachments: [{ fileName: 'proposal.pdf', fileKey: 'box_0001', fileSize: 2048 }],
        ...over,
      },
    );

  test('reply(): to the original sender, Re: once, linked to the original thread', async () => {
    let orig = original(PEER);
    const { c, calls } = setup({
      'mails.GetMailMessageFullByMessageIDsRequest': () => ({ messages: [orig] }),
    });
    await c.mail.reply(M1, { text: 'thanks' });
    const save = changes(calls)[0] as Dict;
    const content = contentOf(save);
    expect(content.to).toEqual([{ name: '', address: PEER, mailGroupType: 0 }]);
    expect(content.cc).toEqual([]);
    expect(content.subject).toBe('Re: Project update');
    expect(content.bodyPlaintext).toBe('thanks');
    expect(content.bodyHtml).toStartWith(textToHtml('thanks'));
    expect(content.bodyHtml).toContain('<blockquote');
    expect(content.bodyHtml).toContain('<div>original</div>');
    expect((draftOf(save).content as Dict).replyToMessageBizId).toBe(M1);
    expect((draftOf(save).meta as Dict).threadBizId).toBe(T1);

    orig = original(PEER, { subject: 'RE: Project update' });
    calls.length = 0;
    await c.mail.reply(M1, { text: 'again', quote: false }, { draftOnly: true });
    const again = changes(calls);
    expect(again).toHaveLength(1);
    expect(contentOf(again[0] as Dict).subject).toBe('RE: Project update');
    expect(contentOf(again[0] as Dict).bodyHtml).toBe(textToHtml('again'));
  });

  test('reply(): all adds other recipients to cc without my own addresses', async () => {
    const { c, calls } = setup({
      'mails.GetMailMessageFullByMessageIDsRequest': () => ({ messages: [original(PEER)] }),
    });
    await c.mail.reply(M1, { text: 'ok', all: true, cc: ['extra@example.org'] });
    const content = contentOf(changes(calls)[0] as Dict);
    expect((content.to as Dict[]).map((a) => a.address)).toEqual([PEER]);
    expect((content.cc as Dict[]).map((a) => a.address)).toEqual(['extra@example.org', OTHER]);
  });

  test('reply(): a message I sent replies to its original recipients', async () => {
    const { c, calls } = setup({
      'mails.GetMailMessageFullByMessageIDsRequest': () => ({ messages: [original(ME)] }),
    });
    await c.mail.reply(M1, { text: 'follow-up', all: true });
    const content = contentOf(changes(calls)[0] as Dict);
    expect((content.to as Dict[]).map((a) => a.address)).toEqual([PEER]);
    expect((content.cc as Dict[]).map((a) => a.address)).toEqual([OTHER]);
  });

  test('reply() / forward(): unknown message is an error', async () => {
    const { c } = setup({
      'mails.GetMailMessageFullByMessageIDsRequest': () => ({ messages: [] }),
    });
    await expect(c.mail.reply(M1, { text: 'x' })).rejects.toThrow('Mail message not found');
    await expect(c.mail.forward(M1, { to: [PEER] })).rejects.toThrow('Mail message not found');
  });

  test('forward(): Fw: subject, carries the original attachments, quotes the original', async () => {
    const { c, calls } = setup({
      'mails.GetMailMessageFullByMessageIDsRequest': () => ({ messages: [original(PEER)] }),
    });
    const r = await c.mail.forward(M1, { to: [OTHER], text: 'FYI' });
    expect(r).toEqual({ messageId: M3, threadId: T2 });
    const save = changes(calls)[0] as Dict;
    const content = contentOf(save);
    expect(content.subject).toBe('Fw: Project update');
    expect(content.to).toEqual([{ name: '', address: OTHER, mailGroupType: 0 }]);
    expect(content.attachments).toEqual([
      { fileName: 'proposal.pdf', fileKey: 'box_0001', type: 1, fileSize: 2048 },
    ]);
    expect(content.bodyHtml).toContain('---------- Forwarded message ----------');
    expect(content.bodyHtml).toContain(`From: Colleague A &lt;${PEER}&gt;`);
    expect((draftOf(save).content as Dict).replyToMessageBizId).toBe(M1);
  });

  test('sendDraft(): sends a saved draft as is; a non-draft is rejected', async () => {
    let isDraft = true;
    const { c, calls } = setup({
      'mails.GetMailMessageFullByMessageIDsRequest': () => ({
        messages: [
          full(
            { messageBizId: M1, threadBizId: T1, isDraft, labelIds: ['DRAFT'] },
            { subject: 's', to: [{ address: PEER }] },
          ),
        ],
      }),
    });
    expect(await c.mail.sendDraft(M1)).toEqual({ messageId: M3, threadId: T2 });
    const send = changes(calls)[0]?.change as Dict;
    expect((send.draftSend as Dict).draft).toMatchObject({
      meta: { messageBizId: M1, isDraft: true, labelIds: ['DRAFT'] },
      content: { content: { subject: 's' } },
    });
    isDraft = false;
    await expect(c.mail.sendDraft(M1)).rejects.toThrow(`Not a draft: ${M1}`);
  });

  test('deleteDrafts(): one draftDelete change per id', async () => {
    const { c, calls } = setup();
    await c.mail.deleteDrafts([M1, M2]);
    expect(changes(calls).map((d) => d.change)).toEqual([
      { draftDelete: { messageBizId: M1 } },
      { draftDelete: { messageBizId: M2 } },
    ]);
  });
});

describe('mail attachments over a fake Drive server', () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { path: string; query: string; headers: Record<string, string>; body: Uint8Array }[] =
    [];
  const orig = {
    spaceHost: urls.spaceHost,
    driveStreamHost: urls.driveStreamHost,
    internalHost: urls.internalHost,
  };
  beforeEach(() => {
    seen.length = 0;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({
          path: u.pathname,
          query: u.search,
          headers: Object.fromEntries(req.headers),
          body: new Uint8Array(await req.arrayBuffer()),
        });
        if (u.pathname.endsWith('/prepare/'))
          return Response.json({ code: 0, data: { upload_id: 'up-1', block_size: 4 } });
        if (u.pathname.endsWith('/merge_block/')) return Response.json({ code: 0 });
        if (u.pathname.endsWith('/finish/'))
          return Response.json({ code: 0, data: { file_token: 'box_0002' } });
        if (u.pathname.includes('/download/all/')) return new Response('attachment-bytes');
        return new Response('not found', { status: 404 });
      },
    });
    const base = () => `http://localhost:${server.port}`;
    urls.spaceHost = base;
    urls.driveStreamHost = base;
    urls.internalHost = base;
  });
  afterEach(() => {
    Object.assign(urls, orig);
    server.stop(true);
  });

  const client = () => {
    const c = newClient();
    Object.assign(c.auth, {
      region: { name: 'lark', domain: 'example.invalid' },
      cookies: { session: 's1' },
    });
    return c;
  };

  test('uploadAttachment(): prepare, one merge_block per block with checksum, finish', async () => {
    const data = new TextEncoder().encode('0123456789');
    const att = await client().mail.uploadAttachment({ name: 'notes.txt', data });
    expect(att).toEqual({ fileName: 'notes.txt', fileKey: 'box_0002', type: 1, fileSize: 10 });
    expect(seen.map((s) => s.path)).toEqual([
      '/space/api/box/upload/prepare/',
      '/space/api/box/stream/upload/merge_block/',
      '/space/api/box/stream/upload/merge_block/',
      '/space/api/box/stream/upload/merge_block/',
      '/space/api/box/upload/finish/',
    ]);
    expect(JSON.parse(new TextDecoder().decode(seen[0]?.body))).toMatchObject({
      mount_point: 'email',
      mount_node_token: 'me',
      name: 'notes.txt',
      size: 10,
    });
    expect(seen[0]?.headers.cookie).toBe('session=s1');
    const blocks = seen.slice(1, 4);
    expect(blocks.map((b) => b.headers['x-seq-list'])).toEqual(['0', '1', '2']);
    expect(blocks.map((b) => new TextDecoder().decode(b.body))).toEqual(['0123', '4567', '89']);
    expect(blocks[2]?.headers['x-block-list-checksum']).toBe(adler32(data.subarray(8)));
    expect(blocks[2]?.headers['x-block-origin-size']).toBe('2');
    expect(blocks[0]?.query).toContain('upload_id=up-1');
    expect(JSON.parse(new TextDecoder().decode(seen[4]?.body))).toMatchObject({
      upload_id: 'up-1',
      num_blocks: 3,
    });
  });

  test('send() with attachments uploads them into the draft', async () => {
    const c = client();
    const calls = fakeApi(c, {
      'mails.GetMailSettingsRequest': settings,
      'mails.MailInitSyncRequest': () => ({ lastChangeId: '1' }),
      'mailchanges.MailAddChangeRequest': changeLog(),
    });
    await c.mail.send(
      { subject: 'x', attachments: [{ name: 'a.txt', data: new Uint8Array(3) }] },
      { draftOnly: true },
    );
    const draft = (((changes(calls)[0] as Dict).change as Dict).draftCreateOrUpdate as Dict)
      .draft as Dict;
    expect(((draft.content as Dict).content as Dict).attachments).toEqual([
      { fileName: 'a.txt', fileKey: 'box_0002', type: 1, fileSize: 3 },
    ]);
  });

  test('downloadAttachment(): fetches the file from the email mount', async () => {
    const bytes = await client().mail.downloadAttachment('box_0001');
    expect(new TextDecoder().decode(bytes)).toBe('attachment-bytes');
    expect(seen[0]?.path).toBe('/space/api/box/stream/download/all/box_0001');
    expect(seen[0]?.query).toBe('?mount_point=email');
  });
});

describe('mail permissions', () => {
  test('MAIL_METHOD_PERMISSIONS maps drafts to mail.draft and sends to their own item', () => {
    const fn = (k: 'send' | 'reply' | 'forward') =>
      MAIL_METHOD_PERMISSIONS[k] as (...a: unknown[]) => string;
    expect(fn('send')({ to: [PEER] })).toBe('mail.send');
    expect(fn('send')({ to: [PEER] }, { draftOnly: true })).toBe('mail.draft');
    expect(fn('send')({ to: [PEER] }, {})).toBe('mail.send');
    expect(fn('reply')(M1, { text: 'x' })).toBe('mail.reply');
    expect(fn('reply')(M1, { text: 'x' }, { draftOnly: true })).toBe('mail.draft');
    expect(fn('forward')(M1, { to: [PEER] })).toBe('mail.forward');
    expect(fn('forward')(M1, { to: [PEER] }, { draftOnly: true })).toBe('mail.draft');
    expect(MAIL_METHOD_PERMISSIONS).toMatchObject({
      modify: 'mail.label',
      list: 'mail.list',
      threads: 'mail.list',
      resolveTarget: 'mail.labels',
      resolveLabel: 'mail.labels',
      threadMembers: 'mail.thread',
      thread: 'mail.thread',
      search: 'mail.search',
      messages: 'mail.get',
      markRead: 'mail.read',
      flag: 'mail.flag',
      archive: 'mail.archive',
      trash: 'mail.trash',
    });
    for (const v of Object.values(MAIL_METHOD_PERMISSIONS))
      if (typeof v === 'string') expect(Object.hasOwn(PERMISSIONS, v)).toBe(true);
  });

  test('PERMISSIONS lists every mail item with its group', () => {
    const mail = Object.fromEntries(
      Object.entries(PERMISSIONS).filter(([k]) => k.startsWith('mail.')),
    );
    expect(mail).toEqual({
      'mail.labels': 'query',
      'mail.addresses': 'query',
      'mail.list': 'query',
      'mail.thread': 'query',
      'mail.get': 'query',
      'mail.search': 'query',
      'mail.download': 'query',
      'mail.send': 'outbound',
      'mail.reply': 'outbound',
      'mail.forward': 'outbound',
      'mail.send-draft': 'outbound',
      'mail.draft': 'organize',
      'mail.delete-draft': 'organize',
      'mail.read': 'organize',
      'mail.flag': 'organize',
      'mail.label': 'organize',
      'mail.archive': 'organize',
      'mail.trash': 'organize',
    });
  });

  test('a client with permissions allows saving a draft but blocks sending when outbound is denied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'larkx-mail-'));
    const savedHome = process.env.LARKX_HOME;
    process.env.LARKX_HOME = home;
    const api = spyOn(LarkClient.prototype, 'api').mockImplementation(async () => ({}));
    try {
      const auth = {
        userId: '7000000000000000001',
        appKey: 'app',
        path: join(home, 'credentials.json'),
        requireValid: async () => {},
      } as unknown as LarkAuth;
      const c = await LarkClient.create(auth, { permissions: { allow: [], deny: ['outbound'] } });
      const calls = fakeApi(c, {
        'mails.GetMailSettingsRequest': settings,
        'mails.MailInitSyncRequest': () => ({ lastChangeId: '1' }),
        'mailchanges.MailAddChangeRequest': changeLog(),
      });
      await c.mail.send({ to: [PEER], subject: 'x' }, { draftOnly: true });
      expect(changes(calls)).toHaveLength(1);
      calls.length = 0;
      const err = await c.mail.send({ to: [PEER], subject: 'x' }).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDenied);
      expect(err).toMatchObject({ permission: 'mail.send', group: 'outbound' });
      expect(calls).toHaveLength(0);
      await expect(c.mail.reply(M1, { text: 'x' })).rejects.toThrow('mail.reply');
    } finally {
      api.mockRestore();
      if (savedHome === undefined) delete process.env.LARKX_HOME;
      else process.env.LARKX_HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('mail regressions', () => {
  test('resolveTarget(): an all-caps user label name resolves to its id, not a system id', async () => {
    const c = newClient();
    fakeApi(c, {
      'mails.MailInitSyncRequest': () => ({
        coldStart: {
          labelList: {
            systemLabels: [{ id: 'INBOX', name: 'INBOX', isSystem: true }],
            userLabels: [{ id: '7300000000000000003', name: 'VIP' }],
            userFolders: [],
          },
        },
      }),
    });
    expect(await c.mail.resolveTarget('VIP')).toEqual({ id: '7300000000000000003', folder: false });
    // Unknown all-caps ids (other system labels) still pass through
    expect(await c.mail.resolveTarget('READ_RECEIPT_REQUEST')).toEqual({
      id: 'READ_RECEIPT_REQUEST',
      folder: false,
    });
  });

  test('writes: a message that vanishes after the update is reported as failed, not done', async () => {
    const timers = instantTimers();
    try {
      const c = newClient();
      const { state, handlers } = mailbox({
        [M1]: [T1, ['INBOX', 'UNREAD']],
        [M2]: [T1, ['INBOX', 'UNREAD']],
      });
      const apply = handlers['mailchanges.MailAddChangeRequest'] as Handler;
      fakeApi(c, {
        ...handlers,
        'mailchanges.MailAddChangeRequest': (d) => {
          const r = apply(d);
          state.delete(M2);
          return r;
        },
      });
      const r = await c.mail.markRead([M1, M2]);
      expect(r.messageIds).toEqual([M1]);
      expect(r.failed).toEqual([{ messageId: M2, reason: 'message not found after the update' }]);
    } finally {
      timers.restore();
    }
  });

  test('threadMembers(): subjects for more than 30 threads are fetched in batches of 30', async () => {
    const c = newClient();
    const threads = Array.from(
      { length: 35 },
      (_, i) => `70000000000000002${String(i).padStart(2, '0')}`,
    );
    const sizes: number[] = [];
    let searches = 0;
    fakeApi(c, {
      'mails.GetThreadMetaByThreadIDsRequest': (d) => ({
        metas: (d.threadBizIds as string[]).map((t) => ({
          threadBizId: t,
          messages: [{ messageBizId: `m-${t}` }],
        })),
      }),
      'mails.GetMailMessageSummaryRequest': (d) => {
        sizes.push((d.messageBizIds as string[]).length);
        return {
          messageSummaries: (d.messageBizIds as string[]).map((id) => ({
            messageBizId: id,
            content: { subject: `subject ${id}` },
          })),
        };
      },
      'mails.MailAdvancedSearchRequest': () => {
        searches++;
        return { msgSummary: [] };
      },
    });
    const members = await c.mail.threadMembers(threads);
    expect(sizes).toEqual([30, 5]);
    // Every thread got its subject, so every thread was searched
    expect(searches).toBe(35);
    expect(members.get(threads[34] as string)).toEqual([`m-${threads[34]}`]);
  });
});
