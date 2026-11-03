import { fromBinary } from '@bufbuild/protobuf';
import { floatRepr, PyFloat, pyDumps } from '../pyjson.js';
import { head } from '../text.js';
import { type Dict, toDict } from './dict.js';
import { larkType, protoEnum, protoType } from './registry.js';

export const MSG_TYPE_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  2: 'POST',
  3: 'FILE',
  4: 'TEXT',
  5: 'IMAGE',
  6: 'SYSTEM',
  7: 'AUDIO',
  8: 'EMAIL',
  9: 'SHARE_GROUP_CHAT',
  10: 'STICKER',
  11: 'MERGE_FORWARD',
  12: 'CALENDAR',
  13: 'CLOUD_FILE',
  14: 'CARD',
  15: 'MEDIA',
  16: 'SHARE_CALENDAR_EVENT',
  17: 'HONGBAO',
  18: 'GENERAL_CALENDAR',
  19: 'VIDEO_CHAT',
  20: 'LOCATION',
  22: 'COMMERCIALIZED_HONGBAO',
  23: 'SHARE_USER_CARD',
  24: 'TODO',
  25: 'FOLDER',
};
export const CHAT_TYPE_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'P2P',
  2: 'GROUP',
  3: 'TOPIC_GROUP',
};
/** THREAD / THREAD_V2 of Chat.ChatMode: newly created thread groups are GROUP + one of these modes; only legacy thread groups are TOPIC_GROUP. */
const THREAD_CHAT_MODES = [2, 3];

const typeName = (t: number) => MSG_TYPE_NAMES[t] ?? String(t);

/** A decoded message, with fields matching the original project's message dict (used for DB storage, the agent, and command output). */
export interface LarkMessage {
  msg_id: string;
  msg_type: number;
  msg_type_name: string;
  from_id: string;
  chat_id: string;
  chat_type: number;
  chat_type_name: string;
  scope: 'chat' | 'topic';
  anchor: string;
  at_me: boolean;
  root_id: string;
  parent_id: string;
  cid: string;
  position: number | null;
  create_time: number | null;
  content: string;
  content_data: Dict | null;
  /** Recalled (the push re-sends the same message in recalled state); present only when true. */
  recalled?: true;
  /** Edited (content is the edited content); present only when true. */
  edited?: true;
}

// entities.Message.Status
const STATUS_DELETED = 2;
const STATUS_MODIFIED = 3;

export function enumToInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const named = protoEnum('entities.Message.Type').values.find((v) => v.name === value);
    if (named) return named.number;
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

const num = (v: unknown): number | null =>
  v === undefined || v === null ? null : typeof v === 'bigint' ? Number(v) : (v as number);
/** Dict value to string (like a Python f-string): missing becomes an empty string, floats use Python repr. */
const str = (v: unknown): string =>
  v === undefined || v === null ? '' : v instanceof PyFloat ? floatRepr(v.value) : String(v);

/** In a thread group, every root message starts its own thread. chatInfo is a single chat returned by chats.PullChatsByIdsRequest. */
export function isThreadChat(chatInfo: Dict): boolean {
  return (
    THREAD_CHAT_MODES.includes(enumToInt(chatInfo.chatMode ?? 0)) ||
    enumToInt(chatInfo.type ?? 0) === 3
  );
}

/** Returns [scope, anchor]: anchor is the --root used when replying, and also the agent's chat boundary. */
export function resolveScope(
  msgId: string,
  msgType: number,
  chatType: number,
  rootId: string,
  threadId: string,
  threadChat = false,
): ['chat' | 'topic', string] {
  if (chatType === 1) return ['chat', ''];
  if (rootId && rootId !== '0') return ['topic', threadId || rootId];
  // In a thread group a root message itself opens a thread (except system notices such as group creation); in regular groups every message also carries threadId=its own id, so that can't be used to decide
  if ((threadChat || chatType === 3) && msgType !== 6) return ['topic', msgId || ''];
  return ['chat', ''];
}

const TAG_PLACEHOLDERS: Record<number, string> = {
  2: '[Image]',
  5: '[@]',
  10: '[Sticker]',
  18: '[Video]',
  22: '[Doc]',
};

