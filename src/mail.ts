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
  /** Restrict to a label id (e.g. INBOX, SENT, a user label id). Trashed mail is only found with label TRASH. */
  label?: string;
  /** Restrict to a folder id (user folders; see labels()). */
  folder?: string;
  /** Time range (ms). */
  since?: number;
  until?: number;
  hasAttachment?: boolean;
  /** Only unread messages. */
  unreadOnly?: boolean;
  limit?: number;
}

/** One message from a listing or search (no body). */
export interface MailSearchHit {
  messageId: string;
  threadId: string;
  subject: string;
  summary: string;
  from: string;
  createdAt: number;
  /** The message's own labels (INBOX, UNREAD, FLAGGED, TRASH, user label ids, ...). */
  labels: string[];
  unread: boolean;
  hasAttachment: boolean;
}

/** How write actions pick their targets: message ids (default), or thread ids expanded to their messages. */
export interface MailChangeOptions {
  threads?: boolean;
}

/** Outcome of a write action, checked by re-reading the messages afterwards. */
export interface MailChangeResult {
  /** Messages that now have the requested state. */
  messageIds: string[];
  /** Messages that don't, with the reason. */
  failed: Array<{ messageId: string; reason: string }>;
}

/** What a mailbox change-log entry did; see MailEvent. */
export type MailEventKind =
  | 'received'
  | 'sent'
  | 'send-status'
  | 'draft'
  | 'labels'
  | 'trash'
  | 'untrash'
  | 'resync'
  | 'other';

/**
 * One mailbox change, from the change log (in order, each exactly once). Covers changes from every device,
 * including this one. 'resync' means the gap was too large to replay: re-list what you need.
 */
export interface MailEvent {
  /** Change-log id; ids only increase. */
  changeId: number;
  kind: MailEventKind;
  /** The server's change type, e.g. message_receive, draft_send, thread_modify, multi_threads_trash. */
  type: string;
  messageIds: string[];
  threadIds: string[];
  /** received / sent: the message's labels after the change. */
  labels: string[];
  /** labels: label ids added and removed. */
  added: string[];
  removed: string[];
  /** received / sent, with enrich: subject, sender and preview. */
  subject?: string;
  from?: string;
  summary?: string;
  /** The raw change-log entry. */
  raw: Dict;
}

export interface MailWatchOptions {
  /** Start after this change id; default: the current one (only new changes are reported). */
  fromChangeId?: number;
  /** How often to pull the change log without a push (ms); default 30 s. Pushes trigger an immediate pull. */
  pollMs?: number;
  /** Fetch subject / sender / preview for received and sent mail; default true. */
  enrich?: boolean;
  /** Called on pull failures (the watcher keeps going); default: logged as a warning. */
  onError?: (err: Error) => void;
}

export interface MailWatcher {
  /** Pull now (call it on a push; the CLI wires pushes from the long connection here). */
  trigger(): Promise<void>;
  stop(): void;
  /** Last change id processed. */
  readonly changeId: number | undefined;
}

const KIND_BY_CHANGE: Record<string, MailEventKind> = {
  messageReceivedSummary: 'received',
  draftSendSummary: 'sent',
  draftSend: 'sent',
  mailSendStatusChange: 'send-status',
  messageSendStatusChange: 'send-status',
  draftCreateOrUpdate: 'draft',
  draftCreateOrUpdateSummary: 'draft',
  draftDelete: 'draft',
  multiDraftDelete: 'draft',
  threadModify: 'labels',
  multiThreadsModify: 'labels',
  messageModify: 'labels',
  labelMarkAllRead: 'labels',
  trashThreads: 'trash',
  threadTrash: 'trash',
  messageTrash: 'trash',
  untrashThreads: 'untrash',
  threadUntrash: 'untrash',
  messageUntrash: 'untrash',
};

