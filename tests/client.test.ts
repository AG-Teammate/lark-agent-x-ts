import { describe, expect, test } from 'bun:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { LarkClient, SendUnconfirmed } from '../src/client.js';
import { CookieJar, HttpError, NetworkError, raiseForStatus, request } from '../src/http.js';
import { type Dict, toDict } from '../src/proto/dict.js';
import { protoType } from '../src/proto/registry.js';
import fixtures from './fixtures/parity.json';

const newClient = (): LarkClient =>
  new (LarkClient as unknown as new (auth: LarkAuth) => LarkClient)({ userId: 'me' } as LarkAuth);

describe('网关客户端', () => {
  test('标已读：主会话按 position、话题回复按话题推进，话题请求用根消息 position 作 maxPosition', async () => {
    const c = newClient();
    const calls: [string, Dict][] = [];
    const messages: Record<string, Dict> = {
      m1: { chatId: 'c1', position: 40 },
      m2: { chatId: 'c1', position: 41 },
      r1: { chatId: 'c1', position: 12, threadId: 'r1', threadPosition: -1 },
      t1: { chatId: 'c1', position: -3, threadId: 'r1', threadPosition: 0 },
      t2: { chatId: 'c1', position: -3, threadId: 'r1', threadPosition: 2 },
      q1: { chatId: 'c1', position: 42, threadId: 'r1' },
      x1: { chatId: 'c2', position: 1 },
    };
    c.api = async (type, data) => {
      calls.push([String(type), data as Dict]);
      if (type === 'messages.PullMessagesByIdsRequest') {
        const ids = (data as { messageIds: string[] }).messageIds;
        return {
          messages: Object.fromEntries(ids.filter((i) => messages[i]).map((i) => [i, messages[i]])),
        };
      }
      return {};
    };
    expect(await c.readMessages('c1', ['m1', 'm2', 't1', 't2', 'q1'])).toBe(5);
    expect(
      calls.filter(([t]) => t === 'messages.PutReadMessagesRequest').map(([, d]) => d),
    ).toEqual([
      { chatId: 'c1', maxPosition: 42, messageIds: ['m1', 'm2', 'q1'] },
      {
        chatId: 'c1',
        maxPosition: 12,
        threadId: 'r1',
        threadMaxPosition: 2,
        messageIds: ['t1', 't2'],
      },
    ]);
    await expect(c.readMessages('c1', ['m1', 'nope'])).rejects.toThrow('找不到消息: nope');
    await expect(c.readMessages('c1', ['x1'])).rejects.toThrow('消息 x1 不在会话 c1 里');
  });

  test('recentChats：从新到旧翻页，只取 since 之后变动的会话卡片，翻到更旧的就停', async () => {
    const c = newClient();
    const sec = 1_791_900_000;
    const card = (id: string, type: number, t: number) => ({
      id,
      type,
      updateTimeMs: BigInt(t * 1000),
      rankTime: BigInt(t),
    });
    const pages: Dict[] = [
      {
        cards: [card('c1', 1, sec + 50), card('t1', 4, sec + 40), card('c2', 1, sec + 30)],
        chats: { c1: { id: 'c1', lastMessagePosition: 9 } },
        nextCursor: BigInt(sec + 30),
      },
      { cards: [card('c3', 1, sec + 10), card('c4', 1, sec - 10)], nextCursor: BigInt(sec - 10) },
      { cards: [card('c5', 1, sec - 20)], nextCursor: 0n },
    ];
    const reqs: Dict[] = [];
    c.api = async (type, data) => {
      expect(type).toBe('feed.PullFeedCardsRequest');
      reqs.push(data as Dict);
      return pages[reqs.length - 1] ?? {};
    };
    const got = await c.recentChats(sec * 1000);
    expect(got).toEqual([
      { chatId: 'c1', updatedAt: (sec + 50) * 1000, chat: { id: 'c1', lastMessagePosition: 9 } },
      { chatId: 'c2', updatedAt: (sec + 30) * 1000, chat: null },
      { chatId: 'c3', updatedAt: (sec + 10) * 1000, chat: null },
    ]);
    expect(reqs.map((r) => [r.pullType, r.cursor])).toEqual([
      [1, undefined],
      [2, BigInt(sec + 30)],
    ]);
  });

  test('发送失败（网络或响应里没有消息 id）返回 null，不抛错', async () => {
    const c = newClient();
    c.sendRetryDelayMs = 0;
    c.isThreadChat = async () => false;
    c.gatewayPost = async () => {
      throw new NetworkError('网络请求失败(x): Read timed out');
    };
    expect(await c.sendMsg('收到', 'c1')).toBeNull();
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    expect(await c.sendMsg('收到', 'c1')).toBeNull();
    const ok = Buffer.from(fixtures.responses.put_message.bytes, 'base64');
    c.gatewayPost = async () => Uint8Array.from(ok);
    expect(await c.sendMsg('收到', 'c1', { rootId: 'r1' })).toBe('7000000000000000009');
  });

  test('sendMessage 失败时抛错：网络错误原样抛出，拿不到消息 id 抛 SendUnconfirmed', async () => {
    const c = newClient();
    c.sendRetryDelayMs = 0;
    c.isThreadChat = async () => false;
    c.gatewayPost = async () => {
      throw new NetworkError('网络请求失败(x): Read timed out');
    };
    await expect(c.sendMessage('c1', { text: '收到' })).rejects.toBeInstanceOf(NetworkError);
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    await expect(
      c.sendMessage('c1', { blocks: [{ type: 'p', runs: [{ text: '收到' }] }], text: '收到' }),
    ).rejects.toBeInstanceOf(SendUnconfirmed);
    const ok = Buffer.from(fixtures.responses.put_message.bytes, 'base64');
    c.gatewayPost = async () => Uint8Array.from(ok);
    expect(await c.sendMessage('c1', { html: '<p>收到</p>', title: '' })).toBe(
      '7000000000000000009',
    );
  });

  test('发送幂等：失败时用同一个消息 cid 重试；4xx 不重试；SendUnconfirmed 带回 cid', async () => {
    const c = newClient();
    c.sendRetryDelayMs = 0;
    c.isThreadChat = async () => false;
    const ok = Uint8Array.from(Buffer.from(fixtures.responses.put_message.bytes, 'base64'));
    const cids: string[] = [];
    const sentCid = (pkt: unknown) => {
      const p = (pkt as { payload: Uint8Array }).payload;
      return String(
        toDict(protoType('PutMessageRequest'), fromBinary(protoType('PutMessageRequest'), p)).cid,
      );
    };
    let failures = 2;
    c.gatewayPost = async (pkt) => {
      cids.push(sentCid(pkt));
      if (failures-- > 0) throw new NetworkError('网络请求失败(x): Read timed out');
      return ok;
    };
    expect(await c.sendMessage('c1', { text: '收到' }, { cid: 'fixedcid01' })).toBe(
      '7000000000000000009',
    );
    expect(cids).toEqual(['fixedcid01', 'fixedcid01', 'fixedcid01']);
    // cid is random by default and stays the same across retries
    cids.length = 0;
    failures = 1;
    await c.sendMessage('c1', { text: '收到' });
    expect(cids).toHaveLength(2);
    expect(cids[0]).toBe(cids[1] as string);
    // 4xx means the request itself is wrong; no retry
    cids.length = 0;
    c.gatewayPost = async (pkt) => {
      cids.push(sentCid(pkt));
      throw new HttpError(400, 'Bad Request', 'u');
    };
    await expect(c.sendMessage('c1', { text: '收到' })).rejects.toBeInstanceOf(HttpError);
    expect(cids).toHaveLength(1);
    // Retries exhausted without a message id: SendUnconfirmed carries the cid so it can be resent later
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    const e = (await c
      .sendMessage('c1', { text: '收到' }, { cid: 'fixedcid02', retries: 1 })
      .catch((x) => x)) as SendUnconfirmed;
    expect(e).toBeInstanceOf(SendUnconfirmed);
    expect(e.cid).toBe('fixedcid02');
  });

  test('长连接：带 sid 的帧回 ACK，推送消息按顺序交给回调，话题群根消息归到自己的话题；服务端异常关闭时抛错', async () => {
    const acks: Dict[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(Buffer.from(fixtures.push.frame, 'base64'));
          setTimeout(() => ws.close(4001, 'bye'), 100);
        },
        message(_ws, data) {
          const frame = fromBinary(protoType('Frame'), data as Uint8Array) as unknown as {
            payload: Uint8Array;
          };
          const pkt = fromBinary(protoType('Packet'), frame.payload) as unknown as Dict;
          acks.push({ cmd: pkt.cmd, sid: pkt.sid });
        },
      },
    });
    try {
      const c = newClient();
      c.buildWsUrl = async () => `ws://localhost:${server.port}`;
      c.isThreadChat = async () => true;
      const got: { id: string; scope: string; anchor: string }[] = [];
      await expect(
        c.connectWebsocket(
          async (m) => void got.push({ id: m.msg_id, scope: m.scope, anchor: m.anchor }),
        ),
      ).rejects.toThrow('WS 连接关闭: code=4001 bye');
      expect(acks).toEqual([{ cmd: 1, sid: 'sid-1' }]);
      expect(got.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: '7000000000000000001', scope: 'topic', anchor: '7000000000000000001' },
        { id: '7000000000000000002', scope: 'topic', anchor: '7000000000000000001' },
      ]);
    } finally {
      server.stop(true);
    }
  });
});

