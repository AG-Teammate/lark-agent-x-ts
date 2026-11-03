import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getBackend } from '../agent/backend.js';
import { AgentDispatcher, type QuotedMessage } from '../agent/dispatcher.js';
import { AuthExpired, LarkAuth, QR_STATUS_NAMES, QrLogin } from '../auth.js';
import { LarkClient, type SendOptions } from '../client.js';
import { dataDir, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import {
  htmlToText,
  type MailAddress,
  type MailChangeResult,
  type MailFile,
  type MailMessage,
  type MailSearchHit,
} from '../mail.js';
import { download, extractResourceKey, messageResourceUrl } from '../media.js';
import {
  decide,
  GROUPS,
  type Group,
  loadRules,
  PERMISSIONS,
  type Permission,
  permissionsPath,
  saveAccountRules,
} from '../permissions.js';
import type { RichBlock } from '../proto/builders.js';
import {
  CHAT_TYPE_NAMES,
  type LarkMessage,
  MSG_TYPE_NAMES,
  type ReactionEvent,
} from '../proto/decoders.js';
import { type Dict, parseJsonKeepingBigInts } from '../proto/dict.js';
import { getRegion, REGIONS, type Region, urls } from '../region.js';
import { Storage } from '../storage/index.js';
import { head, preview } from '../text.js';
import type { CommandSpec, Option, Parsed } from './args.js';
import { errorText, localDatetime, printJson, pyDatetime, shortTime } from './format.js';
import { keepListening } from './listen-loop.js';
import { editInTerminal, PermissionEditor } from './permissions-editor.js';
import { qrAscii, saveQrPng } from './qr.js';
import { parseTimeArg } from './time.js';

const logger = getLogger('larkx.cli');

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const s = (v: Parsed[string]) => (v === undefined ? undefined : String(v));

export interface Command extends CommandSpec {
  /** The corresponding permission key (see src/permissions.ts); commands that mix reads and writes pick `command.action` based on their arguments. */
  access: Permission | ((args: Parsed) => Permission);
  run(args: Parsed): Promise<number>;
}

const client = async () => LarkClient.create(new LarkAuth());

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** QR-code login: refresh the QR code up to 6 times, waiting 45 seconds each. */
async function qrLogin(auth: LarkAuth, region: Region): Promise<number> {
  mkdirSync(dataDir(), { recursive: true });
  const pngPath = join(dataDir(), 'login_qr.png');
  for (let attempt = 1; attempt <= 6; attempt++) {
    let ql: QrLogin;
    try {
      ql = await QrLogin.start(region);
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    await saveQrPng(ql.qrContent, pngPath);
    out(`[${attempt}/6] QR code refreshed (scan it with the ${region.label} app): ${pngPath}`);
    if (attempt === 1) out(qrAscii(ql.qrContent));
    const [ok] = await ql.wait(45, 2, (status, step) =>
      out(
        `status: ${status === undefined ? 'None' : (QR_STATUS_NAMES[status] ?? status)} (${step ?? 'None'})`,
      ),
    );
    if (ok) {
      try {
        out(`logged in, credentials saved: ${await ql.finish(auth)}`);
        return 0;
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
    }
    out('QR code expired, refreshing...');
  }
  err('login not completed after several refreshes, please try again');
  return 1;
}

const auth: Command = {
  name: 'auth',
  help: 'manage credentials',
  access: (a) => `auth.${a.action as 'status' | 'import' | 'check' | 'qr'}`,
  positionals: [{ name: 'action', choices: ['status', 'import', 'check', 'qr'] }],
  options: [
    { name: 'cookie', kind: 'string', help: 'cookie string' },
    { name: 'file', kind: 'string', help: 'read the cookie from a file' },
    {
      name: 'region',
      kind: 'string',
      choices: Object.keys(REGIONS),
      help: 'region for qr/import: feishu=Feishu (China), lark=Lark (international), lark-jp=Lark Japan data center (jp.larksuite.com); defaults to the saved credentials, else LARKX_REGION',
    },
  ],
  async run(a) {
    const action = String(a.action);
    const la = new LarkAuth();
    // Region for a new login: --region > region of existing credentials > LARKX_REGION
    const region = a.region ? getRegion(String(a.region)) : la.region;
    if (action === 'status') {
      printJson(la.status());
      return 0;
    }
    if (action === 'import') {
      let cookieStr: string;
      if (a.cookie) cookieStr = String(a.cookie);
      else if (a.file) cookieStr = readFileSync(String(a.file), 'utf8');
      else {
        logger.info('paste the cookie string and press Enter:');
        cookieStr = await readLine('');
      }
      try {
        out(`imported (${region.name}): ${await la.importCookieString(cookieStr, region)}`);
        return 0;
      } catch (e) {
        err(`import failed: ${(e as Error).message}`);
        return 1;
      }
    }
    if (action === 'check') {
      const [ok, msg] = await la.validate(true);
      if (ok) la.save();
      out(`${ok ? 'OK ' : 'EXPIRED '}${msg}`);
      return ok ? 0 : 1;
    }
    return qrLogin(la, region);
  },
};

const NAMES_OPTION: Option = {
  name: 'names',
  kind: 'flag',
  help: 'show sender names (adds from_name with --json)',
};

const REPLY_OPTIONS: Option[] = [
  { name: 'root', kind: 'string', help: 'thread root message id; reply in that thread' },
  {
    name: 'reply',
    kind: 'string',
    help: 'quote-reply to this message id (goes into the thread if the quoted message is in one)',
  },
  {
    name: 'cid',
    kind: 'string',
    help: 'client message id (idempotency key): resending with the same cid returns the same message instead of a duplicate',
  },
];

const send: Command = {
  name: 'send',
  help: 'send a text message',
  access: 'send',
  positionals: [{ name: 'chat_id' }, { name: 'text', nargs: '+' }],
  options: [
    ...REPLY_OPTIONS,
    { name: 'links', kind: 'flag', help: 'send [text](url) in the text as hyperlinks' },
    {
      name: 'post',
      kind: 'flag',
      help: 'send as rich text: text is an HTML fragment (<p><b><a href><ul><li><blockquote><at user_id>)',
    },
    {
      name: 'md',
      kind: 'flag',
      help: 'send as Markdown (headings, lists, code blocks, quotes, bold/italic, links), rendered by the client',
    },
    { name: 'title', kind: 'string', help: 'rich-text title (with --post / --md)' },
    {
      name: 'rich',
      kind: 'string',
      help: 'structured rich-text JSON (or @file path), with text as the plain-text summary; blocks: p/ul/quote/blank, runs: text|link|at',
    },
  ],
  async run(a) {
    const c = await client();
    const st = new Storage();
    const chatId = String(a.chat_id);
    const text = (a.text as string[]).join(' ');
    const o = await replyTarget(st, chatId, a);
    let msgId: string | null;
    if (a.rich) {
      const raw = String(a.rich);
      const spec = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) as {
        blocks?: RichBlock[];
      };
      msgId = await c.sendRich(spec.blocks ?? [], text, chatId, o);
    } else if (a.md) {
      try {
        msgId = await c.sendMessage(chatId, { markdown: text, title: s(a.title) ?? '' }, o);
      } catch (e) {
        logger.error(`failed to send Markdown: ${errorText(e)}`);
        msgId = null;
      }
    } else if (a.post) {
      msgId = await c.sendPost(text, chatId, s(a.title) ?? '', o);
    } else {
      msgId = await c.sendMsg(text, chatId, o, Boolean(a.links));
    }
    const rich = Boolean(a.post || a.rich || a.md);
    return finishSend(st, c, chatId, msgId, o, rich ? 2 : 4, text);
  },
};

/** --root / --reply -> send options; if the quoted message is in a thread, the quote must carry the thread root, otherwise it lands back in the main chat. */
async function replyTarget(st: Storage, chatId: string, a: Parsed): Promise<SendOptions> {
  const reply = s(a.reply);
  let rootId = s(a.root);
  if (reply && !rootId) {
    const quoted = await st.getMessage(reply, chatId);
    if (quoted?.scope === 'topic' && quoted.anchor) rootId = quoted.anchor;
  }
  return { rootId, replyTo: reply, cid: s(a.cid) };
}

/** Send result: on success, store it under the server id (so the listener's echo completes this row instead of inserting another) and print msg_id. */
async function finishSend(
  st: Storage,
  c: LarkClient,
  chatId: string,
  msgId: string | null,
  o: SendOptions,
  msgType: number,
  content: string,
): Promise<number> {
  if (!msgId) {
    await st.close();
    err('send failed');
    return 1;
  }
  const { rootId, replyTo: reply } = o;
  const inTopic = Boolean(rootId) && rootId !== reply;
  await st.saveMessage(
    {
      msg_id: msgId,
      chat_id: chatId,
      chat_type: 0,
      chat_type_name: '',
      scope: inTopic ? 'topic' : 'chat',
      anchor: inTopic ? (rootId as string) : '',
      root_id: rootId || reply || '',
      parent_id: reply || rootId || '',
      from_id: c.auth.userId,
      msg_type: msgType,
      msg_type_name: MSG_TYPE_NAMES[msgType] ?? String(msgType),
      at_me: false,
      cid: '',
      position: null,
      content,
      content_data: null,
      create_time: Math.floor(Date.now() / 1000),
    },
    { senderName: 'me', direction: 'out' },
  );
  await st.close();
  out(`sent msg_id=${msgId}`);
  return 0;
}

/** Send an image or file: read the local file, upload it, then send. */
function mediaCommand(kind: 'image' | 'file'): Command {
  const label = kind === 'image' ? 'image' : 'file';
  return {
    name: `send-${kind}`,
    help: `send a local ${label} (uploaded automatically)`,
    access: `send-${kind}`,
    positionals: [{ name: 'chat_id' }, { name: 'path' }],
    options: REPLY_OPTIONS,
    async run(a) {
      const c = await client();
      const st = new Storage();
      const chatId = String(a.chat_id);
      const path = String(a.path);
      const name = basename(path);
      let data: Uint8Array;
      try {
        data = new Uint8Array(readFileSync(path));
      } catch (e) {
        await st.close();
        err(`failed to read file: ${(e as Error).message}`);
        return 1;
      }
      const o = await replyTarget(st, chatId, a);
      let msgId: string | null = null;
      try {
        msgId = await c.sendMessage(
          chatId,
          kind === 'image' ? { image: data, name } : { file: data, name },
          o,
        );
      } catch (e) {
        logger.error(`failed to send ${label}: ${errorText(e)}`);
      }
      return finishSend(st, c, chatId, msgId, o, kind === 'image' ? 5 : 3, `[${label}] ${name}`);
    },
  };
}

const schedule: Command = {
  name: 'schedule',
  help: 'schedule a message (sent by the server at the given time)',
  access: 'schedule',
  positionals: [{ name: 'chat_id' }, { name: 'text', nargs: '+' }],
  options: [
    {
      name: 'at',
      kind: 'string',
      required: true,
      help: 'send time: 10m/2h/1d from now, 2026-10-15 09:30, or a timestamp',
    },
    ...REPLY_OPTIONS,
    { name: 'md', kind: 'flag', help: 'send as Markdown' },
  ],
  async run(a) {
    let at: number;
    try {
      at = parseTimeArg(String(a.at), Date.now(), true);
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    if (at <= Date.now()) {
      err('send time must be in the future');
      return 1;
    }
    const c = await client();
    const st = new Storage();
    const chatId = String(a.chat_id);
    const text = (a.text as string[]).join(' ');
    const o = await replyTarget(st, chatId, a);
    await st.close();
    try {
      const id = await c.scheduleMessage(chatId, a.md ? { markdown: text } : { text }, at, o);
      out(`scheduled msg_id=${id} at ${shortTime(Math.floor(at / 1000))}`);
      return 0;
    } catch (e) {
      err(`failed to schedule: ${errorText(e)}`);
      return 1;
    }
  },
};

const scheduled: Command = {
  name: 'scheduled',
  help: 'list pending scheduled messages in a chat; --cancel cancels one, --reschedule with --at changes its time',
  access: (a) =>
    a.cancel ? 'scheduled.cancel' : a.reschedule ? 'scheduled.reschedule' : 'scheduled.list',
  positionals: [{ name: 'chat_id' }],
  options: [
    { name: 'cancel', kind: 'string', metavar: 'MSG_ID', help: 'cancel this scheduled message' },
    {
      name: 'reschedule',
      kind: 'string',
      metavar: 'MSG_ID',
      help: 'change the send time of this scheduled message',
    },
    { name: 'at', kind: 'string', help: 'new send time (with --reschedule)' },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const chatId = String(a.chat_id);
    try {
      if (a.cancel) {
        await c.cancelScheduledMessage(chatId, String(a.cancel));
        out(`cancelled msg_id=${a.cancel}`);
        return 0;
      }
      if (a.reschedule) {
        if (!a.at) {
          err('--reschedule requires --at');
          return 2;
        }
        const at = parseTimeArg(String(a.at), Date.now(), true);
        await c.rescheduleMessage(chatId, String(a.reschedule), at);
        out(`rescheduled msg_id=${a.reschedule} to ${shortTime(Math.floor(at / 1000))}`);
        return 0;
      }
    } catch (e) {
      err(`operation failed: ${errorText(e)}`);
      return 1;
    }
    const list = await c.scheduledMessages(chatId);
    if (a.json)
      printJson(list.map(({ message, ...m }) => ({ ...m, content: message?.content ?? '' })));
    else
      for (const m of list)
        out(
          `${m.messageId} [${shortTime(Math.floor(m.at / 1000))}]${m.status === 'suspended' ? ' (suspended)' : ''} ${preview(m.message?.content || '', 100)}`,
        );
    return 0;
  },
};

const translate: Command = {
  name: 'translate',
  help: 'translate text; with --msg, translate the given message ids',
  access: 'translate',
  positionals: [{ name: 'args', nargs: '+', help: 'text to translate (message ids with --msg)' }],
  options: [
    {
      name: 'to',
      kind: 'string',
      default: 'zh',
      help: 'target language (zh, en, ja, ...; default zh)',
    },
    { name: 'msg', kind: 'flag', help: 'arguments are message ids' },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const args = a.args as string[];
    const to = String(a.to);
    try {
      if (a.msg) {
        const list = await c.translateMessages(args, to);
        if (a.json) printJson(list);
        else for (const t of list) out(`${t.msgId}\t${t.translated}`);
        const missing = args.filter((id) => !list.some((t) => t.msgId === id));
        if (missing.length) err(`nothing to translate: ${missing.join(', ')}`);
        return 0;
      }
      const [translated] = await c.translateText([args.join(' ')], to);
      out(String(translated));
      return 0;
    } catch (e) {
      err(`translation failed: ${errorText(e)}`);
      return 1;
    }
  },
};

const forward: Command = {
  name: 'forward',
  help: 'forward a message to one or more chats',
  access: 'forward',
  positionals: [{ name: 'msg_id' }, { name: 'chat_ids', nargs: '+' }],
  async run(a) {
    const targets = a.chat_ids as string[];
    let sent: Map<string, string>;
    try {
      sent = await (await client()).forwardMessage(String(a.msg_id), targets);
    } catch (e) {
      err(`forward failed: ${errorText(e)}`);
      return 1;
    }
    for (const chatId of targets)
      if (sent.has(chatId)) out(`forwarded chat_id=${chatId} msg_id=${sent.get(chatId)}`);
      else err(`failed to forward to ${chatId}`);
    return sent.size === targets.length ? 0 : 1;
  },
};

const group: Command = {
  name: 'group',
  help: 'manage groups: create <name>, add/remove <chat_id> <user_id...>, rename <chat_id> <new name>',
  access: (a) => `group.${a.action as 'create' | 'add' | 'remove' | 'rename'}`,
  positionals: [
    { name: 'action', choices: ['create', 'add', 'remove', 'rename'] },
    { name: 'args', nargs: '+' },
  ],
  options: [
    {
      name: 'members',
      kind: 'string',
      help: 'members to add on create (user_ids, comma-separated)',
    },
    { name: 'desc', kind: 'string', help: 'group description (create / rename)' },
    { name: 'topic', kind: 'flag', help: 'create a thread group' },
  ],
  async run(a) {
    const c = await client();
    const [first, ...rest] = a.args as string[];
    const target = String(first);
    try {
      switch (a.action) {
        case 'create': {
          const id = await c.createGroup([target, ...rest].join(' '), list(a.members) ?? [], {
            ...(a.desc ? { description: String(a.desc) } : {}),
            topic: Boolean(a.topic),
          });
          out(`created chat_id=${id}`);
          return 0;
        }
        case 'add':
        case 'remove':
          if (!rest.length) {
            err('user_id required');
            return 2;
          }
          if (a.action === 'add') await c.addMembers(target, rest);
          else await c.removeMembers(target, rest);
          out(
            `${a.action === 'add' ? 'added' : 'removed'} ${rest.length} member(s) chat_id=${target}`,
          );
          return 0;
        default:
          if (!rest.length && !a.desc) {
            err('new name or --desc required');
            return 2;
          }
          await c.updateGroup(target, {
            ...(rest.length ? { name: rest.join(' ') } : {}),
            ...(a.desc ? { description: String(a.desc) } : {}),
          });
          out(`updated chat_id=${target}`);
          return 0;
      }
    } catch (e) {
      err(`group operation failed: ${errorText(e)}`);
      return 1;
    }
  },
};

const pin: Command = {
  name: 'pin',
  help: 'Pin a message in a chat (visible to all members); --remove unpins',
  access: 'pin',
  positionals: [{ name: 'chat_id' }, { name: 'msg_id' }],
  options: [{ name: 'remove', kind: 'flag', help: 'unpin' }],
  async run(a) {
    const c = await client();
    const chatId = String(a.chat_id);
    const msgId = String(a.msg_id);
    try {
      if (a.remove) {
        if (!(await c.unpinMessage(chatId, msgId))) {
          err(`message ${msgId} is not pinned`);
          return 1;
        }
        out(`unpinned msg_id=${msgId}`);
      } else out(`pinned msg_id=${msgId} pin_id=${await c.pinMessage(chatId, msgId)}`);
      return 0;
    } catch (e) {
      err(`Pin failed: ${errorText(e)}`);
      return 1;
    }
  },
};

const pins: Command = {
  name: 'pins',
  help: 'list pinned messages in a chat',
  access: 'pins',
  positionals: [{ name: 'chat_id' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const list = await (await client()).chatPins(String(a.chat_id));
    if (a.json)
      printJson(
        list.map(({ message, ...p }) => {
          if (!message) return { ...p, message: null };
          const { content_data: _, ...rest } = message;
          return { ...p, message: rest };
        }),
      );
    else
      for (const p of list)
        out(
          `${p.messageId} [${shortTime(Math.floor(p.pinnedAt / 1000))}] ${p.message ? `${p.message.from_id}: ${preview(p.message.content || '', 100)}` : ''}`,
        );
    return 0;
  },
};

const shortcut: Command = {
  name: 'shortcut',
  help: 'pin chats to your chat list (only affects you); --remove unpins; no arguments lists pinned chats',
  access: (a) =>
    !list(a.chat_ids)?.length ? 'shortcut.list' : a.remove ? 'shortcut.remove' : 'shortcut.add',
  positionals: [{ name: 'chat_ids', nargs: '?', help: 'chat ids (comma-separated)' }],
  options: [{ name: 'remove', kind: 'flag', help: 'unpin from the chat list' }],
  async run(a) {
    const c = await client();
    const ids = list(a.chat_ids);
    if (!ids?.length) {
      for (const id of await c.shortcuts()) out(id);
      return 0;
    }
    try {
      if (a.remove) await c.removeShortcuts(ids);
      else await c.addShortcuts(ids);
    } catch (e) {
      err(`failed to update chat list pins: ${errorText(e)}`);
      return 1;
    }
    out(`${a.remove ? 'unpinned' : 'pinned'} ${ids.length} chat(s)`);
    return 0;
  },
};

const flag: Command = {
  name: 'flag',
  help: 'flag messages for later; --chat flags chats, --remove unflags',
  access: 'flag',
  positionals: [{ name: 'ids', nargs: '+', help: 'message ids (chat_ids with --chat)' }],
  options: [
    { name: 'chat', kind: 'flag', help: 'ids are chats' },
    { name: 'remove', kind: 'flag', help: 'remove the flag' },
  ],
  async run(a) {
    const c = await client();
    const ids = a.ids as string[];
    try {
      if (a.chat) await c.flagChats(ids, Boolean(a.remove));
      else await c.flagMessages(ids, Boolean(a.remove));
    } catch (e) {
      err(`flag failed: ${errorText(e)}`);
      return 1;
    }
    out(`${a.remove ? 'unflagged' : 'flagged'} ${ids.length} ${a.chat ? 'chat(s)' : 'message(s)'}`);
    return 0;
  },
};

const flags: Command = {
  name: 'flags',
  help: 'list my flags (messages and chats)',
  access: 'flags',
  options: [
    { name: 'limit', kind: 'int', default: 50 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const list = await (await client()).flags(Number(a.limit));
    if (a.json)
      printJson(
        list.map(({ message, ...f }) => {
          if (!message) return { ...f, message: null };
          const { content_data: _, ...rest } = message;
          return { ...f, message: rest };
        }),
      );
    else
      for (const f of list) {
        const m = f.message;
        out(
          f.type === 'chat'
            ? `chat ${f.id}`
            : `message ${f.id} ${m ? `${m.chat_id} [${shortTime(m.create_time)}] ${m.from_id}: ${preview(m.content || '', 100)}` : ''}`,
        );
      }
    return 0;
  },
};

const recall: Command = {
  name: 'recall',
  help: 'recall messages (your own; group admins can recall others in the group)',
  access: 'recall',
  positionals: [{ name: 'message_ids', nargs: '+' }],
  async run(a) {
    const c = await client();
    let failed = 0;
    for (const id of a.message_ids as string[]) {
      try {
        await c.recallMessage(id);
        out(`recalled msg_id=${id}`);
      } catch (e) {
        failed++;
        err(`failed to recall ${id}: ${errorText(e)}`);
      }
    }
    return failed ? 1 : 0;
  },
};

const edit: Command = {
  name: 'edit',
  help: 'edit your own text/rich-text message (replaces it whole; others see "edited")',
  access: 'edit',
  positionals: [{ name: 'msg_id' }, { name: 'text', nargs: '+' }],
  options: [
    { name: 'links', kind: 'flag', help: 'send [text](url) in the text as hyperlinks' },
    { name: 'md', kind: 'flag', help: 'rewrite as Markdown; the original must be rich text' },
    {
      name: 'rich',
      kind: 'string',
      help: 'structured rich-text JSON (or @file path), with text as the plain-text summary; the original must be rich text',
    },
  ],
  async run(a) {
    const c = await client();
    const id = String(a.msg_id);
    const text = (a.text as string[]).join(' ');
    try {
      if (a.rich) {
        const raw = String(a.rich);
        const spec = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) as {
          blocks?: RichBlock[];
        };
        await c.editMessage(id, { blocks: spec.blocks ?? [], text });
      } else if (a.md) await c.editMessage(id, { markdown: text });
      else await c.editMessage(id, { text, links: Boolean(a.links) });
    } catch (e) {
      err(`edit failed: ${errorText(e)}`);
      return 1;
    }
    out(`edited msg_id=${id}`);
    return 0;
  },
};

const react: Command = {
  name: 'react',
  help: 'add a reaction to messages (e.g. THUMBSUP, OK, DONE, SMILE); --remove removes it',
  access: 'react',
  positionals: [{ name: 'msg_id' }, { name: 'reaction_type' }],
  options: [{ name: 'remove', kind: 'flag', help: 'remove your own reaction' }],
  async run(a) {
    const c = await client();
    const id = String(a.msg_id);
    const type = String(a.reaction_type);
    try {
      if (a.remove) await c.removeReaction(id, type);
      else await c.addReaction(id, type);
    } catch (e) {
      err(`failed to ${a.remove ? 'remove' : 'add'} reaction: ${errorText(e)}`);
      return 1;
    }
    out(`${a.remove ? 'removed' : 'added'} reaction ${type} msg_id=${id}`);
    return 0;
  },
};

const reactions: Command = {
  name: 'reactions',
  help: 'show reactions on messages',
  access: 'reactions',
  positionals: [{ name: 'message_ids', nargs: '+' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const list = await (await client()).reactions(a.message_ids as string[]);
    if (a.json) printJson(list);
    else
      for (const m of list)
        for (const r of m.reactions)
          out(`${m.messageId}\t${r.type}\t${r.count}\t${r.userIds.join(',')}`);
    return 0;
  },
};

const readStatus: Command = {
  name: 'read-status',
  help: 'read status of messages: who has read them and who has not (sender view); --me checks whether you have read them',
  access: 'read-status',
  positionals: [{ name: 'chat_id' }, { name: 'message_ids', nargs: '+' }],
  options: [
    { name: 'me', kind: 'flag', help: 'check whether you have read these messages' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const ids = a.message_ids as string[];
    if (a.me) {
      const mine = await c.myReadStates(ids);
      if (a.json) printJson(Object.fromEntries(mine));
      else
        for (const [id, t] of mine) out(`${id}\t${t === null ? 'unread' : `read ${shortTime(t)}`}`);
      return 0;
    }
    const states = await c.readStates(String(a.chat_id), ids);
    const names = a.names
      ? await c.userNames(states.flatMap((st) => [...st.readUserIds, ...st.unreadUserIds]))
      : undefined;
    const who = (ids2: string[]) => ids2.map((id) => names?.get(id) || id).join(',');
    if (a.json) printJson(states);
    else
      for (const st of states)
        out(
          `${st.messageId}\tread ${st.readCount}\tunread ${st.unreadCount}${st.unreadUserIds.length ? `\tunread: ${who(st.unreadUserIds)}` : ''}`,
        );
    return 0;
  },
};

const messageLink: Command = {
  name: 'message-link',
  help: 'create a message link (applink client/message/link/open?token=...); several message ids make one combined link',
  access: 'message-link',
  positionals: [{ name: 'chat_id' }, { name: 'message_ids', nargs: '+' }],
  async run(a) {
    const url = await (await client()).messageLink(String(a.chat_id), a.message_ids as string[]);
    if (!url) {
      err('failed to create message link');
      return 1;
    }
    out(url);
    return 0;
  },
};

const selfChat: Command = {
  name: 'self-chat',
  help: 'print the current account and the chat_id of your own chat (for lark send notes to yourself)',
  access: 'self-chat',
  async run() {
    const cid = await (await client()).selfChat();
    if (!cid) {
      err('failed to get your own chat');
      return 1;
    }
    out(cid);
    return 0;
  },
};

const read: Command = {
  name: 'read',
  help: 'mark messages as read (as if viewed in the client: advances the read position to the newest one and the sender sees them read; thread replies are marked per thread)',
  access: 'read',
  positionals: [{ name: 'chat_id' }, { name: 'message_ids', nargs: '+' }],
  async run(a) {
    const c = await client();
    try {
      out(`marked ${await c.readMessages(String(a.chat_id), a.message_ids as string[])} read`);
      return 0;
    } catch (e) {
      err(`failed to mark read: ${(e as Error).message}`);
      return 1;
    }
  },
};

const config: Command = {
  name: 'config',
  help: 'show the effective configuration (set in .env)',
  access: 'config',
  async run() {
    printJson(loadConfig());
    return 0;
  },
};

const CHAT_TYPE_LABELS: Record<number, string> = { 1: 'direct', 2: 'group', 3: 'thread group' };

const chats: Command = {
  name: 'chats',
  help: 'list local chats; --remote fetches the chat list from the server (direct and group chats in the inbox, most recently active first)',
  access: (a) => (a.remote ? 'chats.remote' : 'chats.local'),
  options: [
    { name: 'limit', kind: 'int', default: 50 },
    {
      name: 'remote',
      kind: 'flag',
      help: 'fetch the chat list from the server instead of the local database',
    },
    { name: 'json', kind: 'flag', help: 'output JSON (with --remote)' },
  ],
  async run(a) {
    if (a.remote) {
      const list = await (await client()).listChats(Number(a.limit));
      if (a.json) printJson(list);
      else
        for (const c of list)
          out(
            `${c.chatId}\t${CHAT_TYPE_LABELS[c.threadChat ? 3 : c.chatType] ?? '?'}\t${c.name || '(unnamed)'}\tupdated ${localDatetime(c.updatedAt)}`,
          );
      return 0;
    }
    const st = new Storage();
    for (const c of await st.listChats(Number(a.limit)))
      out(
        `${c.chat_id}\t${CHAT_TYPE_LABELS[c.chat_type] ?? '?'}\t${c.name || '(unnamed)'}\tupdated ${pyDatetime(c.updated_at)}`,
      );
    await st.close();
    return 0;
  },
};

const sessions: Command = {
  name: 'sessions',
  help: 'list agent sessions (session table)',
  access: 'sessions',
  options: [{ name: 'limit', kind: 'int', default: 50 }],
  async run(a) {
    const st = new Storage();
    for (const r of await st.listSessions(Number(a.limit))) {
      const scope = r.anchor ? 'thread' : r.session_key === 'global' ? 'global' : 'chat';
      out(
        `${r.session_key}\t${scope}\tchat=${r.chat_id}\tanchor=${r.anchor || '-'}\t${r.started ? 'started' : 'pending'}\tmsg=${r.msg_count}\tactive ${pyDatetime(r.last_active)}`,
      );
    }
    await st.close();
    return 0;
  },
};

const messages: Command = {
  name: 'messages',
  help: 'read local message history',
  access: 'messages',
  positionals: [{ name: 'chat_id' }],
  options: [
    { name: 'anchor', kind: 'string', help: 'thread id; empty string = main chat stream only' },
    { name: 'limit', kind: 'int', default: 50 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const st = new Storage();
    const rows = await st.getMessages(String(a.chat_id), {
      anchor: s(a.anchor),
      limit: Number(a.limit),
    });
    await st.close();
    if (a.json) {
      printJson(rows.map((r) => ({ ...r, stored_at: pyDatetime(r.stored_at) })));
      return 0;
    }
    for (const r of rows) {
      const scope = r.anchor ? `[${r.scope}:${head(r.anchor, 8)}]` : '';
      out(
        `[${shortTime(r.create_time)}]${scope} ${r.sender_name || r.sender_id}: ${preview(r.content || '', 120)}`,
      );
    }
    return 0;
  },
};

const search: Command = {
  name: 'search',
  help: 'search users/groups',
  access: 'search',
  positionals: [{ name: 'query', nargs: '+' }],
  async run(a) {
    printJson(await (await client()).search((a.query as string[]).join(' ')));
    return 0;
  },
};

const api: Command = {
  name: 'api',
  help: 'call any gateway endpoint (type names in docs/cmd_table.md)',
  access: 'api',
  positionals: [
    {
      name: 'type',
      help: 'proto request type name (e.g. chats.PullChatsByIdsRequest) or cmd number',
    },
    { name: 'json_body', nargs: '?', help: 'request fields as JSON' },
  ],
  async run(a) {
    const c = await client();
    let data: Dict | null = null;
    if (a.json_body) {
      try {
        data = parseJsonKeepingBigInts(String(a.json_body)) as Dict;
      } catch (e) {
        err(`invalid JSON: ${(e as Error).message}`);
        return 1;
      }
    }
    let resp: Dict;
    try {
      resp = await c.api(String(a.type), data);
    } catch (e) {
      err(errorText(e));
      return 1;
    }
    printJson(resp);
    return 0;
  },
};

/**
 * Output for pulled messages (shared by history / get / thread): one line per message, or with --json the full fields minus content_data.
 * When names is given (--names), senders are shown by name, and --json adds a from_name field.
 */
function printMessages(msgs: LarkMessage[], json: boolean, names?: Map<string, string>): void {
  if (json) {
    printJson(
      msgs.map(({ content_data: _, ...rest }) =>
        names ? { ...rest, from_name: names.get(rest.from_id) ?? '' } : rest,
      ),
    );
    return;
  }
  for (const m of msgs) {
    const scope = m.anchor ? `[${m.scope}:${head(m.anchor, 8)}]` : '';
    const sender = names?.get(m.from_id) || m.from_id;
    out(
      `${String(m.position).padStart(6)} [${shortTime(m.create_time)}]${scope} ${sender}: ${preview(m.content || '', 120)}`,
    );
  }
}

/** With --names, look up sender names; ids that can't be resolved are shown as-is. */
async function senderNames(
  c: LarkClient,
  msgs: LarkMessage[],
  want: boolean,
): Promise<Map<string, string> | undefined> {
  if (!want) return undefined;
  try {
    return await c.userNames(msgs.map((m) => m.from_id));
  } catch (e) {
    logger.warning(`failed to look up sender names: ${errorText(e)}`);
    return new Map();
  }
}

const list = (v: Parsed[string]) =>
  v === undefined
    ? undefined
    : String(v)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

const searchMessages: Command = {
  name: 'search-messages',
  help: 'search messages across chats (like the client search box "Messages" tab)',
  access: 'search-messages',
  positionals: [{ name: 'query', nargs: '+' }],
  options: [
    { name: 'chat', kind: 'string', help: 'only these chats (chat_ids, comma-separated)' },
    { name: 'from', kind: 'string', help: 'only from these senders (user_ids, comma-separated)' },
    {
      name: 'since',
      kind: 'string',
      help: 'start time: 30m/2h/3d/1w, 2026-10-01, 2026-10-01 09:30, or a timestamp',
    },
    { name: 'until', kind: 'string', help: 'end time (same format as --since)' },
    { name: 'limit', kind: 'int', default: 20 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    let since: number | undefined;
    let until: number | undefined;
    try {
      since = a.since === undefined ? undefined : parseTimeArg(String(a.since));
      until = a.until === undefined ? undefined : parseTimeArg(String(a.until));
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const hits = await (await client()).searchMessages((a.query as string[]).join(' '), {
      chatIds: list(a.chat),
      fromIds: list(a.from),
      since,
      until,
      limit: Number(a.limit),
    });
    if (a.json) printJson(hits);
    else
      for (const h of hits)
        out(
          `${h.msgId} [${shortTime(h.createTime)}] ${h.chatId}(${h.chatTitle}) ${preview(h.summary, 120)}`,
        );
    return 0;
  },
};

const unread: Command = {
  name: 'unread',
  help: 'unread: lists chats with unread messages; --chat shows unread messages in a chat; --at shows only unread messages that @mention you',
  access: 'unread',
  options: [
    { name: 'chat', kind: 'string', help: 'show unread messages in this chat' },
    { name: 'at', kind: 'flag', help: 'unread messages that @mention you (or @all) across chats' },
    {
      name: 'since',
      kind: 'string',
      help: 'only chats active since this time (default 30d; same format as search-messages)',
    },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    let since: number | undefined;
    try {
      since = a.since === undefined ? undefined : parseTimeArg(String(a.since));
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const c = await client();
    if (a.chat || a.at) {
      const msgs = a.chat ? await c.unreadMessages(String(a.chat)) : await c.unreadMentions(since);
      printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
      return 0;
    }
    const chats = await c.unreadChats(since);
    if (a.json) printJson(chats);
    else
      for (const u of chats)
        out(
          `${u.chatId}\t${CHAT_TYPE_LABELS[u.threadChat ? 3 : u.chatType] ?? '?'}\t${u.name || '(unnamed)'}\tunread ${u.unread}${u.unreadThreads ? `, new threads ${u.unreadThreads}` : ''}`,
        );
    return 0;
  },
};

const members: Command = {
  name: 'members',
  help: 'list chat members (id, name, type user/bot)',
  access: 'members',
  positionals: [{ name: 'chat_id' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const list = await (await client()).chatMembers(String(a.chat_id));
    if (a.json) printJson(list);
    else for (const m of list) out(`${m.id}\t${m.name}\t${m.type}`);
    return 0;
  },
};

const users: Command = {
  name: 'users',
  help: 'look up names by user id (batch)',
  access: 'users',
  positionals: [{ name: 'user_ids', nargs: '+' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const ids = a.user_ids as string[];
    const names = await (await client()).userNames(ids);
    if (a.json) printJson(Object.fromEntries(names));
    else for (const id of ids) if (names.has(id)) out(`${id}\t${names.get(id)}`);
    const missing = ids.filter((id) => !names.has(id));
    if (missing.length) err(`not found: ${missing.join(', ')}`);
    return missing.length ? 1 : 0;
  },
};

const getCmd: Command = {
  name: 'get',
  help: 'fetch messages by id (any chat, including quoted originals and messages from links)',
  access: 'get',
  positionals: [{ name: 'message_ids', nargs: '+' }],
  options: [
    { name: 'save', kind: 'flag', help: 'also save to the local database' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const ids = a.message_ids as string[];
    const c = await client();
    const msgs = await c.getMessages(ids);
    await saveAll(msgs, Boolean(a.save));
    printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
    const missing = ids.filter((id) => !msgs.some((m) => m.msg_id === id));
    if (missing.length) err(`message not found: ${missing.join(', ')}`);
    return missing.length ? 1 : 0;
  },
};

const thread: Command = {
  name: 'thread',
  help: 'fetch a thread: the root message plus recent replies',
  access: 'thread',
  positionals: [{ name: 'root_id', help: 'thread root message id (the message anchor)' }],
  options: [
    { name: 'count', kind: 'int', default: 50, help: 'maximum number of replies' },
    { name: 'save', kind: 'flag', help: 'also save to the local database' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const msgs = await c.threadMessages(String(a.root_id), Number(a.count));
    if (!msgs.length) {
      err(`thread root message not found: ${a.root_id}`);
      return 1;
    }
    await saveAll(msgs, Boolean(a.save));
    printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
    return 0;
  },
};

async function saveAll(msgs: LarkMessage[], save: boolean): Promise<void> {
  if (!save) return;
  const st = new Storage();
  for (const m of msgs) await st.saveMessage(m).catch(() => {});
  await st.close();
}

const history: Command = {
  name: 'history',
  help: 'fetch chat history',
  access: 'history',
  positionals: [{ name: 'chat_id' }],
  options: [
    { name: 'start', kind: 'int', help: 'start position (default: newest, going backwards)' },
    { name: 'count', kind: 'int', default: 20 },
    {
      name: 'since',
      kind: 'string',
      help: 'only messages after this time (30m/2h/3d, 2026-10-01 09:30, or a timestamp; takes the newest count in range)',
    },
    {
      name: 'until',
      kind: 'string',
      help: 'only messages before this time (same format as --since)',
    },
    { name: 'save', kind: 'flag', help: 'also save to the local database' },
    NAMES_OPTION,
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const c = await client();
    const chatId = String(a.chat_id);
    const count = Number(a.count);
    if (a.since !== undefined || a.until !== undefined) {
      let since: number | undefined;
      let until: number | undefined;
      try {
        since = a.since === undefined ? undefined : parseTimeArg(String(a.since));
        until = a.until === undefined ? undefined : parseTimeArg(String(a.until));
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
      const st = a.save ? new Storage() : undefined;
      const msgs = await c.historyRange(
        chatId,
        { since, until, limit: count },
        st ? (m: LarkMessage) => st.saveMessage(m) : undefined,
      );
      await st?.close();
      printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
      if (a.save) out(`saved ${msgs.length} messages`);
      return 0;
    }
    let start: number;
    if (a.start !== undefined) start = Number(a.start);
    else {
      const info = await c.getChatInfo(chatId);
      if (!info?.lastMessagePosition) {
        err('could not get the latest chat position; pass --start');
        return 1;
      }
      start = Number(info.lastMessagePosition) - count + 1;
      if (info.name) {
        const st = new Storage();
        await st.updateChatName(
          chatId,
          String(info.name),
          typeof info.type === 'number' ? info.type : 0,
        );
        await st.close();
      }
    }
    const first = Math.max(1, start);
    const positions = Array.from({ length: count }, (_, i) => first + i);
    const st = a.save ? new Storage() : undefined;
    const msgs = await c.pullHistory(
      chatId,
      positions,
      st ? (m: LarkMessage) => st.saveMessage(m) : undefined,
    );
    await st?.close();
    printMessages(msgs, Boolean(a.json), await senderNames(c, msgs, Boolean(a.names)));
    if (a.save) out(`saved ${msgs.length} messages`);
    return 0;
  },
};

const downloadCmd: Command = {
  name: 'download',
  help: 'download images, files and other resources from a message',
  access: 'download',
  positionals: [
    {
      name: 'msg_id',
      nargs: '?',
      help: 'message id (resource key looked up in the local database)',
    },
  ],
  options: [
    { name: 'key', kind: 'string', help: 'resource key (img_v3_*/file_v3_*); requires --chat' },
    { name: 'chat', kind: 'string', help: 'chat_id (with --key, or to speed up the local lookup)' },
    { name: 'out', short: '-o', kind: 'string', required: true, help: 'output path' },
  ],
  async run(a) {
    const la = new LarkAuth();
    await la.requireValid();
    const fileHost = urls.fileHost(la.region);
    const msgId = s(a.msg_id);
    let url: string;
    if (a.key) {
      if (!a.chat) {
        err('--key requires --chat <chat_id>');
        return 1;
      }
      url = messageResourceUrl(msgId || '0', String(a.key), String(a.chat), fileHost);
    } else {
      const st = new Storage();
      const rows = a.chat
        ? (await st.getMessages(String(a.chat), { limit: 500 })).filter((r) => r.msg_id === msgId)
        : await st.findMessages(String(msgId));
      await st.close();
      const r = rows.at(-1);
      let found:
        | Pick<LarkMessage, 'msg_id' | 'chat_id' | 'msg_type' | 'msg_type_name' | 'content_data'>
        | undefined;
      if (r?.content_data) found = { ...r, content_data: JSON.parse(r.content_data) as Dict };
      else if (msgId) {
        // Not stored locally (or only a content-less row written earlier by lark send): fetch it from the server by id
        const c = await LarkClient.create(la);
        found = (await c.getMessages([msgId]))[0];
      }
      if (!found) {
        err(`message ${msgId} not found (use --key/--chat to specify the resource directly)`);
        return 1;
      }
      const key = extractResourceKey(found.msg_type, found.content_data);
      if (!key) {
        err(`message ${msgId} is ${found.msg_type_name} and has nothing to download`);
        return 1;
      }
      url = messageResourceUrl(found.msg_id, key, found.chat_id, fileHost);
    }
    const [path, contentType, n] = await download(la, url, String(a.out));
    out(`downloaded: ${path} (${contentType}, ${n} bytes)`);
    return 0;
  },
};

async function askLoginChoice(): Promise<'qr' | 'cookie' | 'quit'> {
  out('  [1] log in with QR code (recommended)');
  out('  [2] log in by pasting a cookie');
  out('  [q] quit');
  const c = (await readLine('choice: ')).trim().toLowerCase();
  return c === '1' ? 'qr' : c === '2' ? 'cookie' : 'quit';
}

/** Use credentials if valid; if expired, re-login interactively in the terminal (QR scan or pasted cookie); in a non-interactive environment, throw AuthExpired. */
async function interactiveLogin(): Promise<LarkAuth> {
  const la = new LarkAuth();
  const [ok, msg] = await la.validate(true);
  if (ok) {
    la.save();
    return la;
  }
  if (!process.stdin.isTTY) throw new AuthExpired(msg);
  out(
    `credentials missing or expired (region: ${la.region.name}; to switch, use lark auth qr --region <feishu|lark|lark-jp>): ${msg}`,
  );
  for (;;) {
    const choice = await askLoginChoice();
    if (choice === 'qr') {
      if ((await qrLogin(la, la.region)) === 0) {
        const fresh = new LarkAuth();
        if ((await fresh.validate())[0]) return fresh;
      }
    } else if (choice === 'cookie') {
      const cookieStr = (await readLine('paste the full cookie and press Enter: ')).trim();
      try {
        await la.importCookieString(cookieStr);
        return la;
      } catch (e) {
        out(`import failed: ${(e as Error).message}`);
      }
    } else process.exit(1);
  }
}

/** The chats in a label change over time, so when the digital twin filters by label it re-resolves them periodically. */
const TAG_REFRESH_MS = 5 * 60_000;

/** Find labels by name or id and return all chats in them; labels not found are logged as warnings. */
async function tagChats(c: LarkClient, wanted: string[]): Promise<Set<string>> {
  const groups = await c.feedGroups();
  const chats = new Set<string>();
  for (const w of wanted) {
    const g = groups.find((x) => x.id === w || x.name === w);
    if (!g) {
      logger.warning(`chat tag not found: ${w}`);
      continue;
    }
    for (const id of await c.feedGroupChats(g.id)) chats.add(id);
  }
  return chats;
}

const tags: Command = {
  name: 'tags',
  help: 'chat tags: no arguments lists tags; a tag name or id lists its chats',
  access: 'tags',
  positionals: [{ name: 'tag', nargs: '?' }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const c = await client();
    if (a.tag === undefined) {
      const groups = await c.feedGroups();
      if (a.json) printJson(groups);
      else for (const g of groups) out(`${g.id}\t${g.name}\t${g.type}`);
      return 0;
    }
    const groups = await c.feedGroups();
    const g = groups.find((x) => x.id === a.tag || x.name === a.tag);
    if (!g) {
      err(`chat tag not found: ${a.tag}`);
      return 1;
    }
    const ids = await c.feedGroupChats(g.id);
    if (a.json) printJson(ids);
    else for (const id of ids) out(id);
    return 0;
  },
};

async function listenOnce(agentEnabled: boolean, la: LarkAuth): Promise<never> {
  const c = await LarkClient.create(la);
  const st = new Storage();
  if (agentEnabled && !la.userId) {
    await la.fetchProfile();
    la.save();
  }
  if (agentEnabled && !la.userId) {
    err(
      'cannot determine the current user_id; refusing to start --agent because it could reply to itself. Run lark auth check to verify your credentials.',
    );
    process.exit(1);
  }
  const cfg = loadConfig();
  const line = '─'.repeat(56);
  out(line);
  out(
    `LarkAgentX started  region=${la.region.name}  user=${la.userId}  device=${head(la.deviceId, 12)}…`,
  );
  out(`  storage: ${cfg.storage_url}`);
  out(
    `  context scope: ${cfg.context_scope}  agent backend: ${cfg.agent_backend}${agentEnabled ? '  (enabled)' : '  (disabled, storing only)'}`,
  );
  out(
    `  trigger prefix: ${cfg.triggers.prefix || '(all messages)'}  custom prompt: ${cfg.system_prompt ? 'yes' : 'no'}`,
  );
  out(line);
  const dispatcher = agentEnabled
    ? new AgentDispatcher(await getBackend(undefined, st), (chatId, text, rootId) =>
        c.sendMsg(text, chatId, { rootId }),
      )
    : null;
  if (dispatcher && cfg.triggers.include_tags.length) {
    const refresh = async () => {
      try {
        dispatcher.setTagChats(await tagChats(c, cfg.triggers.include_tags));
      } catch (e) {
        logger.warning(`failed to resolve chat tags: ${errorText(e)}`);
      }
    };
    await refresh();
    setInterval(refresh, TAG_REFRESH_MS);
  }
  const names = new Map<string, string | null>();
  /** The message a reply (quote or thread reply) refers to: check the local store first, then fetch from the server; omitted if it can't be fetched. */
  const quoted = async (msg: LarkMessage): Promise<QuotedMessage | undefined> => {
    const pid = msg.parent_id;
    if (!pid || pid === '0' || pid === msg.msg_id) return undefined;
    const row = await st.getMessage(pid, msg.chat_id);
    if (row?.content)
      return {
        id: pid,
        sender_id: row.sender_id,
        sender_name: row.sender_name,
        content: row.content,
      };
    try {
      const [m] = await c.getMessages([pid]);
      if (!m) return undefined;
      const key = `${m.from_id}\u0000${msg.chat_id}`;
      if (!names.has(key)) names.set(key, await c.getUserName(m.from_id, msg.chat_id));
      return {
        id: pid,
        sender_id: m.from_id,
        sender_name: names.get(key) || '',
        content: m.content,
      };
    } catch (e) {
      logger.debug(`failed to fetch quoted message: ${errorText(e)}`);
      return undefined;
    }
  };
  const onMessage = async (msg: LarkMessage) => {
    const chatId = msg.chat_id;
    const chatType = msg.chat_type ?? 0;
    const isOwn = String(msg.from_id) === String(la.userId);
    const senderKey = `${msg.from_id}\u0000${chatId}`;
    if (!names.has(senderKey)) names.set(senderKey, await c.getUserName(msg.from_id, chatId));
    const senderName = names.get(senderKey) || '';
    if (!names.has(chatId)) {
      if (chatType === 2 || chatType === 3) {
        const name = await c.getGroupName(chatId);
        names.set(chatId, name);
        if (name) await st.updateChatName(chatId, name, chatType);
      } else if (chatType === 1 && !isOwn && senderName) {
        names.set(chatId, senderName);
        await st.updateChatName(chatId, senderName, chatType);
      }
    }
    const chatName = names.get(chatId) || '';
    const who = `[${chatName || chatId}] ${senderName || msg.from_id}`;
    // Recalls and edits are re-pushed as the same message: recalled ones are no longer passed to the agent; edited ones update the stored content and let the agent see the new content
    if (msg.recalled) {
      dispatcher?.withdraw(msg.msg_id);
      if (await st.markRecalled(msg.msg_id, chatId)) logger.info(`${who} recalled a message`);
      return;
    }
    if (msg.edited && (await st.reviseMessage(msg))) {
      logger.info(`${who} edited a message: ${preview(msg.content || '', 80)}`);
      await dispatcher?.revise(msg, chatName, senderName, la.userId);
      return;
    }
    const saved = await st.saveMessage(msg, {
      senderName,
      chatName,
      direction: isOwn ? 'out' : 'in',
    });
    if (!saved) return;
    const shown = `${who}: ${preview(msg.content || '', 80)}`;
    logger.info(isOwn && process.stderr.isTTY ? `\x1b[36m${shown}\x1b[0m` : shown);
    if (cfg.mark_read && !isOwn && msg.position)
      await c.markRead(chatId, msg.position, [msg.msg_id]);
    if (dispatcher) {
      const quote = dispatcher.shouldHandle(msg, la.userId) ? await quoted(msg) : undefined;
      await dispatcher.submit(msg, chatName, senderName, la.userId, quote);
    }
  };
  /** Reaction changes: log them; with LARKX_AGENT_REACTIONS enabled, others adding / removing reactions on my messages are handed to the digital twin. */
  const onReaction = async (ev: ReactionEvent) => {
    if (ev.user_id === la.userId) return;
    const row = await st.findMessages(ev.message_id);
    let target: LarkMessage | undefined;
    if (row[0]) {
      const r = row[0];
      target = {
        msg_id: r.msg_id,
        msg_type: r.msg_type,
        msg_type_name: r.msg_type_name,
        from_id: r.sender_id,
        chat_id: r.chat_id,
        chat_type: r.chat_type,
        chat_type_name: CHAT_TYPE_NAMES[r.chat_type] ?? '',
        scope: r.scope as 'chat' | 'topic',
        anchor: r.anchor,
        at_me: false,
        root_id: r.root_id,
        parent_id: r.parent_id,
        cid: '',
        position: r.position,
        create_time: r.create_time,
        content: r.content,
        content_data: null,
      };
    } else [target] = await c.getMessages([ev.message_id]).catch(() => []);
    if (!target) return;
    const chatId = target.chat_id;
    const key = `${ev.user_id}\u0000${chatId}`;
    if (!names.has(key)) names.set(key, await c.getUserName(ev.user_id, chatId));
    const senderName = names.get(key) || '';
    const chatName = names.get(chatId) || (await st.getChatName(chatId));
    logger.info(
      `[${chatName || chatId}] ${senderName || ev.user_id} ${ev.cancelled ? 'removed' : 'added'} reaction ${ev.reaction_type}: ${preview(target.content || '', 40)}`,
    );
    if (dispatcher && cfg.agent_reactions && target.from_id === la.userId)
      await dispatcher.submitReaction(
        ev,
        target,
        {
          id: target.msg_id,
          sender_id: target.from_id,
          sender_name: 'me',
          content: target.content,
        },
        chatName,
        senderName,
        la.userId,
      );
  };
  await keepListening(c, onMessage, {
    onReaction,
    missed: (since) =>
      c.missedMessages(since, {
        localPosition: (chatId) => st.lastPosition(chatId),
        knownThreads: (chatId) => st.recentAnchors(chatId),
      }),
  });
  throw new Error('long connection loop exited unexpectedly');
}

const listen: Command = {
  name: 'listen',
  help: 'listen for messages continuously',
  access: 'listen',
  options: [{ name: 'agent', kind: 'flag', help: 'auto-reply with the local coding agent' }],
  async run(a) {
    process.on('SIGINT', () => {
      out('\nstopped');
      process.exit(0);
    });
    for (;;) {
      try {
        await listenOnce(Boolean(a.agent), await interactiveLogin());
      } catch (e) {
        if (!(e instanceof AuthExpired)) throw e;
        if (!process.stdin.isTTY) {
          err(e.message);
          return 1;
        }
        out(`credentials expired while running: ${e.message}`);
      }
    }
  },
};

const permissions: Command = {
  name: 'permissions',
  help: "command permissions: no arguments lists whether each command may run; edit opens an interactive editor for this account's rules (replacing the global rules); clear removes them",
  access: (a) => `permissions.${(a.action ?? 'show') as 'show' | 'edit' | 'clear'}`,
  positionals: [{ name: 'action', nargs: '?', choices: ['show', 'edit', 'clear'] }],
  options: [{ name: 'json', kind: 'flag' }],
  async run(a) {
    const action = String(a.action ?? 'show');
    const auth = new LarkAuth();
    if (action === 'show') {
      const { rules, source } = loadRules(auth);
      const items = (Object.keys(PERMISSIONS) as Permission[]).map((p) => ({
        name: p,
        group: PERMISSIONS[p],
        ...decide(rules, p),
      }));
      if (a.json) {
        printJson({ source, ...rules, commands: items });
        return 0;
      }
      out(`effective rules: ${source}`);
      out(`allow: ${rules.allow.join(', ') || '-'}`);
      out(`deny: ${rules.deny.join(', ') || '-'}`);
      const width = Math.max(...items.map((i) => i.name.length)) + 2;
      for (const [group, desc] of Object.entries(GROUPS) as [Group, string][]) {
        out(`\n[${group}] ${desc}`);
        for (const i of items.filter((x) => x.group === group))
          out(
            `  ${i.name.padEnd(width)}${i.allowed ? 'allow' : 'deny'}${i.rule ? `  ${i.rule}` : ''}`,
          );
      }
      return 0;
    }
    if (!auth.userId) {
      err('no logged-in account; per-account rules require login (lark auth qr)');
      return 1;
    }
    if (action === 'clear') {
      saveAccountRules(auth, null);
      out(
        `cleared rules for account ${auth.userId}; using global rules (LARKX_ALLOW / LARKX_DENY)`,
      );
      return 0;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      err(
        'permissions edit must run in a terminal; in scripts, set LARKX_ALLOW / LARKX_DENY or edit permissions.json in the data directory',
      );
      return 2;
    }
    const current = loadRules(auth);
    const editor = new PermissionEditor(
      current.rules,
      `command permissions · account ${auth.userId}`,
      current.own
        ? "editing this account's own rules"
        : 'this account has no rules of its own; copied from the global rules below. Saving replaces the global rules for this account',
    );
    const rules = await editInTerminal(editor);
    if (!rules || !editor.dirty) {
      out('not saved; rules unchanged');
      return 0;
    }
    saveAccountRules(auth, rules);
    out(`saved rules for account ${auth.userId} (${permissionsPath(auth)})`);
    out(`allow: ${rules.allow.join(', ') || '-'}`);
    out(`deny: ${rules.deny.join(', ') || '-'}`);
    return 0;
  },
};

const MAIL_ACTIONS = [
  'labels',
  'addresses',
  'list',
  'thread',
  'get',
  'search',
  'download',
  'send',
  'reply',
  'forward',
  'send-draft',
  'delete-draft',
  'read',
  'flag',
  'label',
  'archive',
  'trash',
] as const;
type MailAction = (typeof MAIL_ACTIONS)[number];

const fmtAddress = (a: MailAddress) => (a.name ? `${a.name} <${a.address}>` : a.address);
const fmtHit = (h: MailSearchHit) =>
  `${h.messageId}\t${h.threadId}\t${localDatetime(h.createdAt)}\t${h.unread ? 'unread' : 'read'}\t${h.from}\t${h.subject || '(no subject)'}`;
const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

function printMailMessage(m: MailMessage, html: boolean): void {
  out(`== ${m.subject || '(no subject)'}`);
  out(`message_id: ${m.messageId}`);
  out(`thread_id: ${m.threadId}`);
  out(`date: ${localDatetime(m.createdAt)}`);
  out(`from: ${fmtAddress(m.from)}`);
  if (m.to.length) out(`to: ${m.to.map(fmtAddress).join(', ')}`);
  if (m.cc.length) out(`cc: ${m.cc.map(fmtAddress).join(', ')}`);
  if (m.bcc.length) out(`bcc: ${m.bcc.map(fmtAddress).join(', ')}`);
  out(`labels: ${m.labels.join(', ')}${m.draft ? ' (draft)' : ''}`);
  for (const a of m.attachments) out(`attachment: ${a.name} (${fmtSize(a.size)}) ${a.fileKey}`);
  out('');
  out(html ? m.html : m.text || htmlToText(m.html));
  out('');
}

/** Files named on the command line (comma-separated paths) → attachments. */
function readAttachments(v: Parsed[string]): MailFile[] {
  return (list(v) ?? []).map((path) => ({
    name: basename(path),
    data: new Uint8Array(readFileSync(path)),
  }));
}

/** Body from the positional words or --body-file; --html marks it as HTML. */
function mailBody(a: Parsed, words: string[]): { text?: string; html?: string } {
  const body = a.body_file ? readFileSync(String(a.body_file), 'utf8') : words.join(' ');
  return a.html ? { html: body } : { text: body.replace(/\\n/g, '\n') };
}

const mailCmd: Command = {
  name: 'mail',
  help: 'Lark Mail: list/thread/get/search/download, send/reply/forward, read/flag/label/archive/trash, labels',
  access: (a) => {
    const action = a.action as MailAction;
    if (a.draft && (action === 'send' || action === 'reply' || action === 'forward'))
      return 'mail.draft';
    return `mail.${action}`;
  },
  positionals: [
    { name: 'action', choices: MAIL_ACTIONS },
    {
      name: 'args',
      nargs: '*',
      help: 'message ids (thread ids with --thread), label, keyword or body text, depending on the action',
    },
  ],
  options: [
    { name: 'to', kind: 'string', help: 'recipients (comma-separated)' },
    { name: 'cc', kind: 'string', help: 'cc recipients (comma-separated)' },
    { name: 'bcc', kind: 'string', help: 'bcc recipients (comma-separated)' },
    {
      name: 'subject',
      kind: 'string',
      help: 'subject (send); subject filter (search, comma-separated)',
    },
    {
      name: 'from',
      kind: 'string',
      help: 'sender address (send/reply/forward); sender filter (search)',
    },
    { name: 'attach', kind: 'string', help: 'files to attach (comma-separated paths)' },
    { name: 'body-file', kind: 'string', help: 'read the body from a file' },
    {
      name: 'html',
      kind: 'flag',
      help: 'the body is HTML (send/reply/forward); print HTML bodies (thread/get)',
    },
    {
      name: 'draft',
      kind: 'flag',
      help: 'save as a draft instead of sending (send/reply/forward)',
    },
    { name: 'all', kind: 'flag', help: 'reply to all recipients' },
    { name: 'no-quote', kind: 'flag', help: 'reply without quoting the original' },
    { name: 'label', kind: 'string', help: 'restrict search to a label' },
    { name: 'since', kind: 'string', help: 'search from this time (3d, 2026-10-01, timestamp)' },
    { name: 'until', kind: 'string', help: 'search until this time' },
    { name: 'attachments', kind: 'flag', help: 'search only mail with attachments' },
    { name: 'before', kind: 'string', help: 'list: only mail older than this time (paging)' },
    {
      name: 'unread',
      kind: 'flag',
      help: 'list/search: only unread mail; read: mark unread instead',
    },
    { name: 'threads', kind: 'flag', help: 'list: group by conversation (one row per thread)' },
    {
      name: 'thread',
      kind: 'flag',
      help: 'read/flag/label/archive/trash: the ids are thread ids; act on all their messages',
    },
    { name: 'remove', kind: 'flag', help: 'flag/label: remove instead of add' },
    { name: 'undo', kind: 'flag', help: 'archive: move back to the inbox' },
    { name: 'restore', kind: 'flag', help: 'trash: restore from the trash' },
    {
      name: 'output',
      short: '-o',
      kind: 'string',
      default: '.',
      help: 'download: target directory',
    },
    { name: 'limit', kind: 'int', default: 20 },
    { name: 'json', kind: 'flag' },
  ],
  async run(a) {
    const action = a.action as MailAction;
    const args = (a.args as string[] | undefined) ?? [];
    const need = (n: number, what: string) => {
      if (args.length < n) throw new UsageHint(`mail ${action}: ${what} required`);
    };
    const m = (await client()).mail;
    const json = Boolean(a.json);
    try {
      switch (action) {
        case 'labels': {
          const labels = await m.labels();
          if (json) printJson(labels);
          else for (const l of labels) out(`${l.id}\t${l.kind}\t${l.name}\tunread ${l.unread}`);
          return 0;
        }
        case 'addresses': {
          const addrs = await m.addresses();
          if (json) printJson(addrs);
          else for (const x of addrs) out(fmtAddress(x));
          return 0;
        }
        case 'list': {
          const target = args[0] ?? 'INBOX';
          if (a.threads) {
            let threads = await m.threads(await m.resolveLabel(target), {
              limit: Number(a.limit),
              ...(a.before ? { before: parseTimeArg(String(a.before)) } : {}),
            });
            if (a.unread) threads = threads.filter((t) => t.unread);
            if (json) printJson(threads);
            else
              for (const t of threads) {
                const l = t.latest;
                out(
                  `${t.threadId}\t${localDatetime(t.updatedAt)}\t${t.unread ? 'unread' : 'read'}\t${l ? fmtAddress(l.from) : ''}\t${l?.subject || '(no subject)'}${t.messageCount > 1 ? ` (${t.messageCount})` : ''}`,
                );
              }
            return 0;
          }
          const msgs = await m.list(target, {
            limit: Number(a.limit),
            ...(a.before ? { until: parseTimeArg(String(a.before)) } : {}),
            unreadOnly: Boolean(a.unread),
          });
          if (json) printJson(msgs);
          else for (const h of msgs) out(fmtHit(h));
          return 0;
        }
        case 'thread': {
          need(1, 'thread_id');
          const msgs = await m.thread(args[0] as string);
          if (json) printJson(msgs);
          else for (const x of msgs) printMailMessage(x, Boolean(a.html));
          return 0;
        }
        case 'get': {
          need(1, 'message_id');
          const msgs = await m.messages(args);
          if (json) printJson(msgs);
          else for (const x of msgs) printMailMessage(x, Boolean(a.html));
          const missing = args.filter((id) => !msgs.some((x) => x.messageId === id));
          if (missing.length) err(`not found: ${missing.join(', ')}`);
          return missing.length ? 1 : 0;
        }
        case 'search': {
          const hits = await m.search(args.join(' '), {
            ...(a.from ? { from: list(a.from) ?? [] } : {}),
            ...(a.to ? { to: list(a.to) ?? [] } : {}),
            ...(a.subject ? { subject: list(a.subject) ?? [] } : {}),
            ...(a.label
              ? await m
                  .resolveTarget(String(a.label))
                  .then((t) => (t.folder ? { folder: t.id } : { label: t.id }))
              : {}),
            unreadOnly: Boolean(a.unread),
            ...(a.since ? { since: parseTimeArg(String(a.since)) } : {}),
            ...(a.until ? { until: parseTimeArg(String(a.until)) } : {}),
            hasAttachment: Boolean(a.attachments),
            limit: Number(a.limit),
          });
          if (json) printJson(hits);
          else for (const h of hits) out(fmtHit(h));
          return 0;
        }
        case 'download': {
          need(1, 'message_id');
          const [msg] = await m.messages([args[0] as string]);
          if (!msg) {
            err(`not found: ${args[0]}`);
            return 1;
          }
          if (!msg.attachments.length) {
            err('this message has no attachments');
            return 1;
          }
          const dir = String(a.output);
          mkdirSync(dir, { recursive: true });
          for (const att of msg.attachments) {
            const path = join(dir, basename(att.name) || att.fileKey);
            await Bun.write(path, await m.downloadAttachment(att.fileKey));
            out(`${path}\t${fmtSize(att.size)}`);
          }
          return 0;
        }
        case 'send': {
          const r = await m.send(
            {
              to: list(a.to) ?? [],
              cc: list(a.cc) ?? [],
              bcc: list(a.bcc) ?? [],
              subject: String(a.subject ?? ''),
              ...mailBody(a, args),
              attachments: readAttachments(a.attach),
              ...(a.from ? { from: String(a.from) } : {}),
            },
            { draftOnly: Boolean(a.draft) },
          );
          out(
            a.draft
              ? `draft saved draft_id=${r.messageId}`
              : `sent message_id=${r.messageId} thread_id=${r.threadId}`,
          );
          return 0;
        }
        case 'reply':
        case 'forward': {
          need(1, 'message_id');
          const [id, ...words] = args;
          const common = {
            ...mailBody(a, words),
            ...(a.to ? { to: list(a.to) ?? [] } : {}),
            ...(a.cc ? { cc: list(a.cc) ?? [] } : {}),
            ...(a.bcc ? { bcc: list(a.bcc) ?? [] } : {}),
            attachments: readAttachments(a.attach),
            ...(a.from ? { from: String(a.from) } : {}),
          };
          const draftOnly = { draftOnly: Boolean(a.draft) };
          if (action === 'forward' && !a.to) throw new UsageHint('mail forward: --to required');
          const r =
            action === 'reply'
              ? await m.reply(
                  id as string,
                  { ...common, all: Boolean(a.all), quote: !a.no_quote },
                  draftOnly,
                )
              : await m.forward(id as string, common, draftOnly);
          out(
            a.draft
              ? `draft saved draft_id=${r.messageId}`
              : `sent message_id=${r.messageId} thread_id=${r.threadId}`,
          );
          return 0;
        }
        case 'send-draft': {
          need(1, 'draft_id');
          const r = await m.sendDraft(args[0] as string);
          out(`sent message_id=${r.messageId} thread_id=${r.threadId}`);
          return 0;
        }
        case 'delete-draft':
          need(1, 'draft_id');
          await m.deleteDrafts(args);
          out(`deleted ${args.length} draft(s)`);
          return 0;
        case 'read':
        case 'flag':
        case 'label':
        case 'archive':
        case 'trash': {
          const what = a.thread ? 'thread_id' : 'message_id';
          let ids = args;
          let labelName = '';
          if (action === 'label') {
            need(2, `label and ${what}`);
            [labelName, ...ids] = args as [string, ...string[]];
          } else need(1, what);
          const o = { threads: Boolean(a.thread) };
          let r: MailChangeResult;
          let done: string;
          switch (action) {
            case 'read':
              r = await m.markRead(ids, !a.unread, o);
              done = `marked ${a.unread ? 'unread' : 'read'}`;
              break;
            case 'flag':
              r = await m.flag(ids, !a.remove, o);
              done = a.remove ? 'unflagged' : 'flagged';
              break;
            case 'label': {
              const id = await m.resolveLabel(labelName);
              r = await m.modify(ids, a.remove ? { remove: [id] } : { add: [id] }, o);
              done = `${a.remove ? 'removed' : 'added'} label ${labelName} on`;
              break;
            }
            case 'archive':
              r = await m.archive(ids, !a.undo, o);
              done = a.undo ? 'moved to inbox' : 'archived';
              break;
            default:
              r = await m.trash(ids, !a.restore, o);
              done = a.restore ? 'restored' : 'trashed';
          }
          if (json) printJson(r);
          else {
            out(`${done} ${r.messageIds.length} message(s)`);
            if (a.thread || r.failed.length) for (const id of r.messageIds) out(`ok\t${id}`);
          }
          for (const f of r.failed) err(`failed\t${f.messageId}\t${f.reason}`);
          return r.failed.length ? 1 : 0;
        }
      }
    } catch (e) {
      if (e instanceof UsageHint) {
        err(e.message);
        return 2;
      }
      err(`mail ${action} failed: ${errorText(e)}`);
      return 1;
    }
  },
};

/** A missing argument for one mail action (the parser can't express per-action arity); exits with 2 like other usage errors. */
class UsageHint extends Error {}

export const COMMANDS: Command[] = [
  auth,
  send,
  mediaCommand('image'),
  mediaCommand('file'),
  schedule,
  scheduled,
  translate,
  forward,
  group,
  pin,
  pins,
  shortcut,
  tags,
  flag,
  flags,
  recall,
  edit,
  react,
  reactions,
  readStatus,
  messageLink,
  selfChat,
  read,
  config,
  chats,
  sessions,
  messages,
  search,
  searchMessages,
  unread,
  members,
  users,
  api,
  history,
  getCmd,
  thread,
  downloadCmd,
  mailCmd,
  listen,
  permissions,
];