/** A change-log entry → MailEvent (ids and labels pulled from whichever change shape it carries). */
export function toMailEvent(changeLog: Dict): MailEvent {
  const change = (changeLog.change ?? {}) as Dict;
  const key = Object.keys(change)[0] ?? '';
  const v = (change[key] ?? {}) as Dict;
  // A received message is described by meta, except for mail sent to yourself: there meta is the sent copy and
  // priorMeta the received one (verified against the mailbox), so priorMeta wins when present
  const prior = (v.priorMeta ?? {}) as Dict;
  const meta = (
    key === 'messageReceivedSummary' && prior.messageBizId
      ? prior
      : (v.meta ?? (v.draft as Dict | undefined)?.meta ?? {})
  ) as Dict;
  const messageIds = new Set<string>();
  const threadIds = new Set<string>();
  const addId = (m: unknown, t: unknown) => {
    if (m) messageIds.add(str(m));
    if (t) threadIds.add(str(t));
  };
  addId(meta.messageBizId || v.messageBizId || v.messageId, meta.threadBizId || v.threadBizId);
  for (const id of list<string>(v.messageBizIds)) addId(id, null);
  for (const sel of list(v.threadSelector)) {
    addId(null, sel.threadBizId);
    for (const id of list<string>(sel.messageBizIds)) addId(id, null);
  }
  return {
    changeId: num(changeLog.serverChangeId),
    kind: KIND_BY_CHANGE[key] ?? 'other',
    type: str(changeLog.changeType),
    messageIds: [...messageIds],
    threadIds: [...threadIds],
    labels: list<string>(meta.labelIds).map(String),
    added: list<string>(v.addLabelIds).map(String),
    removed: list<string>(v.removeLabelIds).map(String),
    raw: changeLog,
  };
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
    const cold = await this.coldStart();
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

  /** The initial sync's mailbox snapshot: label lists and the unread counts the client's badges show. */
  private async coldStart(): Promise<Dict> {
    const resp = await this.client.api('mails.MailInitSyncRequest', { forceColdStart: true });
    return (resp.coldStart ?? {}) as Dict;
  }

  /**
   * Unread count under a label or folder id from the initial sync, per message or per thread; undefined when the
   * server doesn't report one for that id. Searches can't filter by read state, so this bounds unread listings.
   */
  private async unreadCount(id: string, per: 'message' | 'thread'): Promise<number | undefined> {
    const cold = await this.coldStart();
    const counts = (per === 'message' ? cold.mailMessageUnreadCount : cold.mailUnreadCount) as
      | Record<string, unknown>
      | undefined;
    return counts && id in counts ? num(counts[id]) : undefined;
  }

  /**
   * Resolve a label or folder by id or (case-insensitive) name; system names like "inbox" map to their ids.
   * folder is true for user folders, which listing and search address differently from labels.
   */
  async resolveTarget(nameOrId: string): Promise<{ id: string; folder: boolean }> {
    const key = nameOrId.trim();
    const sys = (MAIL_LABELS as Record<string, string>)[key.toLowerCase()];
    if (sys) return { id: sys, folder: false };
    if ((Object.values(MAIL_LABELS) as string[]).includes(key)) return { id: key, folder: false };
    const found = (await this.labels()).find(
      (l) => l.id === key || l.name.toLowerCase() === key.toLowerCase(),
    );
    if (found) return { id: found.id, folder: found.kind === 'folder' };
    // Other system ids (e.g. READ_RECEIPT_REQUEST) and label ids not in the lists pass through as they are
    if (/^[A-Z_]+$/.test(key) || /^\d+$/.test(key)) return { id: key, folder: false };
    throw new Error(`Unknown mail label or folder: ${nameOrId}`);
  }

  /** Resolve a label by id or name (see resolveTarget); returns the id. */
  async resolveLabel(nameOrId: string): Promise<string> {
    return (await this.resolveTarget(nameOrId)).id;
  }

  /**
   * Messages under a label or folder, newest first, one entry per message (like the desktop client's list, and
   * unlike threads(), which groups by conversation and can hide individual copies). until (ms) lists older mail:
   * pass the last entry's createdAt to page.
   */
  async list(
    labelOrFolder = 'INBOX',
    o: { limit?: number; until?: number; unreadOnly?: boolean } = {},
  ): Promise<MailSearchHit[]> {
    const t = await this.resolveTarget(labelOrFolder);
    let limit = o.limit ?? 20;
    // Read state is filtered client-side, which would page through the whole label to prove there's nothing more;
    // the server's unread count says when to stop (and that there's nothing to look for when it's zero)
    if (o.unreadOnly) limit = Math.min(limit, (await this.unreadCount(t.id, 'message')) ?? limit);
    if (limit <= 0) return [];
    return this.search('', {
      ...(t.folder ? { folder: t.id } : { label: t.id }),
      ...(o.until ? { until: o.until } : {}),
      ...(o.unreadOnly ? { unreadOnly: true } : {}),
      limit,
    });
  }

  /**
   * Threads under a label, newest first, up to limit. before (ms) continues an earlier listing: pass the last
   * thread's updatedAt to get the next page. unreadOnly keeps threads with unread mail, bounded by the server's unread
   * thread count like list().
   */
  async threads(
    label = 'INBOX',
    o: { limit?: number; before?: number; unreadOnly?: boolean } = {},
  ): Promise<MailThread[]> {
    let limit = o.limit ?? 20;
    if (o.unreadOnly) limit = Math.min(limit, (await this.unreadCount(label, 'thread')) ?? limit);
    const out: MailThread[] = [];
    let before = o.before;
    for (let page = 0; out.length < limit && page < (o.unreadOnly ? 40 : 1000); page++) {
      const resp = await this.client.api('mails.GetMailThreadMetaRequest', {
        labelId: label,
        pageSize: o.unreadOnly ? 50 : Math.min(50, limit - out.length),
        requestParams: {
          timestampOperator: before ? OLDER_THAN : NEWER_THAN,
          timestamp: before ?? 0,
          orderBy: TIME_DESC,
        },
        useClientFg: true,
        useInboxTypeFg: true,
      });
      const threads = list(resp.threads);
      for (const t of threads) {
        const metas = list(t.messages);
        const unread = metas.some((m) => list<string>(m.labelIds).includes('UNREAD'));
        if ((o.unreadOnly && !unread) || out.length >= limit) continue;
        out.push({
          threadId: str(t.threadBizId),
          messageIds: metas.map((m) => str(m.messageBizId)),
          latest: null,
          messageCount: metas.length,
          unread,
          labels: [...new Set(metas.flatMap((m) => list<string>(m.labelIds).map(String)))],
          updatedAt: num(t.sortTimestamp),
        });
      }
      if (!threads.length || !resp.hasMore) break;
      before = num(threads.at(-1)?.sortTimestamp);
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

  /**
   * A whole conversation, oldest message first, with bodies and attachments (drafts included). Includes copies the
   * server's thread listing leaves out (e.g. the received copy of mail sent to yourself); see threadMembers.
   */
  async thread(threadId: string): Promise<MailMessage[]> {
    const ids = (await this.threadMembers([threadId], true)).get(threadId) ?? [];
    if (!ids.length) throw new Error(`Mail thread not found: ${threadId}`);
    const msgs = await this.messages(ids);
    return msgs.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Thread id → all its message ids. The server's thread listing can leave out copies whose labels differ from the
   * rest of the thread (e.g. the received copy of mail sent to yourself), so the thread's subject is also searched
   * message by message and hits with the same thread id are added. includeTrash also searches the trash.
   */
  async threadMembers(threadIds: string[], includeTrash = false): Promise<Map<string, string[]>> {
    const metas = await this.threadMetas(threadIds);
    const out = new Map<string, string[]>();
    const subjects = new Map<string, string>();
    const firstIds = new Map<string, string>();
    for (const id of threadIds) {
      const ids = (metas.get(id) ?? []).map((m) => str(m.messageBizId));
      out.set(id, ids);
      if (ids[0]) firstIds.set(id, ids[0]);
    }
    const firsts = [...firstIds.values()];
    const byMsg = new Map<string, string>();
    for (let i = 0; i < firsts.length; i += SUMMARY_BATCH) {
      const resp = await this.client.api('mails.GetMailMessageSummaryRequest', {
        messageBizIds: firsts.slice(i, i + SUMMARY_BATCH),
      });
      for (const x of list(resp.messageSummaries))
        byMsg.set(str(x.messageBizId), str(((x.content ?? {}) as Dict).subject));
    }
    for (const [t, m] of firstIds) subjects.set(t, byMsg.get(m) ?? '');
    // One or two searches per thread; run a few threads at a time rather than all in sequence
    const todo = [...subjects];
    const worker = async () => {
      for (let next = todo.shift(); next; next = todo.shift()) {
        const [threadId, subject] = next;
        const core = subject.replace(/^(\s*(re|fw|fwd|aw|wg)\s*:)+/i, '').trim();
        if (!core) continue;
        const [inbox, trash] = await Promise.all([
          this.search(core, { limit: 100 }),
          includeTrash ? this.search(core, { label: 'TRASH', limit: 100 }) : [],
        ]);
        const ids = out.get(threadId) as string[];
        for (const h of [...inbox, ...trash])
          if (h.threadId === threadId && !ids.includes(h.messageId)) ids.push(h.messageId);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return out;
  }

  /**
   * Message-by-message search (server-side), newest first. An empty keyword lists everything under label/folder.
   * Trashed mail is only found with label TRASH.
   */
  async search(keyword: string, o: MailSearchOptions = {}): Promise<MailSearchHit[]> {
    const limit = o.limit ?? 20;
    const out: MailSearchHit[] = [];
    let session = '';
    let offset = 0;
    // unreadOnly filters client-side, so allow extra pages to find enough matches
    for (let page = 0; page < (o.unreadOnly ? 40 : 20) && out.length < limit; page++) {
      const resp = await this.client.api('mails.MailAdvancedSearchRequest', {
        keyword,
        fromList: o.from ?? [],
        toList: o.to ?? [],
        subjectList: o.subject ?? [],
        // Milliseconds, unlike most Lark timestamps
        startDate: o.since ?? 0,
        endDate: o.until ?? 0,
        hasAttachment: Boolean(o.hasAttachment),
        label: o.label ?? '',
        ...(o.folder ? { folder: o.folder, isFolderEnabled: true } : {}),
        isConversationModeEnable: false,
        searchSession: session,
        pageSize: 50,
        offset,
      });
      const hits = list(resp.msgSummary);
      offset += hits.length;
      for (const h of hits) {
        const labels = list<string>(h.messageLabels ?? h.labels).map(String);
        const hit: MailSearchHit = {
          messageId: str(h.messageId),
          threadId: str(h.threadId),
          subject: str(h.subjectSummary).replace(/<\/?[a-z][^>]*>/gi, ''),
          summary: str(h.bodyPlaintextSummary).replace(/<\/?[a-z][^>]*>/gi, ''),
          from: str(h.from),
          createdAt: millis(h.createdTimestamp || h.lastMessageTimestamp),
          labels,
          unread: labels.includes('UNREAD'),
          hasAttachment: Boolean(h.hasAttachment),
        };
        if (!o.unreadOnly || hit.unread) out.push(hit);
      }
      session = str(resp.searchSession);
      if (!hits.length || !resp.hasMore) break;
    }
    // The server doesn't keep every folder strictly newest-first
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  // ---- change log ----

  /**
   * Mailbox changes after changeId, oldest first. When the gap is too large for the server to replay, returns a
   * single 'resync' event. enrich (default true) adds subject / sender / preview to received and sent mail.
   */
  async changesSince(
    changeId: number,
    o: { enrich?: boolean } = {},
  ): Promise<{ events: MailEvent[]; lastChangeId: number }> {
    const events: MailEvent[] = [];
    let cursor = changeId;
    let last = changeId;
    for (let round = 0; round < 20; round++) {
      const resp = await this.client.api('mails.MailInitSyncRequest', {
        lastSyncedCommitId: cursor,
        shouldReturnChangeLogs: true,
      });
      last = Math.max(last, num(resp.lastChangeId));
      const logs = list(((resp.changeLogResponse ?? {}) as Dict).changeLogs);
      if (!logs.length) {
        if (resp.coldStart && last > cursor)
          events.push({
            ...toMailEvent({ serverChangeId: last, changeType: 'resync' }),
            kind: 'resync',
          });
        cursor = last;
        break;
      }
      const before = cursor;
      for (const l of logs.sort((a, b) => num(a.serverChangeId) - num(b.serverChangeId)))
        if (num(l.serverChangeId) > cursor) {
          // no_op entries record writes that changed nothing
          if (str(l.changeType) !== 'no_op') events.push(toMailEvent(l));
          cursor = num(l.serverChangeId);
        }
      // Stop when a round brings nothing new, instead of repeating the same request
      if (cursor >= last || cursor === before) break;
    }
    if (o.enrich ?? true) await this.enrichEvents(events);
    return { events, lastChangeId: Math.max(cursor, last) };
  }

  private async enrichEvents(events: MailEvent[]): Promise<void> {
    const want = events.filter(
      (e) => (e.kind === 'received' || e.kind === 'sent') && e.messageIds[0],
    );
    const ids = [...new Set(want.map((e) => e.messageIds[0] as string))];
    const byId = new Map<string, Dict>();
    for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
      const resp = await this.client.api('mails.GetMailMessageSummaryRequest', {
        messageBizIds: ids.slice(i, i + SUMMARY_BATCH),
      });
      for (const s of list(resp.messageSummaries)) byId.set(str(s.messageBizId), s);
    }
    for (const e of want) {
      const m = byId.get(e.messageIds[0] as string);
      if (!m) continue;
      const msg = toMailMessage(null, m);
      e.subject = msg.subject;
      e.from = msg.from.name ? `${msg.from.name} <${msg.from.address}>` : msg.from.address;
      e.summary = msg.summary;
    }
  }

  /**
   * Follow the mailbox change log: onEvent gets every change in order, once. Pulls on trigger() (wire the long
   * connection's mail pushes to it) and every pollMs, which also covers changes the server doesn't push to this
   * device (e.g. ones made by this process). Stop with stop().
   */
  async watch(
    onEvent: (e: MailEvent) => void | Promise<void>,
    o: MailWatchOptions = {},
  ): Promise<MailWatcher> {
    let cursor = o.fromChangeId ?? (await this.syncChangeId());
    let stopped = false;
    let running: Promise<void> | null = null;
    let again = false;
    const pull = async (): Promise<void> => {
      if (stopped) return;
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          try {
            const r = await this.changesSince(cursor, { enrich: o.enrich ?? true });
            for (const e of r.events) {
              if (stopped) return;
              await onEvent(e);
              cursor = Math.max(cursor, e.changeId);
            }
            cursor = Math.max(cursor, r.lastChangeId);
          } catch (err) {
            if (o.onError) o.onError(err as Error);
            else logger.warning(`mail change pull failed: ${(err as Error).message}`);
          }
        } while (again && !stopped);
      })().finally(() => {
        running = null;
      });
      return running;
    };
    const timer = setInterval(() => void pull(), o.pollMs ?? 30_000);
    return {
      trigger: pull,
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
      get changeId() {
        return cursor;
      },
    };
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

  /**
   * Thread selectors for the change log, listing exactly the target messages. The server applies a thread-level
   * change to the listed message ids only, which makes it a precise per-message operation (the message-level change
   * types are accepted but don't take effect for read state, archive or trash).
   */
  private async selectors(ids: string[], o: MailChangeOptions): Promise<ThreadSelector[]> {
    const byThread = new Map<string, string[]>();
    if (o.threads) {
      const members = await this.threadMembers(ids, true);
      for (const id of ids) {
        const m = members.get(id) ?? [];
        if (!m.length) throw new Error(`Mail thread not found: ${id}`);
        byThread.set(id, m);
      }
    } else {
      const msgs = await this.messages(ids);
      const missing = ids.filter((id) => !msgs.some((m) => m.messageId === id));
      if (missing.length) throw new Error(`Mail message not found: ${missing.join(', ')}`);
      for (const m of msgs)
        byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m.messageId]);
    }
    return [...byThread].map(([threadBizId, messageBizIds]) => ({ threadBizId, messageBizIds }));
  }

  /** Submit the changes, then re-read the messages and report which ones reached the expected state. */
  private async apply(
    ids: string[],
    o: MailChangeOptions,
    build: (sel: ThreadSelector[]) => Dict[],
    expect: (labels: string[]) => boolean,
  ): Promise<MailChangeResult> {
    const sel = await this.selectors(ids, o);
    for (const ch of build(sel)) await this.change(ch);
    const targets = sel.flatMap((x) => x.messageBizIds);
    let pending = targets;
    const gone = new Set<string>();
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const now = new Map((await this.messages(pending)).map((m) => [m.messageId, m.labels]));
      gone.clear();
      for (const id of pending) if (!now.has(id)) gone.add(id);
      pending = pending.filter((id) => !now.has(id) || !expect(now.get(id) as string[]));
    }
    return {
      messageIds: targets.filter((id) => !pending.includes(id)),
      failed: pending.map((messageId) => ({
        messageId,
        reason: gone.has(messageId)
          ? 'message not found after the update'
          : 'state unchanged after the update',
      })),
    };
  }

  private labelChange(add: string[], remove: string[]) {
    return (sel: ThreadSelector[]) => [
      {
        multiThreadsModify: {
          threadSelector: sel,
          addLabelIds: add,
          removeLabelIds: remove,
          isFromSearch: true,
        },
      },
    ];
  }

  /** Add and/or remove label ids (system ids like FLAGGED, or user label ids) on messages (or whole threads). */
  modify(
    ids: string[],
    l: { add?: string[]; remove?: string[] },
    o: MailChangeOptions = {},
  ): Promise<MailChangeResult> {
    const add = l.add ?? [];
    const remove = l.remove ?? [];
    return this.apply(
      ids,
      o,
      this.labelChange(add, remove),
      (labels) => add.every((x) => labels.includes(x)) && !remove.some((x) => labels.includes(x)),
    );
  }

  /** Mark messages (or whole threads) read, or unread with read = false. */
  markRead(ids: string[], read = true, o: MailChangeOptions = {}): Promise<MailChangeResult> {
    return this.apply(
      ids,
      o,
      (sel) =>
        sel.map((s) => ({
          threadModify: {
            ...s,
            ...(read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }),
          },
        })),
      (labels) => labels.includes('UNREAD') !== read,
    );
  }

  flag(ids: string[], flagged = true, o: MailChangeOptions = {}): Promise<MailChangeResult> {
    return this.modify(ids, flagged ? { add: ['FLAGGED'] } : { remove: ['FLAGGED'] }, o);
  }

  /** Archive (they leave the inbox), or move back to the inbox with archived = false. */
  archive(ids: string[], archived = true, o: MailChangeOptions = {}): Promise<MailChangeResult> {
    return this.apply(ids, o, this.labelChange([archived ? 'ARCHIVED' : 'INBOX'], []), (labels) =>
      archived
        ? labels.includes('ARCHIVED') && !labels.includes('INBOX')
        : labels.includes('INBOX'),
    );
  }

  /** Move to the trash, or restore with trashed = false. */
  trash(ids: string[], trashed = true, o: MailChangeOptions = {}): Promise<MailChangeResult> {
    return this.apply(
      ids,
      o,
      (sel) => [
        trashed
          ? { trashThreads: { threadSelector: sel, isFromSearch: true } }
          : { untrashThreads: { threadSelector: sel } },
      ],
      (labels) => labels.includes('TRASH') === trashed,
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
  modify: 'mail.label',
  list: 'mail.list',
  resolveTarget: 'mail.labels',
  threadMembers: 'mail.thread',
  changesSince: 'mail.watch',
  watch: 'mail.watch',
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
