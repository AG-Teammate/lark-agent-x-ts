import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from './auth.js';
import { HttpError, NetworkError, request, USER_AGENT } from './http.js';
import { accessKey, longRequestId, requestCid, requestId } from './ids.js';
import { getLogger } from './log.js';
import { LarkMail, MAIL_METHOD_PERMISSIONS } from './mail.js';
import { uploadFile, uploadImage } from './media.js';
import {
  authorize,
  checkSource,
  guardMethods,
  type Permission,
  type PermissionSource,
} from './permissions.js';
import {
  buildCreateChatPacket,
  buildFileMessagePacket,
  buildGroupInfoPacket,
  buildImageMessagePacket,
  buildMarkdownMessagePacket,
  buildPostMessagePacket,
  buildRichMessagePacket,
  buildSearchPacket,
  buildSendMessagePacket,
  buildUserInfoPacket,
  decodeGroupInfoResponse,
  decodePutChatResponse,
  decodePutMessageResponse,
  decodeSearchResponse,
  decodeUserInfoResponse,
  type EditableContent,
  type RichBlock,
  richTextOf,
  type SearchHit,
} from './proto/builders.js';
import {
  decodePushMessages,
  decodePushReactions,
  enumToInt,
  isThreadChat,
  type LarkMessage,
  parseWsFrame,
  type ReactionEvent,
  resolveScope,
  toLarkMessage,
} from './proto/decoders.js';
import { type Dict, fromDict, toDict } from './proto/dict.js';
import { larkType, protoType, resolveCmd } from './proto/registry.js';
import { urls, webOrigin } from './region.js';

const logger = getLogger('larkx.client');

type Packet = Message;

// Enum values for feed.PullFeedCardsRequest (FeedType.INBOX, PullType, PullFeedType.INBOX, BusinessType.LARK) and FeedCard.Type.CHAT
const FEED_INBOX = 1;
const PULL_REFRESH = 1;
const PULL_LOAD_MORE = 2;
const PULL_FEED_INBOX = 2;
const BUSINESS_LARK = 1;
const CARD_CHAT = 1;
// entities.Chat.Type.P2P
const CHAT_P2P = 1;

export interface SendOptions {
  /** Reply into a thread (root message id). */
  rootId?: string | undefined;
  /** Quote a message (when quoting inside a thread, also pass rootId). */
  replyTo?: string | undefined;
  /**
   * Client-side message id used for idempotency: the server dedupes on it, so resending with the same cid yields the same message.
   * Randomly generated if omitted; to resend after a SendUnconfirmed, reuse the cid it carries and no duplicate will be sent.
   */
  cid?: string | undefined;
  /** Number of automatic retries with the same cid on network errors, 5xx, or a missing message id. Default 2. */
  retries?: number | undefined;
}

/**
 * sendMessage content: plain text, structured rich text (text is a plain-text summary), HTML rich text, Markdown (rendered as Markdown by the client), an image, or a file.
 * Images and files are passed as raw bytes and uploaded automatically before sending; name is the file name (shown in file messages; for images it only indicates the format).
 */
export type MessageContent =
  | { text: string; links?: boolean }
  | { blocks: RichBlock[]; text: string }
  | { html: string; title?: string }
  | { markdown: string; title?: string }
  | { image: Uint8Array; name?: string }
  | { file: Uint8Array; name: string };

/** The server accepted the send request but returned no message id, so delivery can't be confirmed; resending with the cid won't duplicate. */
export class SendUnconfirmed extends Error {
  constructor(
    message: string,
    readonly cid = '',
  ) {
    super(message);
  }
}

export type MessageHandler = (msg: LarkMessage) => Promise<void>;
export type ReactionHandler = (event: ReactionEvent) => Promise<void>;

/** A chat in the inbox: the feed card's update time plus chat info. */
export interface RecentChat {
  chatId: string;
  /** Time of the chat's most recent change (ms). */
  updatedAt: number;
  /** Chat info (entities.Chat, same as getChatInfo); null if the server didn't include it. */
  chat: Dict | null;
}

/** A chat from the server-side chat list (the inbox feed), as returned by listChats. */
export interface ListedChat {
  chatId: string;
  /** Group name; for a direct chat, the other member's display name (your own name for the self-chat). */
  name: string;
  /** 1 = direct chat, 2 = group chat, 3 = legacy thread group (new-style thread groups are also 2; check threadChat). */
  chatType: number;
  threadChat: boolean;
  /** Time of the chat's most recent change (ms). */
  updatedAt: number;
  /** Unread message count, as on the client badge. */
  unread: number;
  memberCount: number;
}

/** A chat with unread messages: unread is the chat's unread count (thread groups count new threads separately). */
export interface UnreadChat {
  chatId: string;
  name: string;
  /** 1 = direct chat, 2 = group chat, 3 = legacy thread group (new-style thread groups are also 2; check threadChat). */
  chatType: number;
  threadChat: boolean;
  unread: number;
  /** Number of unread new threads in a thread group. */
  unreadThreads: number;
}

/** Cross-chat message search criteria; times are millisecond timestamps. */
export interface MessageSearchOptions {
  /** Search only these chats. */
  chatIds?: string[] | undefined;
  /** Only messages sent by these users. */
  fromIds?: string[] | undefined;
  since?: number | undefined;
  until?: number | undefined;
  /** Maximum number of results, default 20. */
  limit?: number | undefined;
}

/** A search hit: summary is the server-provided snippet ("sender: content…" in the server's locale, with highlight markup stripped); chatTitle is the chat name. */
export interface MessageHit {
  msgId: string;
  chatId: string;
  chatTitle: string;
  fromId: string;
  /** Timestamp in seconds. */
  createTime: number;
  position: number | null;
  msgType: number;
  p2p: boolean;
  summary: string;
}

const SEARCH_ENTITY_MESSAGE = 5;
const unhighlight = (s: unknown) => String(s ?? '').replace(/<\/?h>/g, '');

/** Read status of a message (from the sender's perspective): who has read it and who hasn't. */
export interface ReadState {
  messageId: string;
  readCount: number;
  unreadCount: number;
  readUserIds: string[];
  unreadUserIds: string[];
  /** The most recent reader and when they read it (seconds). */
  lastRead: { userId: string; time: number } | null;
}

/** A flag (one entry in the client's "Flagged" list): a flagged message or chat; message flags include the message itself. */
export interface FlagItem {
  type: 'message' | 'chat';
  id: string;
  /** Time flagged (ms). */
  createTime: number;
  message: LarkMessage | null;
}

/** A pinned message in a chat. */
export interface PinnedMessage {
  pinId: string;
  messageId: string;
  /** Who pinned it. */
  pinnedBy: string;
  /** Time pinned (ms). */
  pinnedAt: number;
  message: LarkMessage | null;
}

/** A scheduled message not yet sent. at is the planned send time (ms). */
export interface ScheduledMessage {
  messageId: string;
  at: number;
  status: 'pending' | 'suspended';
  message: LarkMessage | null;
}

// ScheduleMessage.Status, PullChatScheduleMessagesRequest.EntityType, PatchScheduleMessageRequest.PatchType
const SCHEDULE_PENDING = 1;
const SCHEDULE_SUSPEND = 2;
const SCHEDULE_CHAT_ONLY = 1;
const SCHEDULE_PATCH_UPDATE = 1;
const SCHEDULE_PATCH_DELETE = 3;

/** A label (group) in the chat list. keyword marks labels that auto-sort chats by keyword. */
export interface FeedGroup {
  id: string;
  name: string;
  type: 'normal' | 'keyword' | 'unknown';
}

/** Max labels / label items per page (the server rejects an overly large count with invalid request). */
const FEED_GROUP_PAGE = 20;

// translate.ContentType.TEXT
const TRANSLATE_TEXT = 2;

// feed.Shortcut.Type.CHAT
const SHORTCUT_CHAT = 1;

// feed.FlagItem.FlagType and FeedCard.Type.CHAT
const FLAG_FEED = 1;
const FLAG_MESSAGE = 2;

/** An emoji reaction on a message. */
export interface MessageReactions {
  messageId: string;
  reactions: { type: string; count: number; userIds: string[] }[];
}

/** A group member (or a user looked up by id). name is already resolved as alias > display name in current locale > default name. */
export interface ChatMember {
  id: string;
  name: string;
  type: 'user' | 'bot' | 'ai' | 'unknown';
}

const CHATTER_TYPES: Record<number, ChatMember['type']> = { 1: 'user', 2: 'bot', 3: 'ai' };

/** entities.Chatter -> display name: the user's own alias first, then the display name in the current locale, then the default display name and name. */
export function chatterName(v: Dict, locale = 'zh_CN'): string {
  const display = (v.displayName ?? {}) as {
    defaultVal?: string;
    i18nVals?: Record<string, string>;
  };
  return String(
    v.alias ||
      display.i18nVals?.[locale.toLowerCase()] ||
      display.defaultVal ||
      v.name ||
      v.enUsName ||
      '',
  );
}

const toMember = (id: string, v: Dict, locale: string): ChatMember => ({
  id,
  name: chatterName(v, locale),
  type: CHATTER_TYPES[enumToInt(v.type ?? 0)] ?? 'unknown',
});

