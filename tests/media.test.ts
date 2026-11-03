import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { LarkAuth } from '../src/auth.js';
import { uploadFile, uploadImage } from '../src/media.js';
import { toDict } from '../src/proto/dict.js';
import { protoType } from '../src/proto/registry.js';
import { urls } from '../src/region.js';
import { newClient } from './helpers.js';

const auth = {
  region: { name: 'feishu', domain: 'example.invalid' },
  cookies: { session: 's1' },
  gatewayAppId: '1',
} as unknown as LarkAuth;

describe('image and file upload', () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { path: string; cookie: string | null; field: string; name: string; size: number }[] =
    [];
  let fileReply: unknown;
  const origHost = urls.fileHost;
  beforeEach(() => {
    seen.length = 0;
    fileReply = undefined;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData();
        const [field, value] = [...form.entries()][0] as [string, File];
        seen.push({
          path: new URL(req.url).pathname,
          cookie: req.headers.get('cookie'),
          field,
          name: value.name,
          size: value.size,
        });
        if (field === 'image') return new Response('\n1img_v3_0001_aa-bb');
        return Response.json(
          fileReply ?? {
            status: 'success',
            data: {
              key: 'file_v3_0001_cc',
              name: value.name,
              size: value.size,
              mimetype: 'text/plain',
            },
          },
        );
      },
    });
    urls.fileHost = () => `http://localhost:${server.port}`;
  });
  afterEach(() => {
    urls.fileHost = origHost;
    server.stop(true);
  });

  test('image form field is image and the key comes from the plain-text response; files upload to the chat and return the server record', async () => {
    // The CJK file name is deliberate: it checks that a non-ASCII name survives the multipart upload.
    expect(await uploadImage(auth, new Uint8Array(5), 'a.png')).toBe('img_v3_0001_aa-bb');
    expect(await uploadFile(auth, '7200000000000000001', new Uint8Array(7), '周报.txt')).toEqual({
      key: 'file_v3_0001_cc',
      name: '周报.txt',
      size: 7,
      mime: 'text/plain',
    });
    expect(seen).toEqual([
      { path: '/api/image', cookie: 'session=s1', field: 'image', name: 'a.png', size: 5 },
      {
        path: '/api/chats/7200000000000000001/files',
        cookie: 'session=s1',
        field: 'file',
        name: '周报.txt',
        size: 7,
      },
    ]);
    fileReply = { status: 'fail', message: 'file too large' };
    await expect(uploadFile(auth, 'c1', new Uint8Array(1), 'x')).rejects.toThrow(
      'file upload failed: file too large',
    );
  });

  test('sendMessage with image/file: uploads first, image key goes in cryptoToken, file carries name, size and type', async () => {
    const c = newClient();
    Object.assign(c.auth, auth);
    c.isThreadChat = async () => false;
    const sent: Record<string, unknown>[] = [];
    const reply = toBinary(
      protoType('Packet'),
      create(protoType('Packet'), {
        payload: toBinary(
          protoType('PutMessageResponse'),
          create(protoType('PutMessageResponse'), { message: { id: '7000000000000000009' } }),
        ),
      } as Record<string, unknown>),
    );
    c.gatewayPost = async (pkt) => {
      const payload = (pkt as unknown as { payload: Uint8Array }).payload;
      sent.push(
        toDict(protoType('PutMessageRequest'), fromBinary(protoType('PutMessageRequest'), payload)),
      );
      return reply;
    };
    expect(await c.sendMessage('c1', { image: new Uint8Array(3), name: 'shot.png' })).toBe(
      '7000000000000000009',
    );
    expect(
      await c.sendMessage('c1', { file: new Uint8Array(4), name: 'log.txt' }, { rootId: 'r1' }),
    ).toBe('7000000000000000009');
    expect(sent.map((r) => [r.type, r.chatId, r.content, r.rootId])).toEqual([
      [5, 'c1', { cryptoToken: 'img_v3_0001_aa-bb' }, undefined],
      [
        3,
        'c1',
        { fileKey: 'file_v3_0001_cc', fileName: 'log.txt', fileMime: 'text/plain', fileSize: 4n },
        'r1',
      ],
    ]);
  });
});