/** Flatten rich text to plain text: text-like elements give their content, paragraphs end with a newline, @ gives the display name, everything else gets a placeholder. */
export function extractRichText(richText: Dict | undefined): string {
  let text = '';
  try {
    const dictionary = (richText?.elements as Dict | undefined)?.dictionary as
      | Record<string, Dict>
      | undefined;
    if (!dictionary) return '';
    const elementIds = (richText?.elementIds as string[] | undefined) ?? [];
    let ordered: [string, Dict][];
    if (elementIds.length) {
      const listed = new Set(elementIds);
      ordered = elementIds.filter((k) => k in dictionary).map((k) => [k, dictionary[k] as Dict]);
      ordered.push(...Object.entries(dictionary).filter(([k]) => !listed.has(k)));
    } else {
      ordered = Object.entries(dictionary);
      if (ordered.every(([k]) => /^-?\d+$/.test(k)))
        ordered.sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    }
    for (const [, v] of ordered) {
      const tag = (v.tag as number | undefined) ?? 1;
      const prop = v.property as Uint8Array | undefined;
      if (!prop?.length) continue;
      // 49 is the MARKDOWN element (common in bot and Markdown messages); like TextProperty its content is field 1, taken verbatim
      if ([1, 3, 7, 8, 9, 17, 49].includes(tag)) {
        try {
          text += str(
            toDict(protoType('TextProperty'), fromBinary(protoType('TextProperty'), prop)).content,
          );
          if (tag === 3) text += '\n';
          continue;
        } catch {}
      }
      if (tag === 5) {
        try {
          const at = toDict(protoType('AtProperty'), fromBinary(protoType('AtProperty'), prop));
          if (at.content) {
            text += str(at.content);
            continue;
          }
        } catch {}
      }
      text += TAG_PLACEHOLDERS[tag] ?? '';
    }
  } catch {}
  return text;
}

function parse(type: string, bytes: Uint8Array): Dict {
  const desc = protoType(type);
  let msg: ReturnType<typeof fromBinary>;
  try {
    msg = fromBinary(desc, bytes);
  } catch {
    // Same error text as the original project (protobuf upb); it ends up in the summary and is stored in the DB
    throw new Error(`Error parsing message with type '${type.split('.').at(-1)}'`);
  }
  return toDict(desc, msg);
}

const fmt1 = (ms: unknown) => (Number(ms ?? 0) / 1000).toFixed(1);
const get = (d: unknown, k: string): unknown => (d as Dict | undefined)?.[k];

