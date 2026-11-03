import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import { requestCid } from '../ids.js';
import { type Dict, fromDict, toDict } from './dict.js';
import { larkType, protoType } from './registry.js';

type Fields = Record<string, unknown>;

/** Wrap a request message in a gateway Packet. */
export function wrapPacket(cmd: number, typeName: string, payload: Message, requestId: string) {
  return create(protoType('Packet'), {
    payloadType: 1,
    cmd,
    cid: requestId,
    payload: toBinary(protoType(typeName), payload),
  } as Fields);
}

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

interface RichTextInit {
  elementIds: string[];
  innerText?: string;
  elements: {
    dictionary: Record<string, Fields>;
    styleRefs: Record<string, { styleIds: number[] }>;
    styles: Fields[];
  };
  atIds: string[];
  anchorIds: string[];
  markdownIds?: string[];
  version?: number;
}

const emptyRichText = (): RichTextInit => ({
  elementIds: [],
  elements: { dictionary: {}, styleRefs: {}, styles: [] },
  atIds: [],
  anchorIds: [],
});

const bin = (type: string, fields: Fields, lark = false) => {
  const desc = lark ? larkType(type) : protoType(type);
  return toBinary(desc, create(desc, fields));
};

/**
 * Fill text into richText: with richLinks, `[text](url)` becomes a hyperlink element with link text (tag A); everything else becomes a text element.
 * Verified: the web protocol's TEXT message accepts multiple TEXT/A elements; bold, paragraphs, and the POST type are all rejected by the server (400).
 */
function fillRichText(text: string, richLinks: boolean): RichTextInit {
  const rt = emptyRichText();
  let n = 0;
  const nid = () => String(++n);
  const addText = (s: string) => {
    if (!s) return;
    const i = nid();
    rt.elements.dictionary[i] = { tag: 1, property: bin('TextProperty', { content: s }) };
    rt.elementIds.push(i);
  };
  const addAnchor = (label: string, href: string) => {
    const i = nid();
    rt.elements.dictionary[i] = {
      tag: 6,
      property: bin('entities.RichTextElement.AnchorProperty', { href, content: label }, true),
    };
    rt.elementIds.push(i);
    rt.anchorIds.push(i);
  };
  if (!richLinks) addText(text);
  else {
    let pos = 0;
    for (const m of text.matchAll(LINK_RE)) {
      addText(text.slice(pos, m.index));
      addAnchor(m[1] as string, m[2] as string);
      pos = (m.index ?? 0) + m[0].length;
    }
    addText(text.slice(pos));
  }
  rt.innerText = text;
  return rt;
}

/** A run in structured rich text: text (optionally bold), a link with text, or an @mention. */
export type RichRun =
  | { text?: string; bold?: boolean }
  | { link: { text?: string; href: string } }
  | { at: { user_id: string; text?: string } };

export type RichBlock =
  | { type?: 'p'; runs?: RichRun[] }
  | { type: 'ul'; items?: RichRun[][] }
  | { type: 'quote'; blocks?: RichBlock[] }
  | { type: 'blank' };

/**
 * Fill richText from a structured spec (for POST). Verified details: container elements (p/ul/li/quote) must explicitly carry a property field (even if empty),
 * otherwise the server reports unmarshal failed; do not wrap in a DOCS root node; innerText is required; bold uses the TEXT element's style fontWeight + styles/styleRefs.
 */
function fillRichBlocks(blocks: RichBlock[], innerText: string): RichTextInit {
  const rt = emptyRichText();
  let counter = 0;
  let usedBold = false;
  const el = (
    tag: number,
    children: string[] = [],
    prop = new Uint8Array(),
    style?: Record<string, string>,
  ) => {
    const i = String(++counter);
    rt.elements.dictionary[i] = {
      tag,
      childIds: children,
      property: prop,
      ...(style ? { style } : {}),
    };
    return i;
  };
  const runEl = (run: RichRun): string => {
    if ('link' in run) {
      const href = String(run.link.href);
      const content = String(run.link.text || run.link.href);
      // Custom link text: the client uses isCustom/scene to decide to render it as text; otherwise it shows a "来自 xx 的消息链接" ("message link from xx") preview card
      const custom = content !== href ? { isCustom: true, scene: 3 } : {};
      const i = el(
        6,
        [],
        bin('entities.RichTextElement.AnchorProperty', { href, content, ...custom }, true),
      );
      rt.anchorIds.push(i);
      return i;
    }
    if ('at' in run) {
      const i = el(
        5,
        [],
        bin('AtProperty', { userId: String(run.at.user_id), content: String(run.at.text || '') }),
      );
      rt.atIds.push(i);
      return i;
    }
    const bold = Boolean(run.bold);
    usedBold ||= bold;
    return el(
      1,
      [],
      bin('TextProperty', { content: String(run.text ?? '') }),
      bold ? { fontWeight: 'bold' } : undefined,
    );
  };
  const blockEl = (block: RichBlock): string => {
    const t = block.type ?? 'p';
    if (t === 'blank') return el(3);
    if (t === 'p') return el(3, ((block as { runs?: RichRun[] }).runs ?? []).map(runEl));
    if (t === 'ul') {
      const items = ((block as { items?: RichRun[][] }).items ?? []).map((runs) =>
        el(28, runs.map(runEl)),
      );
      return el(26, items, Uint8Array.of(0x08, 0x00));
    }
    if (t === 'quote')
      return el(29, ((block as { blocks?: RichBlock[] }).blocks ?? []).map(blockEl));
    throw new Error(`未知的富文本块类型: ${t}`);
  };
  for (const b of blocks) rt.elementIds.push(blockEl(b));
  if (usedBold) {
    rt.elements.styles.push({ name: 'fontWeight', value: 'bold' });
    rt.elements.styleRefs.fontWeight = { styleIds: [0] };
  }
  rt.innerText = innerText;
  rt.version = 1;
  return rt;
}

