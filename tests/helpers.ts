import { create, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient } from '../src/client.js';
import type { Dict } from '../src/proto/dict.js';
import { fromDict } from '../src/proto/dict.js';
import { protoType } from '../src/proto/registry.js';

/** Offline client: auth carries only user_id; tests replace api / gatewayPost for gateway calls. */
export const newClient = (): LarkClient =>
  new (LarkClient as unknown as new (auth: LarkAuth) => LarkClient)({ userId: 'me' } as LarkAuth);

/** content bytes of a text message. */
export const textContent = (text: string): Uint8Array =>
  toBinary(protoType('TextContent'), create(protoType('TextContent'), { text }));

/** Entity message dict (as found in gateway responses); defaults to a group-chat text message. */
export const entity = (id: string, over: Dict = {}): Dict => ({
  id,
  type: 4,
  fromId: '7100000000000000001',
  chatId: '7200000000000000001',
  chatType: 2,
  createTime: 1_790_000_000n,
  content: textContent(`消息${id.slice(-2)}`),
  ...over,
});

/** Long-connection push frame (cmd=6): messages is a list of entity message dicts. */
export function pushFrame(messages: Dict[], sid = 'sid-1'): Uint8Array {
  const pmr = create(protoType('PushMessagesRequest'), {
    messages: Object.fromEntries(
      messages.map((m) => [String(m.id), fromDict(protoType('entities.Message'), jsonable(m))]),
    ),
  } as Record<string, unknown>);
  const packet = create(protoType('Packet'), {
    sid,
    cmd: 6,
    payload: toBinary(protoType('PushMessagesRequest'), pmr),
  } as Record<string, unknown>);
  return toBinary(
    protoType('Frame'),
    create(protoType('Frame'), { payload: toBinary(protoType('Packet'), packet) } as Record<
      string,
      unknown
    >),
  );
}

/** dict → value accepted by protobuf JSON: bigint to string, bytes to base64. */
function jsonable(d: Dict): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(d))
    out[k] =
      typeof v === 'bigint'
        ? String(v)
        : v instanceof Uint8Array
          ? Buffer.from(v).toString('base64')
          : v;
  return out;
}