/** Message content → [summary text, content dict]; the summary format matches the original project's decode_message_content character for character. */
export function decodeMessageContent(
  messageType: number,
  content: Uint8Array = new Uint8Array(),
): [string, Dict | null] {
  try {
    switch (messageType) {
      case 4: {
        const d = parse('TextContent', content);
        return [extractRichText(d.richText as Dict | undefined) || str(d.text), d];
      }
      case 2: {
        const d = parse('PostContent', content);
        const text = extractRichText(d.richText as Dict | undefined) || str(d.text);
        return [`[Rich text] ${str(d.title)}\n${text}`.trim(), d];
      }
      case 5: {
        const d = parse('ImageContent', content);
        const v2 = d.imageV2 as Dict | undefined;
        if (v2 && Object.keys(v2).length) {
          let width: unknown = '?';
          let height: unknown = '?';
          for (const variant of (v2.variants as Dict[] | undefined) ?? []) {
            if (variant.type === 1) {
              const size = (variant.size as Dict | undefined) ?? {};
              width = size.width ?? '?';
              height = size.height ?? '?';
              break;
            }
          }
          const crypto = 'crypto' in v2 ? ' encrypted' : '';
          return [
            `[Image] imageKey=${str(v2.imageKey)} (${str(width)}x${str(height)})${crypto}`,
            d,
          ];
        }
        const image = (d.image as Dict | undefined) ?? {};
        const img = (image.origin as Dict | undefined) ?? {};
        const key = img.key || image.key || image.imageKey || '';
        return [
          `[Image] imageKey=${str(key)} (${str(img.width ?? '?')}x${str(img.height ?? '?')})`,
          d,
        ];
      }
      case 3: {
        const d = parse('FileContent', content);
        return [
          `[File] ${str(d.name)} (${str(d.mime)}, ${str(d.size ?? 0)} bytes, key=${str(d.key)})`,
          d,
        ];
      }
      case 15: {
        const d = parse('MediaContent', content);
        return [
          `[Video] ${str(d.name)} (duration ${fmt1(d.duration)}s, ${str(d.size ?? 0)} bytes, key=${str(d.key)})`,
          d,
        ];
      }
      case 7: {
        const d = parse('AudioContent', content);
        return [`[Audio] duration ${fmt1(d.duration)}s, key=${str(d.key)}`, d];
      }
      case 10: {
        const d = parse('StickerContent', content);
        return [`[Sticker] stickerId=${str(d.stickerId)} key=${str(d.key)}`, d];
      }
      case 14: {
        const d = parse('CardContent', content);
        const header = (d.cardHeader as Dict | undefined) ?? {};
        const title = header.title || header.mainTitle || '';
        const jsonCard = str(d.jsonCard);
        const parts = ['[Card]'];
        if (title) parts.push(str(title));
        if (d.cardDesc) parts.push(`(${str(d.cardDesc)})`);
        if (jsonCard) parts.push(head(jsonCard, 2000));
        else if (d.openCardContent)
          parts.push(`<openCardContent ${(d.openCardContent as Uint8Array).length} bytes>`);
        return [parts.join(' '), d];
      }
      case 11: {
        const d = parse('MergeForwardContent', content);
        const msgs = (d.messages as Dict[] | undefined) ?? [];
        const name =
          str(d.groupChatName) ||
          `chat between ${str(d.p2pCreatorName)} and ${str(d.p2pPartnerName)}`;
        const lines = [`[Merged forward] ${name}, ${msgs.length} messages:`];
        for (const m of msgs.slice(0, 20)) {
          const [sub] = decodeMessageContent(
            enumToInt(m.type ?? 0),
            (m.content as Uint8Array | undefined) ?? new Uint8Array(),
          );
          lines.push(`  ${str(m.fromId)}: ${sub}`);
        }
        return [lines.join('\n'), d];
      }
      case 20: {
        const d = parse('LocationContent', content);
        const desc = (d.locationDescription as Dict | undefined) ?? {};
        return [
          `[Location] ${str(desc.name)} ${str(desc.description)} (${str(d.latitude)},${str(d.longitude)})`,
          d,
        ];
      }
      case 6: {
        const d = parse('SystemContent', content);
        const texts: string[] = [];
        for (const cv of Object.values((d.sysContentValues as Record<string, Dict>) ?? {})) {
          for (const item of (get(cv, 'items') as Dict[] | undefined) ?? []) {
            if (item.text) texts.push(str(item.text));
          }
        }
        return [`[System message] type=${str(d.typeNum || d.type)} ${texts.join(' ')}`, d];
      }
      case 23: {
        const d = parse('ShareUserCardContent', content);
        return [`[Contact card] ${str(d.name)} (userId=${str(d.userId)})`, d];
      }
      case 9: {
        const d = parse('ShareGroupChatContent', content);
        const chat = (d.chat as Dict | undefined) ?? {};
        return [`[Shared group] ${str(chat.name)} (chatId=${str(d.chatId || chat.id)})`, d];
      }
      case 16: {
        const d = parse('ShareCalendarEventContent', content);
        return [`[Shared event] attendees=${str(d.attendeesCount ?? '?')}`, d];
      }
      case 17: {
        const d = parse('HongbaoContent', content);
        return [`[Red packet] ${str(d.subject)}`, d];
      }
      case 12: {
        const d = parse('CalendarContent', content);
        return [`[Calendar] ${str(d.calendar)}`, d];
      }
      case 19: {
        const d = parse('VideoChatContent', content);
        return [`[Video meeting] ${str(get(d.meetingCard, 'topic'))}`, d];
      }
      case 8: {
        const d = parse('EmailContent', content);
        return [`[Email] ${str(d.title)} ${str(d.text)}`, d];
      }
    }
  } catch (err) {
    return [`[${typeName(messageType)} message: decode failed: ${(err as Error).message}]`, null];
  }
  return [`[${typeName(messageType)} message]`, null];
}

/** Long-connection frame → [Frame dict, Packet dict]. */
export function parseWsFrame(raw: Uint8Array): [Dict, Dict] {
  const frame = fromBinary(protoType('Frame'), raw);
  const frameDict = toDict(protoType('Frame'), frame);
  const payload = (frameDict.payload as Uint8Array | undefined) ?? new Uint8Array();
  return [frameDict, toDict(protoType('Packet'), fromBinary(protoType('Packet'), payload))];
}

/** Whether the message @-mentions selfId: the server's mention list (atUserIdList), or @all in rich text. */
function mentions(v: Dict, data: Dict | null, selfId: string): boolean {
  if (((v.atUserIdList as unknown[] | undefined) ?? []).some((id) => String(id) === selfId))
    return true;
  const rt = data?.richText as Dict | undefined;
  const dict = ((rt?.elements as Dict | undefined)?.dictionary ?? {}) as Record<string, Dict>;
  for (const id of (rt?.atIds as string[] | undefined) ?? []) {
    const prop = dict[id]?.property as Uint8Array | undefined;
    if (!prop?.length) continue;
    try {
      const at = toDict(protoType('AtProperty'), fromBinary(protoType('AtProperty'), prop));
      if (at.userId === 'all' || String(at.userId) === selfId) return true;
    } catch {}
  }
  return false;
}