/**
 * Markdown rich text: the whole body goes into one MARKDOWN element (tag 49), which the client renders as Markdown (like the md tag in Open Platform rich text);
 * headings, lists, code blocks, quotes, bold/italic, and links all display; innerText is the source text.
 */
function fillMarkdown(markdown: string): RichTextInit {
  const rt = emptyRichText();
  rt.elements.dictionary['1'] = {
    tag: 49,
    childIds: [],
    property: bin('entities.RichTextElement.MarkdownProperty', { content: markdown }, true),
  };
  rt.elementIds.push('1');
  rt.markdownIds = ['1'];
  rt.innerText = markdown;
  rt.version = 1;
  return rt;
}

/** Markdown rich text (POST) message. */
export function buildMarkdownMessagePacket(
  markdown: string,
  t: Target,
  requestId: string,
  title = '',
) {
  return putMessage(
    2,
    t,
    { ...(title ? { title } : {}), richText: fillMarkdown(markdown) },
    requestId,
  );
}

/** Editable message content: plain text (links as in sendMessage), structured rich text (text is a plain-text summary), or Markdown (the original message must be rich text). */
export type EditableContent =
  | { text: string; links?: boolean }
  | { blocks: RichBlock[]; text: string }
  | { markdown: string };

/** richText and message type for editing a message (text 4, rich text 2); built the same way as when sending. */
export function richTextOf(content: EditableContent): { type: 2 | 4; richText: RichTextInit } {
  if ('markdown' in content) return { type: 2, richText: fillMarkdown(content.markdown) };
  if ('blocks' in content)
    return { type: 2, richText: fillRichBlocks(content.blocks, content.text) };
  return { type: 4, richText: fillRichText(content.text, content.links ?? false) };
}

export interface Target {
  chatId: string;
  rootId?: string | undefined;
  replyTo?: string | undefined;
  /** Whether the chat is a thread group (thread groups reject isReplyInThread). */
  threadChat?: boolean;
  /** Client-side message id: the server dedupes on it, so resending with the same cid returns the same message. Randomly generated if not given. */
  cid?: string | undefined;
}

/**
 * Reply relationship: replyTo is a quoted reply (parentId=rootId=quoted message; without isReplyInThread it uses the normal quote style);
 * rootId replies into a thread: in a regular group, omitting isReplyInThread lands it in the main chat, whereas thread groups reject that flag (replyInThread not support chat).
 */
function replyFields(t: Target): Fields {
  if (t.replyTo && (!t.rootId || t.rootId === t.replyTo))
    return { rootId: t.replyTo, parentId: t.replyTo };
  if (t.rootId)
    return {
      rootId: t.rootId,
      parentId: t.replyTo || t.rootId,
      ...(t.threadChat ? {} : { isReplyInThread: true }),
    };
  return {};
}

function putMessage(type: number, t: Target, content: Fields, requestId: string) {
  const req = create(protoType('PutMessageRequest'), {
    type,
    chatId: t.chatId,
    cid: t.cid || requestCid(),
    isNotified: true,
    version: 1,
    ...replyFields(t),
    content,
  } as Fields);
  return wrapPacket(5, 'PutMessageRequest', req, requestId);
}

export function buildSendMessagePacket(
  text: string,
  t: Target,
  requestId: string,
  richLinks = false,
) {
  return putMessage(4, t, { richText: fillRichText(text, richLinks) }, requestId);
}

/** Structured rich text (POST) message; innerText is a plain-text summary (for notifications / search). */
export function buildRichMessagePacket(
  blocks: RichBlock[],
  innerText: string,
  t: Target,
  requestId: string,
) {
  return putMessage(2, t, { richText: fillRichBlocks(blocks, innerText) }, requestId);
}

/**
 * Rich text (POST) message: content.text holds an HTML fragment directly, which the server parses into rich text elements.
 * Verified: only <p> and <a href> survive; <b>/<i> show as "当前版本不支持" ("not supported in this version") in the client, and lists/quotes are dropped. Use buildRichMessagePacket for structured content.
 */
export function buildPostMessagePacket(html: string, t: Target, requestId: string, title = '') {
  return putMessage(2, t, { ...(title ? { title } : {}), text: html }, requestId);
}

