import { type Config, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import type { LarkMessage } from '../proto/decoders.js';
import { head } from '../text.js';
import type { AgentBackend } from './backend.js';

const logger = getLogger('larkx.agent');

export const INSTRUCTIONS =
  'Above is a new message from a Lark chat (the XML contains the chat, sender and content). You are this digital twin and have the full conversation history. If the other party is also a bot and you are just exchanging pleasantries, stop and do not reply.';
export const OUTPUT_RULES =
  'If no reply is needed, just stop; do not explain or restate the message.';

/** The quoted (replied-to) message: the digital twin needs the original text to know what the other party is responding to. */
export interface QuotedMessage {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
}

/** Message handed to the agent: the decoded result plus chat name and sender name, with the quoted original text when replying to someone. */
export interface AgentMessage extends LarkMessage {
  _chat_name?: string;
  _sender_name?: string;
  _quote?: QuotedMessage;
  /** The other party edited a message that was already handed to the agent; this is the edited content. */
  _edited?: boolean;
  /** Not a message: the other party added / removed a reaction on the _quote message (one I sent). */
  _reaction?: { type: string; cancelled: boolean };
}

export type ReplyFn = (chatId: string, text: string, rootId?: string) => Promise<unknown>;

/** xml.sax.saxutils.escape. */
export const xmlEscape = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('>', '&gt;').replaceAll('<', '&lt;');

/** xml.sax.saxutils.quoteattr: picks the quote character based on content; newlines and tabs become character references. */
export function quoteAttr(s: string): string {
  let v = xmlEscape(s).replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');
  if (v.includes('"')) {
    if (v.includes("'")) v = `"${v.replaceAll('"', '&quot;')}"`;
    else v = `'${v}'`;
  } else v = `"${v}"`;
  return v;
}

const pad = (n: number) => String(n).padStart(2, '0');

function ts(m: LarkMessage): string {
  if (!m.create_time) return '';
  const d = new Date(Number(m.create_time) * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function buildXmlMessage(m: AgentMessage): string {
  const lines = ['<message>'];
  lines.push(
    `  <chat id=${quoteAttr(String(m.chat_id))} name=${quoteAttr(m._chat_name || '')} type=${quoteAttr(m.chat_type_name || '')} anchor=${quoteAttr(m.anchor || '')}/>`,
  );
  lines.push(
    `  <sender id=${quoteAttr(String(m.from_id))} name=${quoteAttr(m._sender_name || '')}/>`,
  );
  if (m.at_me) lines.push('  <at_me>true</at_me>');
  if (m._edited) lines.push('  <edited>true</edited>');
  if (m._reaction)
    lines.push(
      `  <reaction type=${quoteAttr(m._reaction.type)} cancelled=${quoteAttr(String(m._reaction.cancelled))}/>`,
    );
  if (m._quote)
    lines.push(
      `  <quote id=${quoteAttr(m._quote.id)} sender_id=${quoteAttr(m._quote.sender_id)} sender_name=${quoteAttr(m._quote.sender_name)}>${xmlEscape(m._quote.content)}</quote>`,
    );
  lines.push(`  <time>${xmlEscape(ts(m))}</time>`);
  lines.push(`  <content>${xmlEscape(m.content || '')}</content>`);
  lines.push('</message>');
  return lines.join('\n');
}

/** One FIFO queue per chat boundary; messages are handed to the agent one at a time so replies within a chat stay in order. */
class SessionWorker {
  readonly queue: AgentMessage[] = [];
  private running = false;

  constructor(
    private readonly dispatcher: AgentDispatcher,
    private readonly sessionKey: string,
  ) {}

  push(msg: AgentMessage): void {
    this.queue.push(msg);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let msg = this.queue.shift(); msg; msg = this.queue.shift()) {
        try {
          await this.dispatcher.handleMessage(this.sessionKey, msg);
        } catch (err) {
          logger.error(`error handling message [${this.sessionKey}]: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Digital twin dispatcher: filters messages by trigger rules, queues per chat boundary, supports /clear (start a new session) and /stop (clear the queue). */
export class AgentDispatcher {
  private readonly workers = new Map<string, SessionWorker>();
  private tagChats: Set<string> | null = null;

  /** Chats resolved from LARKX_TRIGGER_INCLUDE_TAGS (the chat_ids in those tags). */
  setTagChats(chatIds: Iterable<string>): void {
    this.tagChats = new Set(chatIds);
  }

  constructor(
    private readonly backend: AgentBackend,
    private readonly replyFn: ReplyFn,
    readonly cfg: Config = loadConfig(),
  ) {}

  sessionKeyOf(msg: LarkMessage): string {
    const scope = this.cfg.context_scope;
    if (scope === 'global') return 'global';
    if (scope === 'chat') return String(msg.chat_id);
    return `${msg.chat_id}:${msg.anchor || ''}`;
  }

  shouldHandle(msg: LarkMessage, myUserId: string): boolean {
    if (String(msg.from_id) === String(myUserId)) return false;
    const t = this.cfg.triggers;
    const content = (msg.content || '').trim();
    const chatId = String(msg.chat_id);
    const senderId = String(msg.from_id);
    const typeName =
      ({ 1: 'p2p', 2: 'group', 3: 'topic_group' } as Record<number, string>)[msg.chat_type] ?? '';
    if (t.prefix && !content.startsWith(t.prefix)) return false;
    if (t.chat_types.length && !t.chat_types.includes(typeName)) return false;
    if (t.include_chats.length && !t.include_chats.map(String).includes(chatId)) return false;
    if (t.exclude_chats.length && t.exclude_chats.map(String).includes(chatId)) return false;
    if (t.include_senders.length && !t.include_senders.map(String).includes(senderId)) return false;
    // Tagged chats are resolved by listen and passed in via setTagChats; until they are resolved, err on the side of handling nothing
    if (t.include_tags.length && !this.tagChats?.has(chatId)) return false;
    if (t.keywords.length && !t.keywords.some((kw) => content.includes(kw))) return false;
    if (t.group_at_only && (typeName === 'group' || typeName === 'topic_group') && !msg.at_me)
      return false;
    return true;
  }

  async submit(
    msg: LarkMessage,
    chatName = '',
    senderName = '',
    myUserId = '',
    quote?: QuotedMessage,
  ): Promise<void> {
    if (!this.shouldHandle(msg, myUserId)) return;
    const [cmd, remainder] = this.parseCommand(msg.content || '');
    const key = this.sessionKeyOf(msg);
    const chatId = String(msg.chat_id);
    const rootId = msg.anchor || undefined;
    if (cmd === 'clear') {
      this.drainQueue(key);
      await this.backend.resetSession(key);
      if (!remainder) {
        await this.replyFn(chatId, '✅ Started a new session', rootId);
        return;
      }
    } else if (cmd === 'stop') {
      const n = this.drainQueue(key);
      if (!remainder) {
        await this.replyFn(
          chatId,
          n ? `⏹ Cleared ${n} queued message${n === 1 ? '' : 's'}` : '⏹ Queue cleared',
          rootId,
        );
        return;
      }
    }
    const item: AgentMessage = {
      ...msg,
      _chat_name: chatName,
      _sender_name: senderName,
      ...(quote ? { _quote: quote } : {}),
    };
    if (cmd) item.content = remainder ?? '';
    this.enqueue(item);
  }

  /** The other party recalled a message: if it is still queued, it is no longer handed to the agent. Returns the number removed. */
  withdraw(msgId: string): number {
    let n = 0;
    for (const w of this.workers.values())
      for (let i = w.queue.length - 1; i >= 0; i--)
        if (w.queue[i]?.msg_id === msgId) {
          w.queue.splice(i, 1);
          n++;
        }
    return n;
  }

  /**
   * The other party edited a message: if still queued, its content is replaced in place; if already handled, it is handed to the agent again as a new message marked as edited.
   * Also subject to trigger-rule filtering.
   */
  async revise(msg: LarkMessage, chatName = '', senderName = '', myUserId = ''): Promise<void> {
    if (!this.shouldHandle(msg, myUserId)) return;
    for (const w of this.workers.values()) {
      const queued = w.queue.find((m) => m.msg_id === msg.msg_id);
      if (queued) {
        queued.content = msg.content;
        queued.content_data = msg.content_data;
        return;
      }
    }
    this.enqueue({ ...msg, _chat_name: chatName, _sender_name: senderName, _edited: true });
  }

  /**
   * The other party added / removed a reaction on a message I sent: handed to the agent as an event (the reacted-to message goes in quote).
   * Chat and sender filters still apply; the prefix, keyword, and "only @me in groups" rules target message content, so reaction events are exempt from them.
   */
  async submitReaction(
    ev: { message_id: string; reaction_type: string; user_id: string; cancelled: boolean },
    target: LarkMessage,
    quote: QuotedMessage,
    chatName = '',
    senderName = '',
    myUserId = '',
  ): Promise<void> {
    const msg: LarkMessage = {
      ...target,
      msg_id: `reaction:${ev.message_id}:${ev.reaction_type}:${ev.user_id}`,
      from_id: ev.user_id,
      at_me: true,
      content: '',
      content_data: null,
      parent_id: ev.message_id,
    };
    const t = { ...this.cfg.triggers, prefix: '', keywords: [], group_at_only: false };
    const filter = new AgentDispatcher(this.backend, this.replyFn, { ...this.cfg, triggers: t });
    if (this.tagChats) filter.setTagChats(this.tagChats);
    if (!filter.shouldHandle(msg, myUserId)) return;
    this.enqueue({
      ...msg,
      _chat_name: chatName,
      _sender_name: senderName,
      _quote: quote,
      _reaction: { type: ev.reaction_type, cancelled: ev.cancelled },
    });
  }

  private enqueue(item: AgentMessage): void {
    const key = this.sessionKeyOf(item);
    let worker = this.workers.get(key);
    if (!worker) {
      worker = new SessionWorker(this, key);
      this.workers.set(key, worker);
    }
    worker.push(item);
  }

  /** `/clear`, `/stop` (may follow the trigger prefix); returns [command, remaining content], or [null, null] if not a command. */
  parseCommand(content: string): [string | null, string | null] {
    const prefix = this.cfg.triggers.prefix;
    let c = content.trim();
    if (prefix && c.startsWith(prefix)) c = c.slice(prefix.length).trimStart();
    for (const cmd of ['/clear', '/stop']) {
      if (c === cmd) return [cmd.slice(1), ''];
      if (
        c.startsWith(cmd) &&
        c.length > cmd.length &&
        [' ', '\t', '\n'].includes(c[cmd.length] as string)
      )
        return [cmd.slice(1), c.slice(cmd.length).trim()];
    }
    return [null, null];
  }

  private drainQueue(key: string): number {
    const w = this.workers.get(key);
    if (!w) return 0;
    return w.queue.splice(0).length;
  }

  async handleMessage(sessionKey: string, msg: AgentMessage): Promise<void> {
    const body = buildXmlMessage(msg);
    const chatId = String(msg.chat_id);
    const rootId = msg.anchor || '';
    let replyCmd = `lark send ${chatId} "<reply text>"`;
    if (rootId) replyCmd += ` --root ${rootId}`;
    const rules = `To reply, run: ${replyCmd}\n${OUTPUT_RULES}`;
    const instructions = `${this.cfg.system_prompt || INSTRUCTIONS}\n${rules}`;
    const out = await this.backend.run(
      sessionKey,
      `${body}\n\n${instructions}`,
      chatId,
      msg.anchor || '',
    );
    if (out) logger.debug(`[${sessionKey}] agent output: ${head(out, 200)}`);
  }
}
