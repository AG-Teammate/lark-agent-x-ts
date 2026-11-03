import { randomUUID } from 'node:crypto';
import type { LarkClient } from './client.js';
import { HttpError, raiseForStatus, request, USER_AGENT } from './http.js';
import { getLogger } from './log.js';
import type { Permission } from './permissions.js';
import type { Dict } from './proto/dict.js';
import { urls, webOrigin } from './region.js';

const logger = getLogger('larkx.mail');

/**
 * Lark Mail over the web client's gateway (the same transport as messenger; cmd numbers come from the Mail web bundle,
 * see scripts/proto-pipeline/mail.ts). Reads go through dedicated requests; every write (draft save, send, label edits,
 * read state, archive, trash) is one entry in the mailbox change log (`mailchanges.MailAddChangeRequest`).
 * Attachments live in the Drive file service under the `email` mount point.
 */

/** System label ids. User labels and folders have numeric ids; see labels(). */
export const MAIL_LABELS = {
  inbox: 'INBOX',
  sent: 'SENT',
  draft: 'DRAFT',
  archived: 'ARCHIVED',
  trash: 'TRASH',
  spam: 'SPAM',
  flagged: 'FLAGGED',
  unread: 'UNREAD',
  important: 'IMPORTANT',
  other: 'OTHER',
  scheduled: 'SCHEDULED',
} as const;

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailAttachment {
  name: string;
  /** Drive file token; downloadAttachment takes it. */
  fileKey: string;
  size: number;
}

export interface MailMessage {
  messageId: string;
  threadId: string;
  /** The message this one replies to or forwards (empty for a new conversation). */
  replyTo: string;
  labels: string[];
  draft: boolean;
  /** Creation time (ms). */
  createdAt: number;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** Short plain-text preview. */
  summary: string;
  /** Plain-text body; empty in list results, filled by thread() and messages(). */
  text: string;
  /** HTML body; empty in list results, filled by thread() and messages(). */
  html: string;
  attachments: MailAttachment[];
}

export interface MailThread {
  threadId: string;
  /** Message ids in the thread, as listed by the server (drafts included). */
  messageIds: string[];
  /** The most recent message (summary only, no body). */
  latest: MailMessage | null;
  messageCount: number;
  unread: boolean;
  /** Union of the labels on the thread's messages. */
  labels: string[];
  /** Sort time of the thread (ms), the time of its latest message. */
  updatedAt: number;
}

export interface MailLabel {
  id: string;
  name: string;
  kind: 'system' | 'label' | 'folder';
  /** Unread threads, as on the client badge. */
  unread: number;
  /** Total threads, when the server reports it. */
  total: number;
}

export interface MailSearchOptions {
  from?: string[];
  to?: string[];
  subject?: string[];
  /** Restrict to a label id (e.g. INBOX, SENT). */
  label?: string;
  /** Time range (ms). */
  since?: number;
  until?: number;
  hasAttachment?: boolean;
  limit?: number;
}

export interface MailSearchHit {
  messageId: string;
  threadId: string;
  subject: string;
  summary: string;
  from: string;
  createdAt: number;
  labels: string[];
  hasAttachment: boolean;
  messageCount: number;
}

/** File to attach: bytes plus file name. */
export interface MailFile {
  name: string;
  data: Uint8Array;
}

export interface MailDraft {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  /** Plain-text body; converted to simple HTML when html is not given. */
  text?: string;
  /** HTML body (the plain-text version is derived from it when text is not given). */
  html?: string;
  attachments?: MailFile[];
  /** Sender address; defaults to the mailbox's default address. Must be one of the account's addresses. */
  from?: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
}