/**
 * Image message: upload the image via uploadImage first to get the key. Verified: the key must go in content.cryptoToken,
 * from which the server generates the sizes and encrypts; putting it in content.imageKey is rejected (invalid image key).
 */
export function buildImageMessagePacket(imageKey: string, t: Target, requestId: string) {
  return putMessage(5, t, { cryptoToken: imageKey }, requestId);
}

/** File message: upload the file to the chat via uploadFile first. */
export function buildFileMessagePacket(
  file: { key: string; name: string; size: number; mime: string },
  t: Target,
  requestId: string,
) {
  return putMessage(
    3,
    t,
    { fileKey: file.key, fileName: file.name, fileSize: BigInt(file.size), fileMime: file.mime },
    requestId,
  );
}

export function buildCreateChatPacket(userId: string, requestId: string) {
  return wrapPacket(
    13,
    'PutChatRequest',
    create(protoType('PutChatRequest'), { type: 1, chatterIds: [userId] } as Fields),
    requestId,
  );
}

export function buildSearchPacket(query: string, requestId: string, locale = 'zh_CN') {
  const req = fromDict(protoType('UniversalSearchRequest'), {
    header: {
      searchSession: requestCid(),
      sessionSeqId: 1,
      query,
      searchContext: {
        tagName: 'SMART_SEARCH',
        entityItems: [
          { type: 1 },
          { type: 2, filter: {} },
          { type: 3, filter: { groupChatFilter: {} } },
          { type: 10, filter: {} },
        ],
        commonFilter: { includeOuterTenant: true },
        sourceKey: 'messenger',
      },
      locale,
      extraParam: {},
    },
  });
  return wrapPacket(11021, 'UniversalSearchRequest', req, requestId);
}

export function buildUserInfoPacket(userId: string, chatId: string, requestId: string) {
  const req = fromDict(protoType('GetUserInfoRequest'), { userId, chatId, userType: 1 });
  return wrapPacket(5023, 'GetUserInfoRequest', req, requestId);
}

export function buildGroupInfoPacket(chatId: string, requestId: string) {
  return wrapPacket(
    64,
    'GetGroupInfoRequest',
    create(protoType('GetGroupInfoRequest'), { chatId } as Fields),
    requestId,
  );
}

/** Payload of a response packet; null if there is none. */
function payloadOf(content: Uint8Array): Uint8Array | null {
  const pkt = toDict(protoType('Packet'), fromBinary(protoType('Packet'), content));
  const payload = pkt.payload as Uint8Array | undefined;
  return payload?.length ? payload : null;
}

const decode = (type: string, bytes: Uint8Array): Dict =>
  toDict(protoType(type), fromBinary(protoType(type), bytes));

/** Message id assigned by the server in the send response; empty string if unavailable. */
export function decodePutMessageResponse(content: Uint8Array): string {
  const payload = payloadOf(content) ?? new Uint8Array();
  return String((decode('PutMessageResponse', payload).message as Dict | undefined)?.id ?? '');
}

export function decodePutChatResponse(content: Uint8Array): string | null {
  const payload = payloadOf(content);
  if (!payload) return null;
  return String((decode('PutChatResponse', payload).chat as Dict | undefined)?.id ?? '');
}

export interface SearchHit {
  type: 'user' | 'group';
  id: string;
  title: string;
}

export function decodeSearchResponse(content: Uint8Array): SearchHit[] {
  const payload = payloadOf(content);
  if (!payload) return [];
  const results = (decode('UniversalSearchResponse', payload).results as Dict[] | undefined) ?? [];
  const out: SearchHit[] = [];
  for (const r of results) {
    const hit = { id: String(r.id ?? ''), title: String(r.titleHighlighted ?? '') };
    if (r.type === 1) out.push({ type: 'user', ...hit });
    else if (r.type === 3) out.push({ type: 'group', ...hit });
  }
  return out;
}

const utf8 = (b: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
};

/** User display name: prefer the translation for the current locale, then the nickname. */
export function decodeUserInfoResponse(content: Uint8Array, locale = 'zh_CN'): string | null {
  const payload = payloadOf(content);
  if (!payload) return null;
  const detail =
    ((decode('UserInfo', payload).userInfoDetail as Dict | undefined)?.detail as
      | Dict
      | undefined) ?? {};
  for (const item of (detail.locales as Dict[] | undefined) ?? []) {
    if (item.key_string === locale.toLowerCase()) return String(item.translation ?? '');
  }
  const nickname = detail.nickname as Uint8Array | undefined;
  if (nickname?.length) return utf8(nickname) ?? new TextDecoder().decode(nickname);
  return null;
}

export function decodeGroupInfoResponse(content: Uint8Array): string | null {
  const payload = payloadOf(content);
  if (!payload) return null;
  const detail =
    ((decode('UserInfo', payload).userInfoDetail as Dict | undefined)?.detail as
      | Dict
      | undefined) ?? {};
  for (const field of [detail.nickname1, detail.nickname4] as (Uint8Array | undefined)[]) {
    if (field?.length) {
      const s = utf8(field);
      if (s !== null) return s;
    }
  }
  return null;
}
