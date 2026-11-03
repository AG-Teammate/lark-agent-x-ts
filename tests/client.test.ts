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

describe('gateway client', () => {
  test('mark read: main chat advances by position, topic replies by topic; topic requests use the root position as maxPosition', async () => {
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
    await expect(c.readMessages('c1', ['m1', 'nope'])).rejects.toThrow('message not found: nope');
    await expect(c.readMessages('c1', ['x1'])).rejects.toThrow('message x1 is not in chat c1');
  });

  test('recentChats: pages newest to oldest, keeps only cards changed after since, stops at older ones', async () => {
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

  test('listChats: pages the inbox, keeps only chat cards up to limit, names direct chats after the other member', async () => {
    const c = newClient();
    const card = (id: string, type: number, ms: number) => ({ id, type, updateTimeMs: BigInt(ms) });
    const pages: Dict[] = [
      {
        cards: [card('g1', 1, 50), card('t1', 4, 40), card('p1', 1, 30)],
        chats: {
          g1: {
            id: 'g1',
            type: 2,
            chatMode: 1,
            name: 'Project team',
            newMessageCount: 2,
            memberCount: 5,
          },
          p1: { id: 'p1', type: 1, memberCount: 2 },
        },
        nextCursor: 30n,
      },
      { cards: [card('self', 1, 20), card('x1', 1, 10)], nextCursor: 10n },
      { cards: [card('late', 1, 5)], nextCursor: 0n },
    ];
    const reqs: Dict[] = [];
    c.api = async (type, data) => {
      expect(type).toBe('feed.PullFeedCardsRequest');
      reqs.push(data as Dict);
      return pages[reqs.length - 1] ?? {};
    };
    // Cards whose chat info is missing from the page are fetched one by one; unknown chats are skipped
    c.getChatInfo = async (id) => (id === 'self' ? { id, type: 1, memberCount: 1 } : null);
    c.chatMembers = async (id) =>
      id === 'p1'
        ? [
            { id: 'me', name: 'Myself', type: 'user' },
            { id: 'u1', name: 'Colleague A', type: 'user' },
          ]
        : [{ id: 'me', name: 'Myself', type: 'user' }];
    const got = await c.listChats(3);
    expect(got.map((x) => [x.chatId, x.name, x.chatType, x.unread, x.updatedAt])).toEqual([
      ['g1', 'Project team', 2, 2, 50],
      ['p1', 'Colleague A', 1, 0, 30],
      ['self', 'Myself', 1, 0, 20],
    ]);
    // The limit is reached on the second page, so the third is never requested
    expect(reqs.map((r) => [r.pullType, r.cursor])).toEqual([
      [1, undefined],
      [2, 30n],
    ]);
    reqs.length = 0;
    expect((await c.listChats(1, { peerNames: false }))[0]?.chatId).toBe('g1');
  });

  test('send failure (network, or no message id in the response) returns null without throwing', async () => {
    const c = newClient();
    c.sendRetryDelayMs = 0;
    c.isThreadChat = async () => false;
    c.gatewayPost = async () => {
      throw new NetworkError('Network request failed (x): Read timed out');
    };
    expect(await c.sendMsg('Got it', 'c1')).toBeNull();
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    expect(await c.sendMsg('Got it', 'c1')).toBeNull();
    const ok = Buffer.from(fixtures.responses.put_message.bytes, 'base64');
    c.gatewayPost = async () => Uint8Array.from(ok);
    expect(await c.sendMsg('Got it', 'c1', { rootId: 'r1' })).toBe('7000000000000000009');
  });

  test('sendMessage throws on failure: network errors propagate as-is, a missing message id throws SendUnconfirmed', async () => {
    const c = newClient();
    c.sendRetryDelayMs = 0;
    c.isThreadChat = async () => false;
    c.gatewayPost = async () => {
      throw new NetworkError('Network request failed (x): Read timed out');
    };
    await expect(c.sendMessage('c1', { text: 'Got it' })).rejects.toBeInstanceOf(NetworkError);
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    await expect(
      c.sendMessage('c1', { blocks: [{ type: 'p', runs: [{ text: 'Got it' }] }], text: 'Got it' }),
    ).rejects.toBeInstanceOf(SendUnconfirmed);
    const ok = Buffer.from(fixtures.responses.put_message.bytes, 'base64');
    c.gatewayPost = async () => Uint8Array.from(ok);
    expect(await c.sendMessage('c1', { html: '<p>Got it</p>', title: '' })).toBe(
      '7000000000000000009',
    );
  });

  test('idempotent send: retries reuse the same message cid; 4xx is not retried; SendUnconfirmed carries the cid', async () => {
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
      if (failures-- > 0) throw new NetworkError('Network request failed (x): Read timed out');
      return ok;
    };
    expect(await c.sendMessage('c1', { text: 'Got it' }, { cid: 'fixedcid01' })).toBe(
      '7000000000000000009',
    );
    expect(cids).toEqual(['fixedcid01', 'fixedcid01', 'fixedcid01']);
    // cid is random by default and stays the same across retries
    cids.length = 0;
    failures = 1;
    await c.sendMessage('c1', { text: 'Got it' });
    expect(cids).toHaveLength(2);
    expect(cids[0]).toBe(cids[1] as string);
    // 4xx means the request itself is wrong; no retry
    cids.length = 0;
    c.gatewayPost = async (pkt) => {
      cids.push(sentCid(pkt));
      throw new HttpError(400, 'Bad Request', 'u');
    };
    await expect(c.sendMessage('c1', { text: 'Got it' })).rejects.toBeInstanceOf(HttpError);
    expect(cids).toHaveLength(1);
    // Retries exhausted without a message id: SendUnconfirmed carries the cid so it can be resent later
    c.gatewayPost = async () => toBinary(protoType('Packet'), create(protoType('Packet')));
    const e = (await c
      .sendMessage('c1', { text: 'Got it' }, { cid: 'fixedcid02', retries: 1 })
      .catch((x) => x)) as SendUnconfirmed;
    expect(e).toBeInstanceOf(SendUnconfirmed);
    expect(e.cid).toBe('fixedcid02');
  });

  test('persistent connection: frames with sid get an ACK, pushed messages reach the callback in order, thread-group roots form their own topic; abnormal server close throws', async () => {
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
      ).rejects.toThrow('WS connection closed: code=4001 bye');
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

describe('persistent connection keepalive', () => {
  const fast = { openTimeoutMs: 200, heartbeatMs: 50, idleTimeoutMs: 120 };

  test('fails on handshake timeout instead of hanging while connecting', async () => {
    // Accept TCP connections only, never answer the handshake
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const c = newClient();
      c.wsTiming = fast;
      c.buildWsUrl = async () => `ws://127.0.0.1:${server.port}`;
      await expect(c.connectWebsocket(async () => undefined)).rejects.toThrow(
        'WS handshake timed out (200ms)',
      );
      // Abort mid-handshake: returns immediately
      const abort = new AbortController();
      const pending = c.connectWebsocket(async () => undefined, abort.signal);
      setTimeout(() => abort.abort(), 20);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test('heartbeat with no frames back counts as disconnected; any frame keeps the connection', async () => {
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
        'WS heartbeat lost: no frames received in 120ms',
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
  test('cookie jar follows redirects, keeps Set-Cookie from the way and sends it on later requests; expired ones are deleted', async () => {
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

  test('on gateway errors HttpError carries the reason from the response Packet; message text unchanged', async () => {
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

  test('non-2xx error format matches requests; connection failures raise a network error', async () => {
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
      /^Network request failed \(127\.0\.0\.1:9\): /,
    );
  });
});