/** Local state to consult when backfilling messages missed during a disconnect (all optional; omitted means nothing is stored locally). */
export interface MissedOptions {
  /** Highest position stored locally for this chat, or -1 if none (chat positions start at 0); only messages after it are pulled, reducing duplicates. */
  localPosition?: (chatId: string) => Promise<number>;
  /** Thread ids seen locally for this chat: thread replies in regular groups don't take a chat position, so they can only be looked up per thread. */
  knownThreads?: (chatId: string) => Promise<string[]>;
  /** How many messages to look back per chat (or thread), default 200. */
  maxPerChat?: number;
}

const CHANNEL_CHAT = 1;
// Chat.ChatMode.THREAD_V2 (new-style thread group); NAME and DESCRIPTION of PatchGroupChatRequest.UpdateFields
const CHAT_MODE_THREAD_V2 = 3;
const GROUP_FIELD_NAME = 1;
const GROUP_FIELD_DESCRIPTION = 3;
/** Websocket push: reaction changes (reactions.PushReactions). */
const PUSH_REACTIONS = 27;
// Lark Mail change-log push (mailchanges.MailProcessedChangePushRequest); cmd from the mail web client
const PUSH_MAIL_CHANGE = 3603;
/** Number of threads to look back at a time in a thread group. */
const RECENT_THREADS = 20;

const int = (v: unknown, dflt = -1): number =>
  v === undefined || v === null ? dflt : Number(v as number | bigint);

/** On gateway errors the response body is still a Packet with the error text in the sid field; empty string if it can't be decoded. */
async function gatewayReason(res: Response): Promise<string> {
  try {
    const pkt = fromBinary(protoType('Packet'), new Uint8Array(await res.arrayBuffer()));
    return (pkt as unknown as { sid?: string }).sid ?? '';
  } catch {
    return '';
  }
}

/** Receives each Lark Mail change-log entry pushed over the long connection (a hint; LarkMail.watch pulls the full log). */
export type MailChangeHandler = (changeLog: Dict) => void | Promise<void>;

export interface ClientOptions {
  /**
   * Permission check: `true` uses the same rules as the CLI (the account's own rules, else `LARKX_ALLOW` / `LARKX_DENY`), or pass a fixed rule set;
   * disallowed methods throw PermissionDenied. If omitted, nothing is checked and everything is allowed.
   */
  permissions?: PermissionSource;
}

/** Web-protocol client: gateway requests (HTTP + protobuf) and the message long connection. */
export class LarkClient {
  private readonly threadChats = new Map<string, boolean>();
  private mailbox: LarkMail | undefined;
  private permissionCheck: ((p: Permission) => void) | undefined;
  private readonly chatterNames = new Map<string, string>();

  private constructor(readonly auth: LarkAuth) {}

  /** Validate credentials (throws AuthExpired if invalid); fetch and save app_key / user_id if missing. */
  static async create(auth: LarkAuth, o: ClientOptions = {}): Promise<LarkClient> {
    await auth.requireValid();
    if (!auth.appKey || !auth.userId) {
      await auth.validate(true);
      auth.save();
    }
    const client = new LarkClient(auth);
    const source = o.permissions;
    if (source) {
      checkSource(auth, source);
      client.permissionCheck = (p) => authorize(auth, source, p);
      guardMethods(client, METHOD_PERMISSIONS, client.permissionCheck);
    }
    return client;
  }

  async buildWsUrl(): Promise<string> {
    const deviceId = this.auth.deviceId;
    const params = new URLSearchParams({
      accept_encoding: 'gzip',
      sdk_version: '7.72.8',
      version_code: '7.72.8',
      type: 'sdk_main',
      platform: '',
      terminal_type: '2',
      device_model: '',
      lark_version: '7.72.0',
      net_status: '5',
      lark_env: 'online',
      request_id: requestId(),
      aid: '1',
      fpid: '2',
      device_id: deviceId,
      access_key: accessKey(`2${this.auth.appKey}${deviceId}f8a69f1719916z`),
      ticket: await this.auth.getTicket(),
    });
    return `${urls.ws(this.auth.region)}?${params}`;
  }

  private static wrapFrame(packet: Packet): Uint8Array {
    const seconds = BigInt(Math.floor(Date.now() / 1000));
    const frame = create(protoType('Frame'), {
      seqid: seconds,
      logid: seconds,
      service: 1,
      method: 1,
      headers: [{ key: 'x-request-time', value: String(Date.now()) }],
      payloadType: 'pb',
      payload: toBinary(protoType('Packet'), packet),
    } as Record<string, unknown>);
    return toBinary(protoType('Frame'), frame);
  }

  private static packet(fields: Record<string, unknown>): Packet {
    return create(protoType('Packet'), { payloadType: 1, ...fields });
  }

  /**
   * Websocket timings: handshake timeout, heartbeat interval, and how long without any frame counts as disconnected.
   * The server answers every heartbeat with a frame (cmd=200), so two heartbeat periods with nothing received means the connection is dead.
   */
  wsTiming = { openTimeoutMs: 15_000, heartbeatMs: 30_000, idleTimeoutMs: 65_000 };

