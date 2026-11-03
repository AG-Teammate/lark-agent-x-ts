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
        name: '本人',
        address: ME,
        larkEntityId: '7100000000000000009',
        larkEntityType: 1,
      },
      allAddresses: [
        { name: '本人', address: ME },
        { name: '本人', address: ME_ALIAS },
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
          from: { displayName: '同事甲', address: PEER },
          to: [{ name: '本人', address: ME }],
          subject: '周报',
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
      from: { name: '同事甲', address: PEER },
      to: [{ name: '本人', address: ME }],
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

  test('thread(): full messages oldest first', async () => {
    const c = newClient();
    fakeApi(c, {
      'mails.GetThreadMetaByThreadIDsRequest': () => ({
        metas: [{ threadBizId: T1, messages: [{ messageBizId: M2 }, { messageBizId: M1 }] }],
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
        ],
      }),
    });
    expect((await c.mail.thread(T1)).map((m) => [m.messageId, m.text])).toEqual([
      [M1, 'x'],
      [M2, ''],
    ]);
    await expect(c.mail.thread(T2)).rejects.toThrow('Mail thread not found');
  });
});

describe('mail change log', () => {
  const threadMetas: Handler = (d) => ({
    metas: (d.threadBizIds as string[]).map((id) => ({
      threadBizId: id,
      messages: [{ messageBizId: `${id}1` }, { messageBizId: `${id}2` }],
    })),
  });

  test('the first change syncs, later changes carry the previous serverChangeId', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': () => ({ lastChangeId: '42' }),
      'mails.GetThreadMetaByThreadIDsRequest': threadMetas,
      'mailchanges.MailAddChangeRequest': changeLog(100),
    });
    await c.mail.flag([T1]);
    await c.mail.flag([T1], false);
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
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': () => ({ lastChangeId: String(10 + syncs++) }),
      'mails.GetThreadMetaByThreadIDsRequest': threadMetas,
      'mailchanges.MailAddChangeRequest': (d) => {
        if (failures-- > 0) throw outOfSync();
        return changeLog(200)(d);
      },
    });
    await c.mail.archive([T1]);
    expect(changes(calls).map((d) => (d.meta as Dict).lastSyncedServerChangeId)).toEqual([10, 11]);

    failures = Number.POSITIVE_INFINITY;
    calls.length = 0;
    const err = await c.mail.archive([T1]).catch((e) => e);
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
      'mails.MailInitSyncRequest': () => ({ lastChangeId: '1' }),
      'mails.GetThreadMetaByThreadIDsRequest': threadMetas,
      'mailchanges.MailAddChangeRequest': () => reply(),
    });
    await expect(c.mail.flag([T1])).rejects.toBeInstanceOf(HttpError);
    expect(changes(calls)).toHaveLength(1);
    reply = () => ({});
    await expect(c.mail.flag([T1])).rejects.toThrow('Mail change rejected');
  });

  test('markRead / flag / archive / label / trash build the right changes with all message ids', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.MailInitSyncRequest': () => ({ lastChangeId: '1' }),
      'mails.GetThreadMetaByThreadIDsRequest': threadMetas,
      'mailchanges.MailAddChangeRequest': changeLog(),
    });
    const sel = (id: string) => ({ threadBizId: id, messageBizIds: [`${id}1`, `${id}2`] });
    const multi = (add: string[], remove: string[]) => ({
      multiThreadsModify: {
        threadSelector: [sel(T1), sel(T2)],
        addLabelIds: add,
        removeLabelIds: remove,
        isFromSearch: false,
      },
    });

    await c.mail.markRead([T1, T2]);
    await c.mail.markRead([T1], false);
    await c.mail.flag([T1, T2]);
    await c.mail.flag([T1, T2], false);
    await c.mail.archive([T1, T2]);
    await c.mail.archive([T1, T2], false);
    await c.mail.modifyThreads([T1, T2], { add: ['7300000000000000001'], remove: ['INBOX'] });
    await c.mail.trash([T1, T2]);
    await c.mail.trash([T1, T2], false);

    expect(changes(calls).map((d) => d.change)).toEqual([
      { threadModify: { ...sel(T1), removeLabelIds: ['UNREAD'] } },
      { threadModify: { ...sel(T2), removeLabelIds: ['UNREAD'] } },
      { threadModify: { ...sel(T1), addLabelIds: ['UNREAD'] } },
      multi(['FLAGGED'], []),
      multi([], ['FLAGGED']),
      multi(['ARCHIVED'], []),
      multi(['INBOX'], []),
      multi(['7300000000000000001'], ['INBOX']),
      { trashThreads: { threadSelector: [sel(T1), sel(T2)], isFromSearch: false } },
      { untrashThreads: { threadSelector: [sel(T1), sel(T2)] } },
    ]);
  });

  test('an unknown thread is rejected before any change is sent', async () => {
    const c = newClient();
    const calls = fakeApi(c, {
      'mails.GetThreadMetaByThreadIDsRequest': () => ({ metas: [] }),
    });
    await expect(c.mail.flag([T1])).rejects.toThrow(`Mail thread not found: ${T1}`);
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
      subject: '周报',
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
      from: { name: '本人', address: ME, larkEntityId: '7100000000000000009', larkEntityType: 1 },
      to: [{ name: '', address: PEER, mailGroupType: 0 }],
      cc: [{ name: '', address: OTHER, mailGroupType: 0 }],
      bcc: [],
      subject: '周报',
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
    expect(content.from).toEqual({ name: '本人', address: ME_ALIAS, mailGroupType: 0 });
    expect(await c.mail.addresses()).toEqual([
      { name: '本人', address: ME },
      { name: '本人', address: ME_ALIAS },
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
        from: { name: from === ME ? '本人' : '同事甲', address: from },
        to: [{ name: '本人', address: from === ME ? PEER : ME }],
        cc: [
          { name: '同事乙', address: OTHER },
          { name: '本人', address: ME_ALIAS },
        ],
        subject: '项目进展',
        bodyHtml: '<div>original</div>',
        attachments: [{ fileName: '方案.pdf', fileKey: 'box_0001', fileSize: 2048 }],
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
    expect(content.subject).toBe('Re: 项目进展');
    expect(content.bodyPlaintext).toBe('thanks');
    expect(content.bodyHtml).toStartWith(textToHtml('thanks'));
    expect(content.bodyHtml).toContain('<blockquote');
    expect(content.bodyHtml).toContain('<div>original</div>');
    expect((draftOf(save).content as Dict).replyToMessageBizId).toBe(M1);
    expect((draftOf(save).meta as Dict).threadBizId).toBe(T1);

    orig = original(PEER, { subject: 'RE: 项目进展' });
    calls.length = 0;
    await c.mail.reply(M1, { text: 'again', quote: false }, { draftOnly: true });
    const again = changes(calls);
    expect(again).toHaveLength(1);
    expect(contentOf(again[0] as Dict).subject).toBe('RE: 项目进展');
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
    expect(content.subject).toBe('Fw: 项目进展');
    expect(content.to).toEqual([{ name: '', address: OTHER, mailGroupType: 0 }]);
    expect(content.attachments).toEqual([
      { fileName: '方案.pdf', fileKey: 'box_0001', type: 1, fileSize: 2048 },
    ]);
    expect(content.bodyHtml).toContain('---------- Forwarded message ----------');
    expect(content.bodyHtml).toContain(`From: 同事甲 &lt;${PEER}&gt;`);
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
