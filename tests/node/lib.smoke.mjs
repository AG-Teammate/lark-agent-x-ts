// Node smoke test for the library build (lib/): `bun run test:node` (builds lib/ first, then runs node --test).
// The file is not named *.test.* so bun test does not pick it up into the main suite.
// The main suite runs on bun test; this only confirms that protocol assets, protobuf encode/decode, credentials
// read/write and the long-connection handshake timeout also work on the Node runtime.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as lib from '../../lib/index.js';
import { decodeMessageContent, decodePushMessages } from '../../lib/proto/decoders.js';
import { resolveCmd } from '../../lib/proto/registry.js';

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/parity.json', import.meta.url), 'utf8'),
);
const unb64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));

test('library entry exports load under Node', () => {
  for (const name of [
    'LarkAuth',
    'LarkClient',
    'QrLogin',
    'AuthExpired',
    'setLogSink',
    'getRegion',
  ])
    assert.ok(name in lib, name);
});

test('protocol assets: cmd map and core types', () => {
  const r = resolveCmd('messages.PutReadMessagesRequest');
  assert.equal(typeof r.cmd, 'number');
  assert.equal(r.req?.typeName, 'lark.messages.PutReadMessagesRequest');
});

test('message content decoding matches the parity fixtures', () => {
  for (const c of fixtures.contents) {
    const [summary] = decodeMessageContent(c.type, unb64(c.bytes));
    if (c.name === 'system message')
      assert.deepEqual(summary.split(' ').sort(), c.summary.split(' ').sort());
    else assert.equal(summary, c.summary, c.name);
  }
});

test('push frame parsing matches the parity fixtures', () => {
  const strip = (xs) =>
    xs.map(({ content_data: _, ...m }) => m).sort((a, b) => a.msg_id.localeCompare(b.msg_id));
  assert.deepEqual(
    strip(decodePushMessages(unb64(fixtures.push.frame))),
    strip(fixtures.push.messages),
  );
});

test('credentials read/write at the given path, creating missing directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkx-node-'));
  try {
    const path = join(dir, 'sub', 'credentials.json');
    const a = new lib.LarkAuth(path);
    a.cookies = { session: 's' };
    a.userId = '7000000000000000001';
    a.savedAt = 1791800000.5;
    a.save();
    const b = new lib.LarkAuth(path);
    assert.equal(b.userId, a.userId);
    assert.deepEqual(b.cookies, a.cookies);
    assert.equal(b.savedAt, a.savedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs can be routed to a host sink', () => {
  const got = [];
  const dir = mkdtempSync(join(tmpdir(), 'larkx-node-'));
  const prev = lib.setLogSink((level, module, msg) => got.push([level, module, msg]));
  try {
    new lib.LarkAuth(join(dir, 'credentials.json')).save();
  } finally {
    lib.setLogSink(prev);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(
    got.map(([level, module]) => [level, module]),
    [['INFO', 'larkx.auth']],
  );
  assert.match(got[0]?.[2] ?? '', /^credentials saved to /);
});

test("persistent connection fails on handshake timeout (Node's WebSocket may not fire close here)", async () => {
  const sockets = [];
  const server = createServer((s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = new lib.LarkClient({ userId: 'me' });
    c.wsTiming = { openTimeoutMs: 200, heartbeatMs: 50, idleTimeoutMs: 120 };
    c.buildWsUrl = async () => `ws://127.0.0.1:${server.address().port}`;
    await assert.rejects(
      c.connectWebsocket(async () => undefined),
      /WS handshake timed out \(200ms\)/,
    );
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

test('permission checks work under Node: only the outermost call is checked; denial throws PermissionDenied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkx-node-perm-'));
  const original = lib.LarkClient.prototype.api;
  lib.LarkClient.prototype.api = async () => ({});
  try {
    const auth = {
      userId: '7000000000000000001',
      appKey: 'app',
      path: join(dir, 'credentials.json'),
      requireValid: async () => {},
    };
    const c = await lib.LarkClient.create(auth, { permissions: { allow: [], deny: ['api'] } });
    assert.deepEqual(await c.scheduledMessages('c1'), []);
    await assert.rejects(
      c.api('x'),
      (e) => e instanceof lib.PermissionDenied && e.permission === 'api',
    );
  } finally {
    lib.LarkClient.prototype.api = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