  /**
   * Connect to the message long connection and keep receiving until it closes (returns on normal close or signal abort, throws on error).
   * Every frame with a sid is ACKed, application-level heartbeats are sent per wsTiming, and messages in pushes (cmd=6) are handed to onMessage serially in arrival order.
   * Handshake timeout and unanswered heartbeats are treated as abnormal disconnects; the caller reconnects.
   * onOpen is called once after connecting: all later messages will be pushed, so this is the place to backfill messages missed while disconnected.
   * onReaction receives reaction changes (push cmd=27: who added / removed which reaction on which message), on the same serial queue as messages.
   */
  async connectWebsocket(
    onMessage: MessageHandler,
    signal?: AbortSignal,
    onOpen?: () => void,
    onReaction?: ReactionHandler,
    onMailChange?: MailChangeHandler,
  ): Promise<void> {
    const url = await this.buildWsUrl();
    const { openTimeoutMs, heartbeatMs, idleTimeoutMs } = this.wsTiming;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let chain = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lastFrameAt = Date.now();
      let settled = false;
      // Node's WebSocket may fire neither error nor close when the handshake fails, so cleanup can't rely on the close event alone
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        clearInterval(heartbeat);
        signal?.removeEventListener('abort', onAbort);
        if (ws.readyState !== WebSocket.CLOSED) {
          if (err) ws.close();
          else ws.close(1000, 'stopped');
        }
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish();
      const openTimer = setTimeout(
        () => finish(new Error(`WS handshake timed out (${openTimeoutMs}ms)`)),
        openTimeoutMs,
      );
      if (signal?.aborted) return finish();
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        clearTimeout(openTimer);
        lastFrameAt = Date.now();
        logger.info('WS connected');
        onOpen?.();
        heartbeat = setInterval(() => {
          if (Date.now() - lastFrameAt > idleTimeoutMs)
            return finish(new Error(`WS heartbeat lost: no frames received in ${idleTimeoutMs}ms`));
          try {
            ws.send(LarkClient.wrapFrame(LarkClient.packet({ cmd: 4 })));
          } catch (err) {
            finish(new Error(`WS heartbeat send failed: ${(err as Error).message}`));
          }
        }, heartbeatMs);
      });
      ws.addEventListener('message', (ev) => {
        if (settled || !(ev.data instanceof ArrayBuffer)) return;
        lastFrameAt = Date.now();
        const raw = new Uint8Array(ev.data);
        try {
          const [, packet] = parseWsFrame(raw);
          if (packet.sid !== undefined) {
            ws.send(
              LarkClient.wrapFrame(
                LarkClient.packet({ cmd: 1, sid: packet.sid, payload: Uint8Array.of(0x08, 0x00) }),
              ),
            );
          }
          if (packet.cmd === PUSH_REACTIONS && onReaction && packet.payload) {
            for (const ev of decodePushReactions(packet.payload as Uint8Array))
              chain = chain.then(() =>
                onReaction(ev).catch((err) =>
                  logger.error(`reaction callback error: ${(err as Error).message}`),
                ),
              );
            return;
          }
          if (packet.cmd === PUSH_MAIL_CHANGE && onMailChange && packet.payload) {
            const T = larkType('mailchanges.MailProcessedChangePushRequest');
            const push = toDict(T, fromBinary(T, packet.payload as Uint8Array));
            const log = (push.changeLog ?? {}) as Dict;
            chain = chain.then(() =>
              Promise.resolve(onMailChange(log)).catch((err) =>
                logger.error(`mail change callback error: ${(err as Error).message}`),
              ),
            );
            return;
          }
          if (packet.cmd !== 6) return;
          for (const msg of decodePushMessages(raw)) {
            if (!msg.from_id) continue;
            chain = chain.then(() => this.dispatch(msg, onMessage));
          }
        } catch (err) {
          logger.debug(`skipping bad frame: ${(err as Error).message}`);
        }
      });
      ws.addEventListener('error', () => {
        // The actual reason arrives in the subsequent close event
      });
      ws.addEventListener('close', (ev) => {
        if (ev.code === 1000 || signal?.aborted) finish();
        else
          finish(
            new Error(`WS connection closed: code=${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`),
          );
      });
    });
    await chain;
  }

  /** Pushes and fetch-by-id results don't carry the chat mode; a thread group's root message must check chatMode before it can be assigned to its own thread. */
  private async fixThreadScope(msg: LarkMessage): Promise<LarkMessage> {
    if (msg.scope === 'chat' && msg.chat_type === 2 && (await this.isThreadChat(msg.chat_id)))
      [msg.scope, msg.anchor] = resolveScope(msg.msg_id, msg.msg_type, 2, '', '', true);
    return msg;
  }

  private async dispatch(msg: LarkMessage, onMessage: MessageHandler): Promise<void> {
    try {
      await onMessage(await this.fixThreadScope(msg));
    } catch (err) {
      logger.error(`message callback error: ${(err as Error).message}`);
    }
  }

  /** Lark Mail for this account (same credentials and permission rules as the client). */
  get mail(): LarkMail {
    if (!this.mailbox) {
      this.mailbox = new LarkMail(this);
      if (this.permissionCheck)
        guardMethods(this.mailbox, MAIL_METHOD_PERMISSIONS, this.permissionCheck);
    }
    return this.mailbox;
  }

  async gatewayPost(packet: Packet): Promise<Uint8Array> {
    const cmd = (packet as unknown as { cmd: number }).cmd;
    const res = await request(urls.gateway(this.auth.region), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        accept: '*/*',
        origin: webOrigin(this.auth.region),
        referer: `${webOrigin(this.auth.region)}/`,
        'user-agent': USER_AGENT,
        'x-appid': this.auth.gatewayAppId,
        'x-command': String(cmd),
        'x-command-version': '5.7.0',
        'x-lgw-os-type': '1',
        'x-lgw-terminal-type': '2',
        'x-source': 'web',
        'x-web-version': '3.9.32',
        'x-request-id': longRequestId(),
      },
      cookies: this.auth.cookies,
      body: toBinary(protoType('Packet'), packet),
    });
    if (!res.ok) throw new HttpError(res.status, res.statusText, res.url, await gatewayReason(res));
    return new Uint8Array(await res.arrayBuffer());
  }

  private async threadTarget(chatId: string, o: SendOptions) {
    return {
      chatId,
      rootId: o.rootId,
      replyTo: o.replyTo,
      threadChat: Boolean(o.rootId) && (await this.isThreadChat(chatId)),
      cid: o.cid || requestCid(),
    };
  }

  /** Delay between send retries (ms); the nth retry waits n times this. */
  sendRetryDelayMs = 1000;

  /**
   * Send a message and confirm delivery, returning the server-assigned message id; throws on failure instead of returning null:
   * on network errors, 5xx, or a missing message id it retries o.retries times with the same cid (server dedupes, so no duplicates); if still failing it throws NetworkError / HttpError,
   * or SendUnconfirmed (server accepted it but returned no message id, so it may have been sent; carries the cid for a later resend).
   * Content is a MessageContent: plain text (with links, `[text](url)` renders as a hyperlink with text), structured rich text (text is a plain-text summary), HTML rich text, image, file;
   * images and files are uploaded first, and upload failures likewise throw NetworkError / HttpError.
   */
  async sendMessage(chatId: string, content: MessageContent, o: SendOptions = {}): Promise<string> {
    const { pkt, cid } = await this.messagePacket(chatId, content, o);
    // The server dedupes on the message cid, so retrying the same packet won't send duplicates
    const retries = o.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.postMessage(pkt, cid);
      } catch (err) {
        const retryable =
          err instanceof NetworkError ||
          err instanceof SendUnconfirmed ||
          (err instanceof HttpError && err.status >= 500);
        if (!retryable || attempt >= retries) throw err;
        logger.warning(
          `send failed, retrying (${attempt + 1}/${retries}): ${(err as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, this.sendRetryDelayMs * (attempt + 1)));
      }
    }
  }

  /** Build the send packet (PutMessageRequest, cmd 5) and message cid; images and files are uploaded here first. */
  private async messagePacket(
    chatId: string,
    content: MessageContent,
    o: SendOptions,
  ): Promise<{ pkt: Packet; cid: string }> {
    const target = await this.threadTarget(chatId, o);
    const requestId = longRequestId();
    let pkt: Packet;
    if ('image' in content)
      pkt = buildImageMessagePacket(
        await uploadImage(this.auth, content.image, content.name),
        target,
        requestId,
      );
    else if ('file' in content)
      pkt = buildFileMessagePacket(
        await uploadFile(this.auth, chatId, content.file, content.name),
        target,
        requestId,
      );
    else if ('markdown' in content)
      pkt = buildMarkdownMessagePacket(content.markdown, target, requestId, content.title ?? '');
    else if ('blocks' in content)
      pkt = buildRichMessagePacket(content.blocks, content.text, target, requestId);
    else if ('html' in content)
      pkt = buildPostMessagePacket(content.html, target, requestId, content.title ?? '');
    else pkt = buildSendMessagePacket(content.text, target, requestId, content.links ?? false);
    return { pkt, cid: target.cid };
  }

  /**
   * Scheduled send: the server sends it at `at` (ms); returns the scheduled message id (which becomes the message's id once sent). Content and reply options as in sendMessage.
   * A reply in a thread (o.rootId) is attached to that thread.
   */
  async scheduleMessage(
    chatId: string,
    content: MessageContent,
    at: number,
    o: SendOptions = {},
  ): Promise<string> {
    const { pkt } = await this.messagePacket(chatId, content, o);
    const put = fromBinary(
      larkType('messages.PutMessageRequest'),
      (pkt as unknown as { payload: Uint8Array }).payload,
    );
    const resp = await this.call('messages.PutScheduleMessageRequest', {
      putRequest: put,
      scheduleTime: BigInt(Math.floor(at / 1000)),
      chatId,
      entityId: o.rootId || chatId,
    });
    const id = (resp.message as Dict | undefined)?.messageId;
    if (!id) throw new Error('scheduled send failed: no message id in response');
    return String(id);
  }

  /** Scheduled messages in a chat not yet sent (pending or paused), ascending by send time. */
  async scheduledMessages(chatId: string): Promise<ScheduledMessage[]> {
    const resp = await this.api('messages.PullChatScheduleMessagesRequest', {
      chatId,
      entityType: SCHEDULE_CHAT_ONLY,
      entityId: chatId,
      status: [SCHEDULE_PENDING, SCHEDULE_SUSPEND],
    });
    return ((resp.messages ?? []) as Dict[])
      .map((m) => ({
        messageId: String(m.messageId),
        at: int(m.scheduleTime, 0) * 1000,
        status:
          int(m.status, 0) === SCHEDULE_SUSPEND ? ('suspended' as const) : ('pending' as const),
        message: m.scheduleMessage
          ? toLarkMessage(m.scheduleMessage as Dict, { fallbackChatId: chatId })
          : null,
      }))
      .sort((a, b) => a.at - b.at);
  }

  /** Change a scheduled message's send time (ms). */
  async rescheduleMessage(chatId: string, messageId: string, at: number): Promise<void> {
    await this.api('messages.PatchScheduleMessageRequest', {
      patchType: SCHEDULE_PATCH_UPDATE,
      messageId,
      chatId,
      scheduleTime: String(Math.floor(at / 1000)),
    });
  }

  /** Cancel a scheduled message (it will not be sent). */
  async cancelScheduledMessage(chatId: string, messageId: string): Promise<void> {
    await this.api('messages.PatchScheduleMessageRequest', {
      patchType: SCHEDULE_PATCH_DELETE,
      messageId,
      chatId,
    });
  }

  private async postMessage(pkt: Packet, cid: string): Promise<string> {
    const resp = await this.gatewayPost(pkt);
    let msgId: string;
    try {
      msgId = decodePutMessageResponse(resp);
    } catch (err) {
      throw new SendUnconfirmed(
        `server accepted the send request but the response could not be parsed; delivery unconfirmed: ${(err as Error).message}`,
        cid,
      );
    }
    if (!msgId)
      throw new SendUnconfirmed(
        'server accepted the send request but returned no message id; delivery unconfirmed',
        cid,
      );
    return msgId;
  }

  /** Send a text message, returning the message id; if sending can't be confirmed, logs an error and returns null. richLinks is the same as sendMessage's links. */
  async sendMsg(
    text: string,
    chatId: string,
    o: SendOptions = {},
    richLinks = false,
  ): Promise<string | null> {
    try {
      return await this.sendMessage(chatId, { text, links: richLinks }, o);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(err instanceof SendUnconfirmed ? msg : `send message failed: ${msg}`);
      return null;
    }
  }

  /** Structured rich text (POST) message; innerText is the plain-text summary. Returns the message id, or null on failure. */
  async sendRich(
    blocks: RichBlock[],
    innerText: string,
    chatId: string,
    o: SendOptions = {},
  ): Promise<string | null> {
    try {
      return await this.sendMessage(chatId, { blocks, text: innerText }, o);
    } catch (err) {
      logger.error(`send rich text failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Rich text (POST) message from an HTML fragment. Returns the message id, or null on failure. */
  async sendPost(
    html: string,
    chatId: string,
    title = '',
    o: SendOptions = {},
  ): Promise<string | null> {
    try {
      return await this.sendMessage(chatId, { html, title }, o);
    } catch (err) {
      logger.error(`send rich text failed: ${(err as Error).message}`);
      return null;
    }
  }

  async search(query: string): Promise<SearchHit[]> {
    const pkt = buildSearchPacket(query, longRequestId(), this.auth.region.locale);
    return decodeSearchResponse(await this.gatewayPost(pkt));
  }

  /**
   * Search messages across chats (same as the "Messages" tab of the client's search box), ranked by server relevance; filterable by chat, sender, and time.
   * Server search has indexing lag; a just-sent message may take a while to become searchable.
   */
  async searchMessages(query: string, o: MessageSearchOptions = {}): Promise<MessageHit[]> {
    const limit = o.limit ?? 20;
    const filter: Dict = {};
    if (o.chatIds?.length) filter.chatIds = o.chatIds;
    if (o.fromIds?.length) filter.creatorIds = o.fromIds;
    if (o.since !== undefined || o.until !== undefined)
      filter.timeRange = {
        ...(o.since !== undefined ? { startTime: String(Math.floor(o.since / 1000)) } : {}),
        ...(o.until !== undefined ? { endTime: String(Math.floor(o.until / 1000)) } : {}),
      };
    const session = requestCid();
    const out: MessageHit[] = [];
    let token = '';
    for (let seq = 1; out.length < limit; seq++) {
      const resp = await this.api('usearch.UniversalSearchRequest', {
        header: {
          searchSession: session,
          sessionSeqId: seq,
          query,
          ...(token ? { paginationToken: token } : {}),
          searchContext: {
            tagName: 'MESSAGE',
            entityItems: [{ type: SEARCH_ENTITY_MESSAGE, filter: { messageFilter: filter } }],
            commonFilter: { includeOuterTenant: true },
            sourceKey: 'messenger',
          },
          locale: this.auth.region.locale,
          pageSize: Math.min(limit - out.length, 50),
          extraParam: {},
        },
      });
      for (const r of (resp.results ?? []) as Dict[]) {
        const m = ((r.resultMeta as Dict | undefined)?.messageMeta ?? {}) as Dict;
        if (r.type !== SEARCH_ENTITY_MESSAGE || !m.id) continue;
        out.push({
          msgId: String(m.id),
          chatId: String(m.chatId ?? ''),
          chatTitle: unhighlight(r.titleHighlighted),
          fromId: String(m.fromId ?? ''),
          createTime: Number(m.createTime ?? 0),
          position: m.position === undefined ? null : Number(m.position),
          msgType: enumToInt(m.type ?? 0),
          p2p: m.isP2pChat === true,
          summary: unhighlight(r.summaryHighlighted),
        });
      }
      const header = (resp.header ?? {}) as Dict;
      token = String(header.paginationToken ?? '');
      if (!header.hasMore || !token || !(resp.results as unknown[] | undefined)?.length) break;
    }
    return out.slice(0, limit);
  }

  async createChat(userId: string): Promise<string | null> {
    return decodePutChatResponse(
      await this.gatewayPost(buildCreateChatPacket(userId, longRequestId())),
    );
  }

  /**
   * Official "message link" (the same applink as the client's "Copy message link"): a single message opens and jumps to that message;
   * multiple messages produce one combined link, which the client previews as a multi-message card "from group chat". Messages in threads also use the chat as their source.
   */
  async messageLink(chatId: string, messageIds: string[]): Promise<string | null> {
    const resp = await this.api('messages.PutMessageLinkRequest', {
      fromId: chatId,
      from: 1,
      copiedId: messageIds,
    });
    return (resp.tokenUrl as string | undefined) || null;
  }

  /** The current account's chat with itself (Lark allows messaging yourself); the server creates it if it doesn't exist. */
  selfChat(): Promise<string | null> {
    return this.createChat(this.auth.userId);
  }

  async getUserName(userId: string, chatId: string): Promise<string | null> {
    try {
      const content = await this.gatewayPost(buildUserInfoPacket(userId, chatId, longRequestId()));
      return decodeUserInfoResponse(content, this.auth.region.locale);
    } catch {
      return null;
    }
  }

  async getGroupName(chatId: string): Promise<string | null> {
    try {
      return decodeGroupInfoResponse(
        await this.gatewayPost(buildGroupInfoPacket(chatId, longRequestId())),
      );
    } catch {
      return null;
    }
  }

  /**
   * Batch-look up display names of users (or bots), returning id -> name; ids not found are omitted. Results are cached in-process, so each id is looked up only once.
   */
  async userNames(ids: string[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter(Boolean))];
    const missing = want.filter((id) => !this.chatterNames.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      const resp = await this.api('chatters.PullChattersByIdsRequest', {
        chatterIds: missing.slice(i, i + 100),
      });
      for (const [id, v] of Object.entries((resp.chatters ?? {}) as Record<string, Dict>))
        this.chatterNames.set(id, chatterName(v, this.auth.region.locale));
    }
    const out = new Map<string, string>();
    for (const id of want) {
      const name = this.chatterNames.get(id);
      if (name !== undefined) out.set(id, name);
    }
    return out;
  }

  /** Chat members (including bots), up to max; paging params (cursor / offset / orderCursor) are passed back verbatim until the server stops returning them. */
  async chatMembers(chatId: string, max = 5000): Promise<ChatMember[]> {
    const members = new Map<string, ChatMember>();
    let page: Dict = {};
    for (;;) {
      const resp = await this.api('chats.PullChatChattersRequest', { chatId, limit: 100, ...page });
      const before = members.size;
      for (const field of ['chatters', 'updateChatters'])
        for (const [id, v] of Object.entries((resp[field] ?? {}) as Record<string, Dict>)) {
          const m = toMember(id, v, this.auth.region.locale);
          members.set(id, m);
          this.chatterNames.set(id, m.name);
        }
      const next: Dict = {};
      if (resp.nextCursor) next.cursor = resp.nextCursor;
      if (resp.nextOffset) next.offset = resp.nextOffset;
      if (resp.nextOrderCursor) next.orderCursor = resp.nextOrderCursor;
      if (!Object.keys(next).length || members.size === before || members.size >= max) break;
      page = next;
    }
    return [...members.values()].slice(0, max);
  }

  /**
   * Create a group and add members (memberIds may be empty, i.e. just yourself), returning the new group's chat_id. topic = true creates a thread group.
   * The group is visible to members and notifies those added; resending with the same cid won't create two groups.
   */
  async createGroup(
    name: string,
    memberIds: string[] = [],
    o: { description?: string; topic?: boolean; cid?: string } = {},
  ): Promise<string> {
    const resp = await this.api('chats.PutChatRequest', {
      type: 2,
      groupName: name,
      ...(o.description ? { groupDesc: o.description } : {}),
      chatterIds: memberIds,
      ...(o.topic ? { chatMode: CHAT_MODE_THREAD_V2 } : {}),
      cid: o.cid || requestCid(),
    });
    const id = String((resp.chat as Dict | undefined)?.id ?? '');
    if (!id) throw new Error('create group failed: no chat id in response');
    return id;
  }

  /** Add users to a group (requires permission to add members). */
  async addMembers(chatId: string, userIds: string[]): Promise<void> {
    await this.api('chats.PutChatChatterRequest', { chatId, chatterIds: userIds });
  }

  /** Remove users from a group (requires being the owner or an admin). */
  async removeMembers(chatId: string, userIds: string[]): Promise<void> {
    await this.api('chats.DeleteChatChatterRequest', { chatId, chatterIds: userIds });
  }

  /** Change the group name / description (whichever is given). */
  async updateGroup(chatId: string, o: { name?: string; description?: string }): Promise<void> {
    const fields: number[] = [];
    if (o.name !== undefined) fields.push(GROUP_FIELD_NAME);
    if (o.description !== undefined) fields.push(GROUP_FIELD_DESCRIPTION);
    if (!fields.length) return;
    await this.api('chats.PatchGroupChatRequest', {
      chatId,
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.description !== undefined ? { description: o.description } : {}),
      updateFields: fields,
    });
  }

  /** Pin a message to the chat (visible to all chat members); returns the pin id. */
  async pinMessage(chatId: string, messageId: string): Promise<string> {
    const resp = await this.api('pin.PutPinRequest', { chatId, messageId });
    const id = (resp.pin as Dict | undefined)?.id;
    if (id === undefined) throw new Error('pin failed: no pin id in response');
    return String(id);
  }

  /** Unpin; returns false if the message wasn't pinned. */
  async unpinMessage(chatId: string, messageId: string): Promise<boolean> {
    const resp = await this.api('pin.PullPinsByMessageIDsRequest', { messageIds: [messageId] });
    const pin = Object.values((resp.pins ?? {}) as Record<string, Dict>).find(
      (p) => String(p.messageId) === messageId && !int(p.deletedTime, 0),
    );
    if (!pin) return false;
    await this.api('pin.DeletePinRequest', { id: String(pin.id), chatId });
    return true;
  }

  /** Pinned messages in a chat (up to max), including the messages themselves, newest pin first. */
  async chatPins(chatId: string, max = 100): Promise<PinnedMessage[]> {
    const out: PinnedMessage[] = [];
    let cursor: bigint | undefined;
    while (out.length < max) {
      const resp = await this.api('pin.PullChatPinsRequest', {
        chatId,
        count: Math.min(50, max - out.length),
        withMessages: true,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const msgs = (resp.pinedMessages ?? {}) as Record<string, Dict>;
      for (const p of (resp.pins ?? []) as Dict[]) {
        const v = msgs[String(p.messageId)];
        out.push({
          pinId: String(p.id),
          messageId: String(p.messageId),
          pinnedBy: String(p.chatterId ?? ''),
          pinnedAt: int(p.createTime, 0),
          message: v
            ? toLarkMessage(v, { selfId: this.auth.userId, fallbackChatId: chatId })
            : null,
        });
      }
      const next = resp.nextCursor as bigint | undefined;
      if (!resp.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return out.sort((a, b) => b.pinnedAt - a.pinnedAt).slice(0, max);
  }

  /** My chat labels (groups), sorted by label position. */
  async feedGroups(): Promise<FeedGroup[]> {
    const groups: Dict[] = [];
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const resp = await this.api('feed.PullFeedGroupsRequest', {
        count: String(FEED_GROUP_PAGE),
        ...(cursor ? { cursor } : {}),
      });
      groups.push(...((resp.feedGroups ?? []) as Dict[]));
      const next = String(resp.nextCursor ?? '');
      if (!resp.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return groups
      .sort((a, b) => int(a.pos, 0) - int(b.pos, 0))
      .map((g) => ({
        id: String(g.id),
        name: String(g.name ?? ''),
        type: ({ 1: 'normal', 2: 'keyword' } as const)[int(g.type, 0) as 1 | 2] ?? 'unknown',
      }));
  }

  /** Chats (chat_id) in a given label. */
  async feedGroupChats(groupId: string): Promise<string[]> {
    const out = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 100; page++) {
      const resp = await this.api('feed.PullFeedGroupItemsRequest', {
        args: { [groupId]: { count: String(FEED_GROUP_PAGE), ...(cursor ? { cursor } : {}) } },
      });
      const data = ((resp.data ?? {}) as Record<string, Dict>)[groupId] ?? {};
      for (const it of (data.feedGroupItems ?? []) as Dict[])
        if (int(it.feedCardType, 0) === CARD_CHAT && !it.exclude) out.add(String(it.feedCardId));
      const next = String(data.nextCursor ?? '');
      if (!data.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return [...out];
  }

  /** Pinned chats (chat_id) in the chat list, in pin order. */
  async shortcuts(): Promise<string[]> {
    const resp = await this.api('feed.PullShortcutsRequest', { position: 0, count: 200 });
    return ((resp.shortcuts ?? []) as Dict[])
      .filter((x) => int(x.type, 0) === SHORTCUT_CHAT)
      .sort((a, b) => int(a.position, 0) - int(b.position, 0))
      .map((x) => String(x.id));
  }

  /** Pin these chats in the chat list (after those already pinned). Affects only your own chat list. */
  async addShortcuts(chatIds: string[]): Promise<void> {
    await this.api('feed.PutShortcutsRequest', {
      shortcuts: chatIds.map((id, i) => ({ id, type: SHORTCUT_CHAT, position: i })),
    });
  }

  /** Unpin. */
  async removeShortcuts(chatIds: string[]): Promise<void> {
    await this.api('feed.DeleteShortcutsRequest', {
      shortcuts: chatIds.map((id) => ({ id, type: SHORTCUT_CHAT })),
    });
  }

  /** Flag / unflag messages (same as the client's "Flag", a reminder for yourself; only you can see it). */
  async flagMessages(messageIds: string[], remove = false): Promise<void> {
    const items = messageIds.map((id) => ({ itemId: id, flagType: FLAG_MESSAGE }));
    await this.api('feed.UpdateFlagsRequest', remove ? { deletedItems: items } : { items });
  }

  /** Flag / unflag chats. */
  async flagChats(chatIds: string[], remove = false): Promise<void> {
    const items = chatIds.map((id) => ({ itemId: id, itemType: CARD_CHAT, flagType: FLAG_FEED }));
    await this.api('feed.UpdateFlagsRequest', remove ? { deletedItems: items } : { items });
  }

  /** My flagged list (up to max), newest flag first. */
  async flags(max = 200): Promise<FlagItem[]> {
    const out: FlagItem[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const resp = await this.api('feed.PullFlagsRequest', {
        count: String(Math.min(50, max - out.length)),
        ...(cursor ? { cursor } : {}),
      });
      const msgs = (resp.messages ?? {}) as Record<string, Dict>;
      for (const f of (resp.items ?? []) as Dict[]) {
        const id = String(f.itemId);
        const isMsg = int(f.flagType, 0) === FLAG_MESSAGE;
        const v = isMsg ? msgs[id] : undefined;
        out.push({
          type: isMsg ? 'message' : 'chat',
          id,
          createTime: int(f.createTime, 0),
          message: v ? toLarkMessage(v, { selfId: this.auth.userId }) : null,
        });
      }
      const next = String(resp.nextCursor ?? '');
      if (!resp.hasMore || !next || next === cursor) break;
      cursor = next;
    }
    return out.sort((a, b) => b.createTime - a.createTime).slice(0, max);
  }

  /**
   * Forward a message to these chats (forwarded as-is; recipients see "Forwarded from"), returning chat id -> new message id; chats where forwarding failed are omitted.
   * Each target gets its own message cid, which the server dedupes on, so retries within one call won't send duplicates.
   */
  async forwardMessage(messageId: string, chatIds: string[]): Promise<Map<string, string>> {
    const resp = await this.api('messages.PutTransmitMessageRequest', {
      chatIds,
      messageId,
      cids: Object.fromEntries(chatIds.map((id) => [id, requestCid()])),
    });
    const out = new Map<string, string>();
    for (const [chatId, m] of Object.entries((resp.messages ?? {}) as Record<string, Dict>))
      if (m.id) out.set(chatId, String(m.id));
    return out;
  }

  /**
   * Translate text (same as the client's "Translate"), returning translations in order. targetLanguage e.g. zh, en, ja; leave sourceLanguage empty to auto-detect.
   * Doesn't change how any message is displayed.
   */
  async translateText(
    texts: string[],
    targetLanguage: string,
    sourceLanguage = '',
  ): Promise<string[]> {
    if (!texts.length) return [];
    const resp = await this.api('translate.TranslateWebXMLRequest', {
      srcContents: texts,
      srcLanguage: sourceLanguage,
      trgLanguage: targetLanguage,
      contentType: TRANSLATE_TEXT,
    });
    const out = ((resp.trgContents ?? []) as string[]).map(String);
    if (out.length !== texts.length)
      throw new Error(`translation count mismatch: ${out.length}/${texts.length}`);
    return out;
  }

  /** Translate messages (using the plain-text summary of their content), returning original and translated text; messages that don't exist or have no text are skipped. */
  async translateMessages(
    messageIds: string[],
    targetLanguage: string,
  ): Promise<{ msgId: string; original: string; translated: string }[]> {
    const msgs = (await this.getMessages(messageIds)).filter((m) => m.content.trim());
    const translated = await this.translateText(
      msgs.map((m) => m.content),
      targetLanguage,
    );
    return msgs.map((m, i) => ({
      msgId: m.msg_id,
      original: m.content,
      translated: translated[i] ?? '',
    }));
  }

  /** Recall a message (your own; group admins can also recall others' messages in the group). Throws if the server doesn't confirm. */
  async recallMessage(msgId: string): Promise<void> {
    const resp = await this.api('messages.DeleteMessageRequest', { id: msgId });
    if (resp.message !== 'ok')
      throw new Error(`recall failed: ${String(resp.message ?? 'not confirmed by server')}`);
  }

  /**
   * Edit your own text or rich-text message, replacing the whole content; others see "Edited".
   * Plain-text messages can only be edited to plain text (use text for content); rich-text messages use blocks or markdown. The server rejects edits past the edit window etc. (HttpError.reason explains why).
   */
  async editMessage(msgId: string, content: EditableContent): Promise<void> {
    const { type, richText } = richTextOf(content);
    await this.call('messages.EditMessageRequest', {
      msgId: BigInt(msgId),
      cid: requestCid(),
      type,
      content: { richText },
    });
  }

  /** Add a reaction to a message; reactionType e.g. THUMBSUP, OK, DONE, SMILE (matching the keys of the client's emoji panel). */
  async addReaction(msgId: string, reactionType: string): Promise<void> {
    await this.api('reactions.PutReactionRequest', { messageId: msgId, reactionType });
  }

  /** Remove one of your own reactions. */
  async removeReaction(msgId: string, reactionType: string): Promise<void> {
    await this.api('reactions.DeleteReactionRequest', { messageId: msgId, reactionType });
  }

  /** Reactions on a message: count and reactors for each emoji. */
  async reactions(messageIds: string[]): Promise<MessageReactions[]> {
    const resp = await this.api('reactions.PullReactionsRequest', { messageIds, fetchUsers: true });
    return ((resp.messageReactions ?? []) as Dict[]).map((mr) => ({
      messageId: String(mr.messageId),
      // After a reaction is fully removed the server still returns a count=0 entry; ignore it
      reactions: ((mr.reactions ?? []) as Dict[])
        .filter((r) => Number(r.count ?? 0) > 0)
        .map((r) => ({
          type: String(r.type),
          count: Number(r.count ?? 0),
          userIds: [
            ...new Set([
              ...((r.userIds as string[] | undefined) ?? []),
              ...Object.keys((r.nanoUpdateTimes ?? r.udpateTimes ?? {}) as Dict),
            ]),
          ],
        })),
    }));
  }

  /** Read status of messages (who has / hasn't read them); messages must be in chat chatId; messages not found are omitted. */
  async readStates(chatId: string, messageIds: string[]): Promise<ReadState[]> {
    const resp = await this.api('messages.PullMessageReadStateRequest', {
      pairs: messageIds.map((messageId) => ({ chatId, messageId })),
    });
    const states = (resp.readStates ?? {}) as Record<string, Dict>;
    return messageIds
      .filter((id) => states[id])
      .map((id) => {
        const r = states[id] as Dict;
        const last = r.lastUserReadInfo as Dict | undefined;
        return {
          messageId: id,
          readCount: Number(r.readCount ?? 0),
          unreadCount: Number(r.unreadCount ?? 0),
          readUserIds: ((r.readUserIds as string[] | undefined) ?? []).map(String),
          unreadUserIds: ((r.unreadUserIds as string[] | undefined) ?? []).map(String),
          lastRead: last?.userId
            ? { userId: String(last.userId), time: Number(last.readTime ?? 0) }
            : null,
        };
      });
  }

  /** Whether I've read these messages myself: id -> time read (seconds), or null if unread. */
  async myReadStates(messageIds: string[]): Promise<Map<string, number | null>> {
    const resp = await this.api('messages.PullMessageMeReadStateRequest', {
      messageIds,
      needReadTime: true,
    });
    const status = (resp.readStatus ?? {}) as Record<string, boolean>;
    const times = (resp.readTimes ?? {}) as Record<string, bigint | number>;
    const out = new Map<string, number | null>();
    for (const id of messageIds)
      if (id in status) out.set(id, status[id] ? Number(times[id] ?? 0) : null);
    return out;
  }

  /** Mark messages read as soon as they arrive (listen's LARKX_MARK_READ); failures are only logged at debug. */
  async markRead(chatId: string, maxPosition: number, messageIds?: string[]): Promise<boolean> {
    try {
      await this.api('messages.PutReadMessagesRequest', {
        chatId,
        maxPosition,
        ...(messageIds?.length ? { messageIds } : {}),
      });
      return true;
    } catch (err) {
      logger.debug(`mark read failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Mark these messages as read, same as viewing them in the client: the chat/thread unread pointer advances to the newest of them, and senders see "Read".
   * Main-chat messages advance the chat's read position by position; thread replies advance that thread by threadPosition,
   * and the request's maxPosition uses the thread root message's position (required by the server, and it only moves forward, never back).
   * Throws if a message doesn't exist, isn't in the chat, or the request fails. Returns the number of messages marked.
   */
  async readMessages(chatId: string, messageIds: string[]): Promise<number> {
    const found = ((await this.api('messages.PullMessagesByIdsRequest', { messageIds })).messages ??
      {}) as Record<string, Dict>;
    const missing = messageIds.filter((m) => !(m in found));
    if (missing.length) throw new Error(`message not found: ${missing.join(', ')}`);
    const chatIds: string[] = [];
    let chatMax = -1;
    const threads = new Map<string, { ids: string[]; max: number }>();
    for (const mid of messageIds) {
      const v = found[mid] as Dict;
      if (String(v.chatId) !== chatId) throw new Error(`message ${mid} is not in chat ${chatId}`);
      const position = v.position as number | undefined;
      if (position !== undefined && position >= 0) {
        chatIds.push(mid);
        chatMax = Math.max(chatMax, position);
      }
      // Only real thread replies carry threadPosition (>=0; -1 for the root); quote replies in regular groups only have position and live in the main chat
      const threadId = v.threadId as string | undefined;
      const threadPosition = v.threadPosition as number | undefined;
      if (threadId && threadPosition !== undefined && threadPosition >= 0) {
        const t = threads.get(threadId) ?? { ids: [], max: -1 };
        t.ids.push(mid);
        t.max = Math.max(t.max, threadPosition);
        threads.set(threadId, t);
      }
    }
    if (chatIds.length)
      await this.api('messages.PutReadMessagesRequest', {
        chatId,
        maxPosition: chatMax,
        messageIds: chatIds,
      });
    if (threads.size) {
      const roots = ((
        await this.api('messages.PullMessagesByIdsRequest', { messageIds: [...threads.keys()] })
      ).messages ?? {}) as Record<string, Dict>;
      for (const [threadId, t] of threads) {
        const rootPosition = roots[threadId]?.position;
        if (rootPosition === undefined)
          throw new Error(`thread root message not found: ${threadId}`);
        await this.api('messages.PutReadMessagesRequest', {
          chatId,
          maxPosition: rootPosition,
          threadId,
          threadMaxPosition: t.max,
          messageIds: t.ids,
        });
      }
    }
    return messageIds.length;
  }

  /** Call any gateway endpoint: request type name (e.g. chats.PullChatsByIdsRequest) or cmd number; returns the response dict (a Packet dict when there's no response type). */
  async api(typeOrCmd: string | number, data?: Dict | null): Promise<Dict> {
    const { cmd, req, resp } = resolveCmd(typeOrCmd);
    return this.post(cmd, req ? toBinary(req, fromDict(req, data)) : undefined, resp);
  }

  /** Same as api, but the request is built as a protobuf object: byte fields take Uint8Array, int64 takes bigint (rich-text element properties are bytes). */
  private async call(typeName: string, init: Record<string, unknown>): Promise<Dict> {
    const { cmd, req, resp } = resolveCmd(typeName);
    if (!req) throw new Error(`${typeName} is not a request type`);
    return this.post(cmd, toBinary(req, create(req, init)), resp);
  }

  private async post(
    cmd: number,
    payload: Uint8Array | undefined,
    resp: ReturnType<typeof resolveCmd>['resp'],
  ): Promise<Dict> {
    const pkt = LarkClient.packet({ cmd, cid: longRequestId(), ...(payload ? { payload } : {}) });
    const content = await this.gatewayPost(pkt);
    const respPkt = fromBinary(protoType('Packet'), content);
    const body = (respPkt as unknown as { payload?: Uint8Array }).payload;
    if (resp && body?.length) return toDict(resp, fromBinary(resp, body));
    return toDict(protoType('Packet'), respPkt);
  }

  async getChatInfo(chatId: string): Promise<Dict | null> {
    const resp = await this.api('chats.PullChatsByIdsRequest', { chatIds: [chatId] });
    const chats = (resp.chats ?? {}) as Record<string, Dict>;
    return Object.values(chats)[0] ?? null;
  }

  async isThreadChat(chatId: string): Promise<boolean> {
    const cached = this.threadChats.get(chatId);
    if (cached !== undefined) return cached;
    let info: Dict | null;
    try {
      info = await this.getChatInfo(chatId);
    } catch (err) {
      logger.debug(
        `chat mode lookup failed, treating as a regular chat: ${(err as Error).message}`,
      );
      return false;
    }
    if (!info) return false;
    const thread = isThreadChat(info);
    this.threadChats.set(chatId, thread);
    return thread;
  }

  /**
   * Chats in the inbox that changed after since (ms), newest change first.
   * Only chat cards (direct and group chats); threads, docs, mail and other cards are skipped.
   */
  async recentChats(since: number, maxPages = 20): Promise<RecentChat[]> {
    const out: RecentChat[] = [];
    let cursor: bigint | undefined;
    for (let page = 0; page < maxPages; page++) {
      const resp = await this.pullInboxPage(cursor);
      const cards = (resp.cards ?? []) as Dict[];
      const chats = (resp.chats ?? {}) as Record<string, Dict>;
      for (const card of cards) {
        const updatedAt = Number(card.updateTimeMs ?? 0) || Number(card.updateTime ?? 0) * 1000;
        if (card.type !== CARD_CHAT || updatedAt < since) continue;
        const chatId = String(card.id);
        out.push({ chatId, updatedAt, chat: chats[chatId] ?? null });
      }
      // Cards are ordered by rankTime (seconds) newest first; once a card is older than since, stop paging
      const oldest = Number(cards.at(-1)?.rankTime ?? 0) * 1000;
      const next = resp.nextCursor as bigint | undefined;
      if (!cards.length || !next || oldest < since) break;
      cursor = next;
    }
    return out;
  }

  /** One page (50 cards) of the inbox feed, newest first; cursor is the previous page's nextCursor. */
  private pullInboxPage(cursor?: bigint): Promise<Dict> {
    return this.api('feed.PullFeedCardsRequest', {
      type: FEED_INBOX,
      pullFeedType: PULL_FEED_INBOX,
      businessType: BUSINESS_LARK,
      pullType: cursor === undefined ? PULL_REFRESH : PULL_LOAD_MORE,
      count: 50,
      ...(cursor === undefined ? {} : { cursor }),
    });
  }

  /**
   * The server-side chat list: direct and group chats in the inbox, most recent change first, up to limit.
   * Threads, docs, mail and other feed cards are skipped, as are chats marked Done (they leave the inbox).
   * Direct chats have no name on the server, so peerNames (default on) looks up the other member, a few chats at a time.
   */
  async listChats(limit = 100, o: { peerNames?: boolean } = {}): Promise<ListedChat[]> {
    const out: ListedChat[] = [];
    let cursor: bigint | undefined;
    // The page cap only guards against a cursor that never ends; a real inbox ends well before it
    for (let page = 0; page < 200 && out.length < limit; page++) {
      const resp = await this.pullInboxPage(cursor);
      const cards = (resp.cards ?? []) as Dict[];
      const chats = (resp.chats ?? {}) as Record<string, Dict>;
      for (const card of cards) {
        if (card.type !== CARD_CHAT || out.length >= limit) continue;
        const chatId = String(card.id);
        const chat = chats[chatId] ?? (await this.getChatInfo(chatId));
        if (!chat) continue;
        out.push({
          chatId,
          name: String(chat.name ?? ''),
          chatType: enumToInt(chat.type ?? 0),
          threadChat: isThreadChat(chat),
          updatedAt: Number(card.updateTimeMs ?? 0) || Number(card.updateTime ?? 0) * 1000,
          unread: Math.max(0, int(chat.newMessageCount, 0)),
          memberCount: int(chat.memberCount, 0),
        });
      }
      const next = resp.nextCursor as bigint | undefined;
      if (!cards.length || !next) break;
      cursor = next;
    }
    if (o.peerNames ?? true) await this.fillPeerNames(out);
    return out;
  }

  /** Name each unnamed direct chat after its other member; lookups run a few at a time and a failed one leaves the name empty. */
  private async fillPeerNames(chats: ListedChat[]): Promise<void> {
    const todo = chats.filter((c) => c.chatType === CHAT_P2P && !c.name);
    const self = this.auth.userId;
    const worker = async () => {
      for (let c = todo.shift(); c; c = todo.shift()) {
        try {
          const members = await this.chatMembers(c.chatId, 10);
          c.name = (members.find((m) => m.id !== self) ?? members[0])?.name ?? '';
        } catch (err) {
          logger.debug(`P2P partner lookup failed for ${c.chatId}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  /** Fetch messages by id (may span chats), returned in the given order; ids that don't exist or aren't visible are skipped. */
  async getMessages(messageIds: string[]): Promise<LarkMessage[]> {
    if (!messageIds.length) return [];
    const resp = await this.api('messages.PullMessagesByIdsRequest', { messageIds });
    const found = (resp.messages ?? {}) as Record<string, Dict>;
    const out: LarkMessage[] = [];
    for (const id of messageIds) {
      const v = found[id];
      if (v) out.push(await this.fixThreadScope(toLarkMessage(v, { selfId: this.auth.userId })));
    }
    return out;
  }

  /** Full context of a thread: root message first, then the latest limit replies; empty if the root message doesn't exist. */
  async threadMessages(rootId: string, limit = 200): Promise<LarkMessage[]> {
    const [root] = await this.getMessages([rootId]);
    if (!root) return [];
    return [root, ...(await this.threadReplies(rootId, limit))];
  }

  /**
   * Messages in a thread (replies after the root), in thread order; only the latest limit are considered; empty if the thread doesn't exist.
   * Thread positions start at 0 (the first reply); requesting -1 returns the root, but the response files it under 0 because the root's threadPosition is unset, colliding with the first reply, so we don't request it.
   */
  async threadReplies(threadId: string, limit = 200): Promise<LarkMessage[]> {
    const info = await this.api('thread.PullThreadsByIDsRequest', { threadIds: [threadId] });
    const thread = ((info.threads ?? {}) as Record<string, Dict>)[threadId];
    const last = int(thread?.lastMessagePosition);
    if (last < 0) return [];
    const first = Math.max(0, last - limit + 1);
    const positions = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    const resp = await this.api('thread.PullThreadMessagesByPositionsRequest', {
      threadId,
      positions,
    });
    return Object.entries((resp.messages ?? {}) as Record<string, Dict>)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => toLarkMessage(v, { selfId: this.auth.userId }));
  }

  /**
   * Messages that arrived after since (ms) but weren't received over the long connection: used to backfill after a reconnect. Ascending by creation time; may overlap with already-received ones (caller dedupes by msg_id).
   * Only chats in the inbox that changed after since are checked: regular chats pull chat messages after the local position, then query threads seen locally and threads with replies among the new messages;
   * thread groups look at recent threads by thread position and take root messages and replies from threads updated after since.
   */
  async missedMessages(since: number, o: MissedOptions = {}): Promise<LarkMessage[]> {
    const max = o.maxPerChat ?? 200;
    const sinceSec = Math.floor(since / 1000);
    const fresh = (m: LarkMessage) => Boolean(m.from_id) && (m.create_time ?? 0) >= sinceSec;
    const out = new Map<string, LarkMessage>();
    const add = (msgs: LarkMessage[]) => {
      for (const m of msgs) if (fresh(m)) out.set(m.msg_id, m);
    };
    const addThreads = async (ids: Iterable<string>) => {
      const unique = [...new Set(ids)].filter(Boolean);
      if (!unique.length) return;
      const resp = await this.api('thread.PullThreadsByIDsRequest', { threadIds: unique });
      for (const [id, t] of Object.entries((resp.threads ?? {}) as Record<string, Dict>))
        if (int(t.updateTime, 0) >= sinceSec) add(await this.threadReplies(id, max));
    };
    for (const rc of await this.recentChats(since)) {
      const chat = rc.chat ?? (await this.getChatInfo(rc.chatId));
      if (!chat) continue;
      if (isThreadChat(chat)) {
        const lastThread = int(chat.lastThreadPosition);
        if (lastThread < 0) continue;
        const first = Math.max(0, lastThread - RECENT_THREADS + 1);
        const resp = await this.api('thread.PullThreadsByPositionsRequest', {
          channelId: rc.chatId,
          type: CHANNEL_CHAT,
          positions: Array.from({ length: lastThread - first + 1 }, (_, i) => first + i),
        });
        const roots = (resp.rootMessages ?? {}) as Record<string, Dict>;
        add(
          Object.values(roots).map((v) =>
            toLarkMessage(v, {
              threadChat: true,
              fallbackChatId: rc.chatId,
              selfId: this.auth.userId,
            }),
          ),
        );
        const updated = Object.values((resp.threads ?? {}) as Record<string, Dict>)
          .filter((t) => int(t.updateTime, 0) >= sinceSec && int(t.lastMessagePosition) >= 0)
          .map((t) => String(t.id));
        for (const id of updated) add(await this.threadReplies(id, max));
        continue;
      }
      const last = int(chat.lastMessagePosition);
      const local = (await o.localPosition?.(rc.chatId)) ?? -1;
      const first = Math.max(0, local + 1, last - max + 1);
      const threads: string[] = [];
      if (last >= first) {
        const resp = await this.api('messages.PullMessagesByPositionsRequest', {
          chatId: rc.chatId,
          positions: Array.from({ length: last - first + 1 }, (_, i) => first + i),
        });
        for (const [pos, v] of Object.entries((resp.messages ?? {}) as Record<string, Dict>)) {
          if (Number(v.replyCount ?? 0) > 0) threads.push(String(v.id));
          add([
            toLarkMessage(v, {
              fallbackChatId: rc.chatId,
              fallbackPosition: Number(pos),
              selfId: this.auth.userId,
            }),
          ]);
        }
      }
      if (enumToInt(chat.type ?? 0) !== 1)
        await addThreads([...threads, ...((await o.knownThreads?.(rc.chatId)) ?? [])]);
    }
    return [...out.values()].sort(
      (a, b) =>
        (a.create_time ?? 0) - (b.create_time ?? 0) || (a.position ?? 0) - (b.position ?? 0),
    );
  }

  /**
   * Chats in the inbox with unread messages (changed after since ms, default the last 30 days), most recent change first.
   * Unread counts match the client badge: the chat's unread message count, with thread groups counting unread new threads separately.
   */
  async unreadChats(since = Date.now() - 30 * 86_400_000): Promise<UnreadChat[]> {
    const out: UnreadChat[] = [];
    for (const rc of await this.recentChats(since)) {
      const chat = rc.chat ?? (await this.getChatInfo(rc.chatId));
      if (!chat) continue;
      const unread = int(chat.newMessageCount, 0);
      const unreadThreads = int(chat.newThreadCount, 0);
      if (unread <= 0 && unreadThreads <= 0) continue;
      out.push({
        chatId: rc.chatId,
        name: String(chat.name ?? ''),
        chatType: enumToInt(chat.type ?? 0),
        threadChat: isThreadChat(chat),
        unread,
        unreadThreads,
      });
    }
    return out;
  }

  /**
   * Unread messages in a chat (after the read position, up to limit), ascending by time.
   * For thread groups: new threads after the read thread position, plus replies after the read position in recent threads.
   */
  async unreadMessages(chatId: string, limit = 50): Promise<LarkMessage[]> {
    const chat = await this.getChatInfo(chatId);
    if (!chat) return [];
    const selfId = this.auth.userId;
    const out: LarkMessage[] = [];
    if (isThreadChat(chat)) {
      const lastThread = int(chat.lastThreadPosition);
      if (lastThread < 0) return [];
      const first = Math.max(0, lastThread - RECENT_THREADS + 1);
      const resp = await this.api('thread.PullThreadsByPositionsRequest', {
        channelId: chatId,
        type: CHANNEL_CHAT,
        positions: Array.from({ length: lastThread - first + 1 }, (_, i) => first + i),
      });
      const readThread = int(chat.readThreadPosition);
      const roots = (resp.rootMessages ?? {}) as Record<string, Dict>;
      for (const t of Object.values((resp.threads ?? {}) as Record<string, Dict>)) {
        const root = roots[String(t.id)];
        if (root && int(t.position) > readThread)
          out.push(toLarkMessage(root, { threadChat: true, fallbackChatId: chatId, selfId }));
        const read = int(t.readPosition);
        const last = int(t.lastMessagePosition);
        if (last <= read) continue;
        const from = Math.max(read + 1, last - limit + 1, 0);
        const replies = await this.api('thread.PullThreadMessagesByPositionsRequest', {
          threadId: String(t.id),
          positions: Array.from({ length: last - from + 1 }, (_, i) => from + i),
        });
        for (const v of Object.values((replies.messages ?? {}) as Record<string, Dict>))
          out.push(toLarkMessage(v, { selfId }));
      }
    } else {
      const last = int(chat.lastMessagePosition);
      const from = Math.max(int(chat.readPosition) + 1, last - limit + 1, 0);
      if (last >= from) {
        const resp = await this.api('messages.PullMessagesByPositionsRequest', {
          chatId,
          positions: Array.from({ length: last - from + 1 }, (_, i) => from + i),
        });
        for (const [pos, v] of Object.entries((resp.messages ?? {}) as Record<string, Dict>))
          out.push(
            toLarkMessage(v, { fallbackChatId: chatId, fallbackPosition: Number(pos), selfId }),
          );
      }
    }
    return out
      .filter((m) => m.from_id && m.from_id !== selfId && !m.recalled)
      .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0))
      .slice(-limit);
  }

  /** Unread messages across chats that @mention me (or @all), ascending by time. */
  async unreadMentions(since?: number): Promise<LarkMessage[]> {
    const out: LarkMessage[] = [];
    for (const chat of await this.unreadChats(since))
      out.push(...(await this.unreadMessages(chat.chatId)).filter((m) => m.at_me));
    return out.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  }

  /**
   * Find the chat position boundary for a time: messages before it are all earlier than time (ms), messages from it onward are not earlier; if all are earlier, it's the latest position + 1.
   * The boundary may land on a gap (a position with no message); as a pull starting point that doesn't affect the result.
   * Binary search over positions, pulling a small range each step (positions can have gaps: silently recalled or invisible messages), about log2(N) requests.
   */
  async positionAt(chatId: string, time: number, last?: number): Promise<number> {
    const end = last ?? int((await this.getChatInfo(chatId))?.lastMessagePosition);
    const target = Math.floor(time / 1000);
    /** [position, creation time] of the first existing message from pos onward; null if none up to end. */
    const probe = async (pos: number): Promise<[number, number] | null> => {
      for (let width = 8; pos <= end; pos += width, width *= 2) {
        const upto = Math.min(end, pos + width - 1);
        const resp = await this.api('messages.PullMessagesByPositionsRequest', {
          chatId,
          positions: Array.from({ length: upto - pos + 1 }, (_, i) => pos + i),
        });
        const found = Object.entries((resp.messages ?? {}) as Record<string, Dict>)
          .map(([k, v]) => [Number(k), int(v.createTime, 0)] as [number, number])
          .sort((a, b) => a[0] - b[0])[0];
        if (found) return found;
      }
      return null;
    };
    let lo = 0;
    let hi = end + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const p = await probe(mid);
      if (!p || p[1] >= target) hi = mid;
      else lo = p[0] + 1;
    }
    return lo;
  }

  /**
   * Chat messages within a time range (ms, inclusive) on the main chat stream (same as pullHistory), at most the latest limit, ascending by position.
   * First binary-searches the positions for the range, then pulls by position.
   */
  async historyRange(
    chatId: string,
    o: { since?: number | undefined; until?: number | undefined; limit?: number },
    save?: (msg: LarkMessage) => Promise<unknown>,
  ): Promise<LarkMessage[]> {
    const last = int((await this.getChatInfo(chatId))?.lastMessagePosition);
    if (last < 0) return [];
    const start = o.since === undefined ? 0 : await this.positionAt(chatId, o.since, last);
    const end =
      o.until === undefined ? last : (await this.positionAt(chatId, o.until + 1000, last)) - 1;
    const first = Math.max(start, end - (o.limit ?? 50) + 1);
    if (end < first) return [];
    const msgs = await this.pullHistory(
      chatId,
      Array.from({ length: end - first + 1 }, (_, i) => first + i),
    );
    const lo = o.since === undefined ? -Infinity : Math.floor(o.since / 1000);
    const hi = o.until === undefined ? Infinity : Math.floor(o.until / 1000);
    const inRange = msgs.filter((m) => (m.create_time ?? 0) >= lo && (m.create_time ?? 0) <= hi);
    if (save) for (const m of inRange) await save(m).catch(() => {});
    return inRange;
  }

  /** Pull history messages by position and decode them; with save, each is stored as it goes (individual failures ignored). */
  async pullHistory(
    chatId: string,
    positions: number[],
    save?: (msg: LarkMessage) => Promise<unknown>,
  ): Promise<LarkMessage[]> {
    const resp = await this.api('messages.PullMessagesByPositionsRequest', { chatId, positions });
    const messages = (resp.messages ?? {}) as Record<string, Dict>;
    const threadChat = await this.isThreadChat(chatId);
    const out: LarkMessage[] = [];
    for (const [posKey, v] of Object.entries(messages).sort(([a], [b]) => Number(a) - Number(b))) {
      const msg = toLarkMessage(v, {
        threadChat,
        fallbackChatId: chatId,
        fallbackPosition: Number(posKey),
      });
      out.push(msg);
      if (save) await save(msg).catch(() => {});
    }
    return out;
  }
}

/** Library method -> permission key (named like the CLI commands, grouped under the closest command); the type requires every public method be covered, so new methods must be assigned. */
type Methods<T> = {
  [K in keyof T]: T[K] extends (...args: never) => unknown ? K : never;
}[keyof T];

const METHOD_PERMISSIONS: {
  [K in Methods<LarkClient>]: Permission | ((...args: Parameters<LarkClient[K]>) => Permission);
} = {
  buildWsUrl: 'listen',
  connectWebsocket: 'listen',
  gatewayPost: 'api',
  api: 'api',
  sendMessage: (_chatId, content) =>
    'image' in content ? 'send-image' : 'file' in content ? 'send-file' : 'send',
  sendMsg: 'send',
  sendRich: 'send',
  sendPost: 'send',
  scheduleMessage: 'schedule',
  scheduledMessages: 'scheduled.list',
  rescheduleMessage: 'scheduled.reschedule',
  cancelScheduledMessage: 'scheduled.cancel',
  forwardMessage: 'forward',
  search: 'search',
  createChat: 'search',
  getGroupName: 'search',
  getChatInfo: 'search',
  isThreadChat: 'search',
  searchMessages: 'search-messages',
  messageLink: 'message-link',
  selfChat: 'self-chat',
  getUserName: 'users',
  userNames: 'users',
  chatMembers: 'members',
  createGroup: 'group.create',
  addMembers: 'group.add',
  removeMembers: 'group.remove',
  updateGroup: 'group.rename',
  pinMessage: 'pin',
  unpinMessage: 'pin',
  chatPins: 'pins',
  feedGroups: 'tags',
  feedGroupChats: 'tags',
  shortcuts: 'shortcut.list',
  addShortcuts: 'shortcut.add',
  removeShortcuts: 'shortcut.remove',
  flagMessages: 'flag',
  flagChats: 'flag',
  flags: 'flags',
  translateText: 'translate',
  translateMessages: 'translate',
  recallMessage: 'recall',
  editMessage: 'edit',
  addReaction: 'react',
  removeReaction: 'react',
  reactions: 'reactions',
  readStates: 'read-status',
  myReadStates: 'read-status',
  markRead: 'read',
  readMessages: 'read',
  listChats: 'chats.remote',
  recentChats: 'unread',
  unreadChats: 'unread',
  unreadMessages: 'unread',
  unreadMentions: 'unread',
  getMessages: 'get',
  threadMessages: 'thread',
  threadReplies: 'thread',
  missedMessages: 'history',
  positionAt: 'history',
  historyRange: 'history',
  pullHistory: 'history',
};