/** Thread selection the change log takes: a thread plus all its message ids. */
interface ThreadSelector {
  threadBizId: string;
  messageBizIds: string[];
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number => (v === undefined || v === null || v === '' ? 0 : Number(v));
const list = <T = Dict>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** Timestamps come as {unit, value}: unit 1 seconds, 2 milliseconds, 3 microseconds, 4 nanoseconds. */
function millis(t: unknown): number {
  if (!t || typeof t !== 'object') return num(t);
  const o = t as Dict;
  const v = num(o.value);
  const unit = num(o.unit);
  return unit === 1
    ? v * 1000
    : unit === 3
      ? Math.floor(v / 1e3)
      : unit === 4
        ? Math.floor(v / 1e6)
        : v;
}

function address(a: unknown): MailAddress {
  const o = (a ?? {}) as Dict;
  return { name: str(o.name || o.displayName), address: str(o.address) };
}

/** Summary or full message (`{meta, content: {content}}` or `{messageBizId, content}`) → MailMessage. */
export function toMailMessage(meta: Dict | null, content: Dict | null): MailMessage {
  const m = meta ?? {};
  const outer = content ?? {};
  const c = ((outer.content as Dict | undefined) ?? {}) as Dict;
  return {
    messageId: str(m.messageBizId || outer.messageBizId),
    threadId: str(m.threadBizId),
    replyTo: str(outer.replyToMessageBizId),
    labels: list<string>(m.labelIds).map(String),
    draft: Boolean(m.isDraft),
    createdAt: millis(m.createdTime),
    from: address(c.from),
    to: list(c.to).map(address),
    cc: list(c.cc).map(address),
    bcc: list(c.bcc).map(address),
    subject: str(c.subject),
    summary: str(c.bodySummary || c.bodyPlaintext).slice(0, 300),
    text: str(c.bodyPlaintext),
    html: str(c.bodyHtml),
    attachments: list(c.attachments).map((x) => ({
      name: str(x.fileName),
      fileKey: str(x.fileKey),
      size: num(x.fileSize),
    })),
  };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text → the block markup the web editor produces: one div per line, URLs as links. */
export function textToHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const body = escapeHtml(line).replace(
        /https?:\/\/[^\s<]+/g,
        (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`,
      );
      return `<div style="margin-top: 4px; margin-bottom: 4px; line-height: 1.6;"><div style="font-size: 14px;">${body || '<br>'}</div></div>`;
    })
    .join('');
}

/** Rough HTML → text for the plain-text part of an HTML-only draft. */
export function htmlToText(html: string): string {
  return (
    html
      // A run of closing block tags (nested divs) ends one line; a <br> right before them is that same line break
      .replace(/(?:<br[^>]*>\s*)?(?:<\/(?:div|p|li|tr|h\d)>\s*)+/gi, '\n')
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Adler-32 of a block, as a decimal string (the Drive block upload checksum). */
export function adler32(data: Uint8Array): string {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return String(((b << 16) | a) >>> 0);
}

const BLOCK_SIZE = 4 * 1024 * 1024;
/** The server rejects summary requests above ~30 ids ("batchSize out of limit"); the web client sends 30. */
const SUMMARY_BATCH = 30;
const MAIL_MOUNT = 'email';
const TIME_DESC = 2;
const NEWER_THAN = 1;
const OLDER_THAN = 3;

/** Lark Mail for the logged-in account. Get one from `client.mail`. */
export class LarkMail {
  private sender: (MailAddress & { entityId: string; entityType: number }) | null = null;
  private senders: Array<MailAddress & { entityId: string; entityType: number }> = [];
  /** Last change-log id this client has seen; the server rejects writes based on a stale one ("inbox out of sync"). */
  private syncedChangeId: number | undefined;

  constructor(readonly client: LarkClient) {}

  private get auth() {
    return this.client.auth;
  }

  /** Labels and folders with unread and total counts: system labels first, then user labels, then folders. */
  async labels(): Promise<MailLabel[]> {
    const resp = await this.client.api('mails.MailInitSyncRequest', { forceColdStart: true });
    const cold = (resp.coldStart ?? {}) as Dict;
    const unread = (cold.mailUnreadCount ?? {}) as Record<string, unknown>;
    const lists = (cold.labelList ?? {}) as Dict;
    const out: MailLabel[] = [];
    const add = (x: Dict, kind: MailLabel['kind']) =>
      out.push({
        id: str(x.id),
        name: str(x.name || x.nodeName),
        kind,
        unread: num(unread[str(x.id)]),
        total: num(x.totalCount),
      });
    for (const x of list(lists.systemLabels)) add(x, 'system');
    for (const x of list(lists.userLabels)) add(x, 'label');
    for (const x of list(lists.userFolders)) add(x, 'folder');
    return out;
  }

  /** Resolve a label by id or (case-insensitive) name; system names like "inbox" map to their ids. */
  async resolveLabel(nameOrId: string): Promise<string> {
    const key = nameOrId.trim();
    const sys = (MAIL_LABELS as Record<string, string>)[key.toLowerCase()];
    if (sys) return sys;
    if (/^[A-Z_]+$/.test(key) || /^\d+$/.test(key)) return key;
    const found = (await this.labels()).find((l) => l.name.toLowerCase() === key.toLowerCase());
    if (!found) throw new Error(`Unknown mail label: ${nameOrId}`);
    return found.id;
  }

  /**
   * Threads under a label, newest first, up to limit. before (ms) continues an earlier listing: pass the last
   * thread's updatedAt to get the next page.
   */
  async threads(
    label = 'INBOX',
    o: { limit?: number; before?: number } = {},
  ): Promise<MailThread[]> {
    const limit = o.limit ?? 20;
    const out: MailThread[] = [];
    let before = o.before;
    while (out.length < limit) {
      const resp = await this.client.api('mails.GetMailThreadMetaRequest', {
        labelId: label,
        pageSize: Math.min(50, limit - out.length),
        requestParams: {
          timestampOperator: before ? OLDER_THAN : NEWER_THAN,
          timestamp: before ?? 0,
          orderBy: TIME_DESC,
        },
        useClientFg: true,
        useInboxTypeFg: true,
      });
      const page = list(resp.threads);
      for (const t of page) {
        const metas = list(t.messages);
        out.push({
          threadId: str(t.threadBizId),
          messageIds: metas.map((m) => str(m.messageBizId)),
          latest: null,
          messageCount: metas.length,
          unread: metas.some((m) => list<string>(m.labelIds).includes('UNREAD')),
          labels: [...new Set(metas.flatMap((m) => list<string>(m.labelIds).map(String)))],
          updatedAt: num(t.sortTimestamp),
        });
      }
      if (!page.length || !resp.hasMore) break;
      before = out.at(-1)?.updatedAt;
    }
    await this.fillLatest(out);
    return out;
  }

  /** Attach the latest message summary to each thread (one batched request). */
  private async fillLatest(threads: MailThread[]): Promise<void> {
    const ids = threads.flatMap((t) => t.messageIds);
    if (!ids.length) return;
    const byId = new Map<string, Dict>();
    for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
      const resp = await this.client.api('mails.GetMailMessageSummaryRequest', {
        messageBizIds: ids.slice(i, i + SUMMARY_BATCH),
      });
      for (const s of list(resp.messageSummaries)) byId.set(str(s.messageBizId), s);
    }
    const metas = await this.threadMetas(threads.map((t) => t.threadId));
    for (const t of threads) {
      const msgs = (metas.get(t.threadId) ?? [])
        .map((m) => toMailMessage(m, byId.get(str(m.messageBizId)) ?? null))
        .filter((m) => !m.draft);
      t.latest = msgs.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    }
  }

  /** Thread id → message metas (labels, times, draft flag), for the given threads. */
  private async threadMetas(threadIds: string[]): Promise<Map<string, Dict[]>> {
    const out = new Map<string, Dict[]>();
    for (let i = 0; i < threadIds.length; i += 50) {
      const resp = await this.client.api('mails.GetThreadMetaByThreadIDsRequest', {
        threadBizIds: threadIds.slice(i, i + 50),
      });
      for (const t of list(resp.metas)) out.set(str(t.threadBizId), list(t.messages));
    }
    return out;
  }

  /** Full messages (bodies and attachments) by id, in the given order; unknown ids are skipped. */
  async messages(messageIds: string[]): Promise<MailMessage[]> {
    const found = new Map<string, MailMessage>();
    for (let i = 0; i < messageIds.length; i += 20) {
      const resp = await this.client.api('mails.GetMailMessageFullByMessageIDsRequest', {
        messageBizIds: messageIds.slice(i, i + 20),
      });
      for (const m of list(resp.messages)) {
        const msg = toMailMessage(
          (m.meta ?? null) as Dict | null,
          (m.content ?? null) as Dict | null,
        );
        found.set(msg.messageId, msg);
      }
    }
    return messageIds.flatMap((id) => (found.has(id) ? [found.get(id) as MailMessage] : []));
  }

  /** A whole conversation, oldest message first, with bodies and attachments (drafts included). */
  async thread(threadId: string): Promise<MailMessage[]> {
    const metas = (await this.threadMetas([threadId])).get(threadId) ?? [];
    if (!metas.length) throw new Error(`Mail thread not found: ${threadId}`);
    const msgs = await this.messages(metas.map((m) => str(m.messageBizId)));
    return msgs.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Full-text search across the mailbox (server-side), newest first. */
  async search(keyword: string, o: MailSearchOptions = {}): Promise<MailSearchHit[]> {
    const limit = o.limit ?? 20;
    const out: MailSearchHit[] = [];
    let session = '';
    while (out.length < limit) {
      const resp = await this.client.api('mails.MailAdvancedSearchRequest', {
        keyword,
        fromList: o.from ?? [],
        toList: o.to ?? [],
        subjectList: o.subject ?? [],
        startDate: o.since ? Math.floor(o.since / 1000) : 0,
        endDate: o.until ? Math.floor(o.until / 1000) : 0,
        hasAttachment: Boolean(o.hasAttachment),
        label: o.label ?? '',
        searchSession: session,
        pageSize: Math.min(50, limit - out.length),
        offset: out.length,
      });
      const page = list(resp.msgSummary);
      for (const h of page)
        out.push({
          messageId: str(h.messageId),
          threadId: str(h.threadId),
          subject: str(h.subjectSummary),
          summary: str(h.bodyPlaintextSummary),
          from: str(h.from),
          createdAt: millis(h.lastMessageTimestamp || h.createdTimestamp),
          labels: list<string>(h.labels).map(String),
          hasAttachment: Boolean(h.hasAttachment),
          messageCount: num(h.messageCount),
        });
      session = str(resp.searchSession);
      if (!page.length || !resp.hasMore) break;
    }
    return out.slice(0, limit);
  }

  // ---- writes ----

  private async syncChangeId(): Promise<number> {
    const resp = await this.client.api('mails.MailInitSyncRequest', {});
    this.syncedChangeId = num(resp.lastChangeId);
    return this.syncedChangeId;
  }

  /**
   * Submit one change to the mailbox change log and return the server's change log entry. Like the web client, each
   * change carries the last change id seen; when the server says the inbox is out of sync, resync once and retry.
   */
  private async change(change: Dict, retried = false): Promise<Dict> {
    const lastSynced = this.syncedChangeId ?? (await this.syncChangeId());
    let resp: Dict;
    try {
      resp = await this.client.api('mailchanges.MailAddChangeRequest', {
        meta: { clientTimestampMs: Date.now(), lastSyncedServerChangeId: lastSynced },
        change,
        uuid: randomUUID(),
      });
    } catch (e) {
      if (
        !retried &&
        e instanceof HttpError &&
        /out of (sync|date)|outdated/i.test(e.reason ?? '')
      ) {
        await this.syncChangeId();
        return this.change(change, true);
      }
      throw e;
    }
    const log = (resp.changeLog ?? null) as Dict | null;
    if (log?.serverChangeId) this.syncedChangeId = num(log.serverChangeId);
    if (!log)
      throw new Error(`Mail change rejected by the server: ${JSON.stringify(Object.keys(change))}`);
    return log;
  }

  private async selectors(threadIds: string[]): Promise<ThreadSelector[]> {
    const metas = await this.threadMetas(threadIds);
    return threadIds.map((id) => {
      const msgs = metas.get(id);
      if (!msgs?.length) throw new Error(`Mail thread not found: ${id}`);
      return { threadBizId: id, messageBizIds: msgs.map((m) => str(m.messageBizId)) };
    });
  }

  /** Add and/or remove label ids on threads (system ids like FLAGGED, ARCHIVED, or user label ids). */
  async modifyThreads(
    threadIds: string[],
    o: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    await this.change({
      multiThreadsModify: {
        threadSelector: await this.selectors(threadIds),
        addLabelIds: o.add ?? [],
        removeLabelIds: o.remove ?? [],
        isFromSearch: false,
      },
    });
  }

  /** Mark threads read (or unread with read = false). */
  async markRead(threadIds: string[], read = true): Promise<void> {
    for (const s of await this.selectors(threadIds))
      await this.change({
        threadModify: {
          ...s,
          ...(read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }),
        },
      });
  }

  flag(threadIds: string[], flagged = true): Promise<void> {
    return this.modifyThreads(threadIds, flagged ? { add: ['FLAGGED'] } : { remove: ['FLAGGED'] });
  }

  /** Archive threads (they leave the inbox), or move them back to the inbox with archived = false. */
  archive(threadIds: string[], archived = true): Promise<void> {
    return this.modifyThreads(threadIds, archived ? { add: ['ARCHIVED'] } : { add: ['INBOX'] });
  }

  /** Move threads to the trash, or restore them with trashed = false. */
  async trash(threadIds: string[], trashed = true): Promise<void> {
    const threadSelector = await this.selectors(threadIds);
    await this.change(
      trashed
        ? { trashThreads: { threadSelector, isFromSearch: false } }
        : { untrashThreads: { threadSelector } },
    );
  }

  // ---- compose ----

  /** The account's sending addresses (default first). */
  async addresses(): Promise<MailAddress[]> {
    await this.loadSenders();
    return this.senders.map(({ name, address }) => ({ name, address }));
  }

  private async loadSenders(): Promise<void> {
    if (this.sender) return;
    const resp = await this.client.api('mails.GetMailSettingsRequest', {});
    const alias = (((resp.setting ?? {}) as Dict).emailAlias ?? {}) as Dict;
    const toSender = (a: unknown) => {
      const o = (a ?? {}) as Dict;
      return { ...address(o), entityId: str(o.larkEntityId), entityType: num(o.larkEntityType) };
    };
    const def = toSender(alias.defaultAddress);
    if (!def.address) throw new Error('This account has no Lark Mail address');
    this.sender = def;
    const all = list(alias.allAddresses).map(toSender);
    this.senders = [def, ...all.filter((a) => a.address !== def.address)];
  }

  private async fromAddress(from?: string): Promise<Dict> {
    await this.loadSenders();
    const s = from
      ? this.senders.find((a) => a.address.toLowerCase() === from.toLowerCase())
      : this.sender;
    if (!s) throw new Error(`Not one of this account's addresses: ${from}`);
    return {
      name: s.name,
      address: s.address,
      ...(s.entityId ? { larkEntityType: s.entityType, larkEntityId: s.entityId } : {}),
      mailGroupType: 0,
    };
  }

  /** Upload a file to the Drive mail mount and return the attachment entry for a draft. */
  async uploadAttachment(file: MailFile): Promise<Dict> {
    const headers = {
      origin: webOrigin(this.auth.region),
      referer: `${webOrigin(this.auth.region)}/`,
      'user-agent': USER_AGENT,
    };
    const json = async (url: string, body: Dict) => {
      const res = raiseForStatus(
        await request(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          cookies: this.auth.cookies,
          body: JSON.stringify(body),
          timeoutMs: 60_000,
        }),
      );
      const j = (await res.json()) as { code?: number; message?: string; data?: Dict };
      if (j.code !== 0)
        throw new Error(`Attachment upload failed (${url}): ${j.code} ${j.message}`);
      return j.data ?? {};
    };
    const space = `${urls.spaceHost(this.auth.region)}/space/api/box/upload`;
    const prep = await json(`${space}/prepare/`, {
      mount_point: MAIL_MOUNT,
      mount_node_token: this.auth.userId,
      name: file.name,
      size: file.data.length,
      size_checker: false,
    });
    const uploadId = str(prep.upload_id);
    const blockSize = num(prep.block_size) || BLOCK_SIZE;
    const blocks = Math.max(1, Math.ceil(file.data.length / blockSize));
    for (let seq = 0; seq < blocks; seq++) {
      const block = file.data.subarray(seq * blockSize, (seq + 1) * blockSize);
      const res = raiseForStatus(
        await request(
          `${urls.driveStreamHost(this.auth.region)}/space/api/box/stream/upload/merge_block/`,
          {
            method: 'POST',
            params: { upload_id: uploadId, mount_point: MAIL_MOUNT },
            headers: {
              ...headers,
              'content-type': 'application/octet-stream',
              'x-seq-list': String(seq),
              'x-block-list-checksum': adler32(block),
              'x-block-origin-size': String(block.length),
            },
            cookies: this.auth.cookies,
            body: block,
            timeoutMs: 300_000,
          },
        ),
      );
      const j = (await res.json()) as { code?: number; message?: string };
      if (j.code !== 0)
        throw new Error(`Attachment block ${seq} upload failed: ${j.code} ${j.message}`);
    }
    const done = await json(`${space}/finish/`, {
      upload_id: uploadId,
      num_blocks: blocks,
      mount_point: MAIL_MOUNT,
      push_open_history_record: 0,
    });
    const fileKey = str(done.file_token);
    if (!fileKey) throw new Error('Attachment upload failed: no file token in the response');
    logger.info(`attachment uploaded: ${file.name} (${file.data.length} bytes)`);
    return { fileName: file.name, fileKey, type: 1, fileSize: file.data.length };
  }

  /** Download an attachment (by the fileKey from a message's attachments). */
  async downloadAttachment(fileKey: string): Promise<Uint8Array> {
    const res = raiseForStatus(
      await request(
        `${urls.internalHost(this.auth.region)}/space/api/box/stream/download/all/${encodeURIComponent(fileKey)}`,
        {
          params: { mount_point: MAIL_MOUNT },
          headers: { referer: `${webOrigin(this.auth.region)}/`, 'user-agent': USER_AGENT },
          cookies: this.auth.cookies,
          timeoutMs: 300_000,
        },
      ),
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Build the draft entity the change log takes. */
  private async buildDraft(
    d: MailDraft,
    ids: { messageId: string; threadId: string; replyTo: string },
    carried: Dict[] = [],
  ): Promise<Dict> {
    const recipients = (xs?: string[]) =>
      (xs ?? []).filter(Boolean).map((a) => ({ name: '', address: a.trim(), mailGroupType: 0 }));
    const html = d.html ?? textToHtml(d.text ?? '');
    const text = d.text ?? htmlToText(html);
    const uploaded: Dict[] = [];
    for (const f of d.attachments ?? []) uploaded.push(await this.uploadAttachment(f));
    const now = Date.now();
    return {
      meta: {
        messageBizId: ids.messageId,
        threadBizId: ids.threadId,
        labelIds: ['DRAFT'],
        isDraft: true,
        createdTime: { unit: 2, value: now },
        lastUpdatedTime: { unit: 2, value: now },
        deliveryState: 5,
      },
      content: {
        messageBizId: ids.messageId,
        replyToMessageBizId: ids.replyTo,
        content: {
          from: await this.fromAddress(d.from),
          to: recipients(d.to),
          cc: recipients(d.cc),
          bcc: recipients(d.bcc),
          subject: d.subject ?? '',
          bodyPlaintext: text,
          bodyHtml: html,
          attachments: [...carried, ...uploaded],
          language: 'unknown',
          unsubscribeOption: { type: 0, redirectedUrl: '' },
        },
      },
    };
  }

  /**
   * Compose and send (or, with o.draftOnly, just save as a draft). Returns the new message's id and thread id;
   * for a draft, messageId is the draft id that sendDraft takes.
   */
  async send(d: MailDraft, o: { draftOnly?: boolean } = {}): Promise<SendResult> {
    const id = randomUUID();
    return this.submit(d, { messageId: id, threadId: id, replyTo: '' }, [], Boolean(o.draftOnly));
  }

  private async submit(
    d: MailDraft,
    ids: { messageId: string; threadId: string; replyTo: string },
    carried: Dict[],
    draftOnly: boolean,
  ): Promise<SendResult> {
    if (!draftOnly && ![...(d.to ?? []), ...(d.cc ?? []), ...(d.bcc ?? [])].some(Boolean))
      throw new Error('No recipients (to, cc or bcc)');
    const draft = await this.buildDraft(d, ids, carried);
    // The web client always saves the draft first, then sends it
    await this.change({ draftCreateOrUpdate: { draft } });
    if (draftOnly) return { messageId: ids.messageId, threadId: ids.threadId };
    const log = await this.change({ draftSend: { draft, undoSendEnable: false } });
    const meta = (((log.change ?? {}) as Dict).draftSendSummary as Dict | undefined)?.meta as
      | Dict
      | undefined;
    if (!meta) throw new Error('Send not confirmed by the server (no send summary in the reply)');
    return { messageId: str(meta.messageBizId), threadId: str(meta.threadBizId) };
  }

  /** Send a saved draft as it is. */
  async sendDraft(draftId: string): Promise<SendResult> {
    const [m] = await this.messages([draftId]);
    if (!m?.draft) throw new Error(`Not a draft: ${draftId}`);
    const full = await this.client.api('mails.GetMailMessageFullByMessageIDsRequest', {
      messageBizIds: [draftId],
    });
    const raw = list(full.messages)[0] as Dict;
    const draft = {
      meta: { ...(raw.meta as Dict), isDraft: true, labelIds: ['DRAFT'] },
      content: raw.content,
    };
    const log = await this.change({ draftSend: { draft, undoSendEnable: false } });
    const meta = (((log.change ?? {}) as Dict).draftSendSummary as Dict | undefined)?.meta as
      | Dict
      | undefined;
    if (!meta) throw new Error('Send not confirmed by the server (no send summary in the reply)');
    return { messageId: str(meta.messageBizId), threadId: str(meta.threadBizId) };
  }

  /** Delete drafts. */
  async deleteDrafts(draftIds: string[]): Promise<void> {
    for (const id of draftIds) await this.change({ draftDelete: { messageBizId: id } });
  }

  /**
   * Reply to a message in its thread. all = reply to everyone (other recipients go to cc). Subject gets "Re: ",
   * the original is quoted below the reply.
   */
  async reply(
    messageId: string,
    d: Omit<MailDraft, 'subject'> & { all?: boolean; quote?: boolean },
    o: { draftOnly?: boolean } = {},
  ): Promise<SendResult> {
    const [orig] = await this.messages([messageId]);
    if (!orig) throw new Error(`Mail message not found: ${messageId}`);
    await this.loadSenders();
    const mine = new Set(this.senders.map((s) => s.address.toLowerCase()));
    const sentByMe = mine.has(orig.from.address.toLowerCase());
    const to = d.to?.length ? d.to : sentByMe ? orig.to.map((a) => a.address) : [orig.from.address];
    const cc = d.all
      ? [...(d.cc ?? []), ...[...orig.to, ...orig.cc].map((a) => a.address)].filter(
          (a) => !mine.has(a.toLowerCase()) && !to.includes(a),
        )
      : (d.cc ?? []);
    const html = (d.html ?? textToHtml(d.text ?? '')) + (d.quote === false ? '' : quoteBlock(orig));
    return this.submit(
      {
        ...d,
        to,
        cc: [...new Set(cc)],
        html,
        text: d.text ?? htmlToText(d.html ?? ''),
        subject: /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`,
      },
      { messageId: randomUUID(), threadId: orig.threadId, replyTo: orig.messageId },
      [],
      Boolean(o.draftOnly),
    );
  }

  /** Forward a message (with its attachments) to new recipients; the original follows the optional note. */
  async forward(
    messageId: string,
    d: Omit<MailDraft, 'subject'>,
    o: { draftOnly?: boolean } = {},
  ): Promise<SendResult> {
    const [orig] = await this.messages([messageId]);
    if (!orig) throw new Error(`Mail message not found: ${messageId}`);
    const carried = orig.attachments.map((a) => ({
      fileName: a.name,
      fileKey: a.fileKey,
      type: 1,
      fileSize: a.size,
    }));
    return this.submit(
      {
        ...d,
        html: (d.html ?? textToHtml(d.text ?? '')) + forwardBlock(orig),
        text: d.text ?? htmlToText(d.html ?? ''),
        subject: /^(fw|fwd):/i.test(orig.subject) ? orig.subject : `Fw: ${orig.subject}`,
      },
      { messageId: randomUUID(), threadId: orig.threadId, replyTo: orig.messageId },
      carried,
      Boolean(o.draftOnly),
    );
  }
}

const fmtAddr = (a: MailAddress) =>
  a.name ? `${escapeHtml(a.name)} &lt;${escapeHtml(a.address)}&gt;` : escapeHtml(a.address);

function quoteBlock(m: MailMessage): string {
  const when = new Date(m.createdAt).toUTCString();
  return `<div class="history-quote-wrapper"><div style="padding: 12px; background: rgb(245, 246, 247); border-radius: 4px; margin-top: 24px; margin-bottom: 12px;">On ${when}, ${fmtAddr(m.from)} wrote:</div><blockquote style="margin: 0; padding-left: 12px; border-left: 2px solid #dee0e3;">${m.html || textToHtml(m.text)}</blockquote></div>`;
}

function forwardBlock(m: MailMessage): string {
  const rows = [
    `From: ${fmtAddr(m.from)}`,
    `Date: ${new Date(m.createdAt).toUTCString()}`,
    `Subject: ${escapeHtml(m.subject)}`,
    `To: ${m.to.map(fmtAddr).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(fmtAddr).join(', ')}`] : []),
  ];
  return `<div class="history-quote-wrapper"><div style="margin-top: 24px;">---------- Forwarded message ----------</div><div style="padding: 12px; background: rgb(245, 246, 247); border-radius: 4px; margin-bottom: 12px;">${rows.join('<br>')}</div>${m.html || textToHtml(m.text)}</div>`;
}

type MailMethods = {
  [K in keyof LarkMail]: LarkMail[K] extends (...args: never) => unknown ? K : never;
}[keyof LarkMail];

const draftOr =
  (sendPermission: Permission) =>
  (...args: unknown[]): Permission =>
    (args.at(-1) as { draftOnly?: boolean } | undefined)?.draftOnly ? 'mail.draft' : sendPermission;

/** Library methods → permission items (same items as the `lark mail` actions); saving a draft only needs mail.draft. */
export const MAIL_METHOD_PERMISSIONS: {
  [K in MailMethods]: Permission | ((...args: Parameters<LarkMail[K]>) => Permission);
} = {
  labels: 'mail.labels',
  resolveLabel: 'mail.labels',
  addresses: 'mail.addresses',
  threads: 'mail.list',
  messages: 'mail.get',
  thread: 'mail.thread',
  search: 'mail.search',
  downloadAttachment: 'mail.download',
  uploadAttachment: 'mail.draft',
  modifyThreads: 'mail.label',
  markRead: 'mail.read',
  flag: 'mail.flag',
  archive: 'mail.archive',
  trash: 'mail.trash',
  send: draftOr('mail.send'),
  reply: draftOr('mail.reply'),
  forward: draftOr('mail.forward'),
  sendDraft: 'mail.send-draft',
  deleteDrafts: 'mail.delete-draft',
};