/** Entity message dict (push or pull result) → LarkMessage. */
export function toLarkMessage(
  v: Dict,
  o: {
    atMe?: boolean;
    threadChat?: boolean;
    fallbackChatId?: string;
    fallbackPosition?: number;
    /** Current account id: when there is no pushed atMe (pulled messages), at_me is computed from the users @-mentioned in the message. */
    selfId?: string;
  },
): LarkMessage {
  const msgType = enumToInt(v.type ?? 0);
  const chatType = enumToInt(v.chatType ?? 0);
  const [summary, data] = decodeMessageContent(
    msgType,
    (v.content as Uint8Array | undefined) ?? new Uint8Array(),
  );
  const rootId = str(v.rootId);
  const [scope, anchor] = resolveScope(
    str(v.id),
    msgType,
    chatType,
    rootId,
    str(v.threadId),
    o.threadChat ?? false,
  );
  const position = num(v.position);
  const status = enumToInt(v.status ?? 0);
  const recalled = status === STATUS_DELETED || v.isRemoved === true;
  const edited = !recalled && (status === STATUS_MODIFIED || Number(v.editVersion ?? 0) > 0);
  return {
    msg_id: str(v.id),
    msg_type: msgType,
    msg_type_name: typeName(msgType),
    from_id: str(v.fromId),
    chat_id: str(v.chatId || v.channelId || o.fallbackChatId),
    chat_type: chatType,
    chat_type_name: CHAT_TYPE_NAMES[chatType] ?? String(chatType),
    scope,
    anchor,
    at_me: o.atMe ?? (o.selfId ? mentions(v, data, o.selfId) : false),
    root_id: rootId,
    parent_id: str(v.parentId),
    cid: str(v.cid),
    position: o.fallbackPosition === undefined ? position : position || o.fallbackPosition,
    create_time: num(v.createTime),
    content: summary,
    content_data: data,
    ...(recalled ? { recalled: true as const } : {}),
    ...(edited ? { edited: true as const } : {}),
  };
}

/** All messages in a push frame (cmd=6). */
export function decodePushMessages(raw: Uint8Array): LarkMessage[] {
  const [, packet] = parseWsFrame(raw);
  if (!('payload' in packet)) return [];
  const pmr = parse('PushMessagesRequest', packet.payload as Uint8Array);
  const atMe = (pmr.messagesAtMe as Record<string, boolean> | undefined) ?? {};
  return Object.entries((pmr.messages as Record<string, Dict> | undefined) ?? {}).map(([k, v]) =>
    toLarkMessage(v, { atMe: Boolean(atMe[str(v.id)] || atMe[k]) }),
  );
}

/**
 * Storage format of content_data (the content_data column in messages.db): written like Python `json.dumps(ensure_ascii=False)`,
 * with raw bytes (inline thumbnails etc.) replaced by a `<n bytes>` placeholder and truncated to 20,000 characters; empty string when there is no content.
 */
export function contentDataJson(data: Dict | null | undefined): string {
  if (data === null || data === undefined) return '';
  const fallback = (o: unknown): unknown =>
    o instanceof Uint8Array ? `<${o.length} bytes>` : String(o);
  return head(pyDumps(data, { fallback }), 20000);
}

/** One reaction change (long-connection push cmd=27): who added / removed which reaction on which message, plus the current count of each reaction on that message. */
export interface ReactionEvent {
  message_id: string;
  reaction_type: string;
  user_id: string;
  cancelled: boolean;
  counts: Record<string, number>;
}

/** Reaction push (reactions.PushReactions) payload → reaction change; only messages that carry an operator count as a change. */
export function decodePushReactions(payload: Uint8Array): ReactionEvent[] {
  const desc = larkType('reactions.PushReactions');
  const d = toDict(desc, fromBinary(desc, payload));
  const extras = (d.reactionExtraInfos ?? {}) as Record<string, Dict>;
  const out: ReactionEvent[] = [];
  for (const mr of (d.messageReactions ?? []) as Dict[]) {
    const id = str(mr.messageId);
    const extra = extras[id];
    if (!extra?.reactionChatterId || !extra.type) continue;
    const counts: Record<string, number> = {};
    for (const r of (mr.reactions ?? []) as Dict[])
      if (Number(r.count ?? 0) > 0) counts[str(r.type)] = Number(r.count);
    out.push({
      message_id: id,
      reaction_type: str(extra.type),
      user_id: str(extra.reactionChatterId),
      cancelled: extra.isCancelled === true,
      counts,
    });
  }
  return out;
}