describe('长连接保活', () => {
  const fast = { openTimeoutMs: 200, heartbeatMs: 50, idleTimeoutMs: 120 };

  test('握手无响应时按超时失败，不会一直卡在连接中', async () => {
    // Accept TCP connections only, never answer the handshake
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const c = newClient();
      c.wsTiming = fast;
      c.buildWsUrl = async () => `ws://127.0.0.1:${server.port}`;
      await expect(c.connectWebsocket(async () => undefined)).rejects.toThrow('WS 握手超时(200ms)');
      // Abort mid-handshake: returns immediately
      const abort = new AbortController();
      const pending = c.connectWebsocket(async () => undefined, abort.signal);
      setTimeout(() => abort.abort(), 20);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test('心跳收不到任何回帧时判定断线；有回帧则保持连接', async () => {
    let heartbeats = 0;
    let reply = false;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        message(ws, data) {
          const frame = fromBinary(protoType('Frame'), data as Uint8Array) as unknown as {
            payload: Uint8Array;
          };
          const pkt = fromBinary(protoType('Packet'), frame.payload) as unknown as Dict;
          if (pkt.cmd !== 4) return;
          heartbeats++;
          // Simulate a server reply frame (cmd=200, no sid)
          if (reply) ws.send(data as Uint8Array);
        },
      },
    });
    try {
      const c = newClient();
      c.wsTiming = fast;
      c.buildWsUrl = async () => `ws://localhost:${server.port}`;
      await expect(c.connectWebsocket(async () => undefined)).rejects.toThrow(
        'WS 心跳无回应: 120ms 内没有收到任何帧',
      );
      expect(heartbeats).toBeGreaterThanOrEqual(2);

      reply = true;
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 400);
      let opened = 0;
      await expect(
        c.connectWebsocket(
          async () => undefined,
          abort.signal,
          () => opened++,
        ),
      ).resolves.toBeUndefined();
      expect(opened).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe('HTTP', () => {
  test('cookie 罐跟随重定向、收下途中的 Set-Cookie 并带到后续请求；过期的删除', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${url.pathname} ${req.headers.get('cookie') ?? ''}`);
        if (url.pathname === '/a')
          return new Response(null, {
            status: 302,
            headers: [
              ['location', '/b'],
              ['set-cookie', 'tenant=t1; Path=/; HttpOnly'],
              ['set-cookie', 'old=; Max-Age=0'],
            ],
          });
        return new Response('appKey: "k1"');
      },
    });
    try {
      const jar = new CookieJar({ session: 's', old: 'o' });
      const res = await jar.fetch(`http://localhost:${server.port}/a`);
      expect(await res.text()).toBe('appKey: "k1"');
      expect(seen).toEqual(['/a session=s; old=o', '/b session=s; tenant=t1']);
      expect(jar.cookies).toEqual({ session: 's', tenant: 't1' });
    } finally {
      server.stop(true);
    }
  });

  test('网关出错时 HttpError 带上响应 Packet 里的出错原因，报错文案不变', async () => {
    const body = toBinary(
      protoType('Packet'),
      create(protoType('Packet'), { sid: 'chat not in thread mode' }),
    );
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status: 400 }) });
    try {
      const c = newClient();
      Object.assign(c.auth, { region: { gateway: '' }, cookies: {}, gatewayAppId: '1' });
      const { urls } = await import('../src/region.js');
      const orig = urls.gateway;
      urls.gateway = () => `http://localhost:${server.port}/gw`;
      try {
        const e = (await c
          .api('messages.PullMessagesByIdsRequest', {})
          .catch((x) => x)) as HttpError;
        expect(e).toBeInstanceOf(HttpError);
        expect(e.reason).toBe('chat not in thread mode');
        expect(e.message).toBe(
          `400 Client Error: Bad Request for url: http://localhost:${server.port}/gw`,
        );
      } finally {
        urls.gateway = orig;
      }
    } finally {
      server.stop(true);
    }
  });

  test('非 2xx 的报错格式同 requests；连不上时报网络错误', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('x', { status: 400 }) });
    try {
      const res = await request(`http://localhost:${server.port}/gw`);
      expect(() => raiseForStatus(res)).toThrow(
        new HttpError(400, 'Bad Request', `http://localhost:${server.port}/gw`).message,
      );
    } finally {
      server.stop(true);
    }
    await expect(request('http://127.0.0.1:9/x', { timeoutMs: 2000 })).rejects.toThrow(
      /^网络请求失败/,
    );
  });
});
