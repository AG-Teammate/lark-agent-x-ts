import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LarkAuth } from './auth.js';
import { loadConfig } from './config.js';
import { raiseForStatus, request, USER_AGENT } from './http.js';
import { getLogger } from './log.js';
import type { Dict } from './proto/dict.js';
import { getRegion, urls, webOrigin } from './region.js';

const logger = getLogger('larkx.media');
const MAX_BYTES = 200 * 1024 * 1024;

/** Resource download URL; host is the region's file host, taken from LARKX_REGION when not given. */
export function messageResourceUrl(
  msgId: string,
  key: string,
  chatId: string,
  host?: string,
): string {
  const h = host ?? urls.fileHost(getRegion(loadConfig().region));
  return `${h}/download/messages/${msgId}/keys/${key}?chat_id=${chatId}`;
}

/** Resource key in message content: imageKey for images, key for files / videos / audio / stickers. */
export function extractResourceKey(msgType: number, contentData: Dict | null | undefined): string {
  if (!contentData) return '';
  if (msgType === 5) {
    const v2 = (contentData.imageV2 as Dict | undefined) ?? {};
    if (v2.imageKey) return String(v2.imageKey);
    const image = (contentData.image as Dict | undefined) ?? {};
    const img = (image.origin as Dict | undefined) ?? {};
    return String(img.key || image.imageKey || '');
  }
  if ([3, 15, 7, 10].includes(msgType)) return String(contentData.key ?? '');
  return '';
}

/** Download to a file (streamed; errors above 200MB); returns [path, content-type, byte count]. */
export async function download(
  auth: LarkAuth,
  url: string,
  outPath: string,
): Promise<[string, string, number]> {
  const res = raiseForStatus(await request(url, { cookies: auth.cookies, timeoutMs: 60_000 }));
  const contentType = res.headers.get('content-type') ?? '';
  const path = resolve(outPath);
  mkdirSync(dirname(path), { recursive: true });
  let n = 0;
  const body = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
  await pipeline(
    body,
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        n += chunk.length;
        if (n > MAX_BYTES) throw new Error('file too large');
        yield chunk;
      }
    },
    createWriteStream(path),
  );
  return [outPath, contentType, n];
}

export async function downloadMessageResource(
  auth: LarkAuth,
  msg: { msg_id: string; chat_id: string; msg_type: number; content_data: Dict | null },
  outPath: string,
): Promise<[string, string, number]> {
  const key = extractResourceKey(msg.msg_type, msg.content_data);
  if (!key) throw new Error('this message has no downloadable resource');
  const url = messageResourceUrl(msg.msg_id, key, msg.chat_id, urls.fileHost(auth.region));
  logger.info(`downloading resource: ${url}`);
  return download(auth, url, outPath);
}

/** A file as recorded by the server after upload: resource key, file name, byte size, and MIME type. */
export interface UploadedFile {
  key: string;
  name: string;
  size: number;
  mime: string;
}

const UPLOAD_TIMEOUT_MS = 300_000;

/** Form request the web client uses to upload resources (file host, cookie auth). */
async function postForm(
  auth: LarkAuth,
  url: string,
  field: string,
  data: Uint8Array,
  name: string,
) {
  const form = new FormData();
  form.append(field, new File([data], name));
  return raiseForStatus(
    await request(url, {
      method: 'POST',
      headers: {
        origin: webOrigin(auth.region),
        referer: `${webOrigin(auth.region)}/`,
        'user-agent': USER_AGENT,
        'x-source': 'web',
        'x-appid': auth.gatewayAppId,
      },
      cookies: auth.cookies,
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }),
  );
}

/** Upload an image and return its image key (img_v3_…); call this before sending an image message. */
export async function uploadImage(
  auth: LarkAuth,
  data: Uint8Array,
  name = 'image.png',
): Promise<string> {
  const res = await postForm(auth, `${urls.fileHost(auth.region)}/api/image`, 'image', data, name);
  // The response is plain text: a status prefix followed by the key (the web client uses text.slice(2)); here the key is extracted by its shape
  const key = /img_[\w-]+/.exec(await res.text())?.[0];
  if (!key) throw new Error('image upload failed: no image key in response');
  logger.info(`image uploaded: ${key} (${data.length} bytes)`);
  return key;
}

/** Upload a file to a chat (files belong to a chat) and return the file info recorded by the server; call this before sending a file message. */
export async function uploadFile(
  auth: LarkAuth,
  chatId: string,
  data: Uint8Array,
  name: string,
): Promise<UploadedFile> {
  const url = `${urls.fileHost(auth.region)}/api/chats/${chatId}/files`;
  const res = await postForm(auth, url, 'file', data, name);
  const body = (await res.json()) as {
    status?: string;
    message?: string;
    data?: { key?: string; name?: string; size?: number; mimetype?: string };
  };
  if (body.status !== 'success' || !body.data?.key)
    throw new Error(
      `file upload failed: ${body.message || body.status || 'no file key in response'}`,
    );
  const d = body.data;
  logger.info(`file uploaded: ${d.key} (${d.size ?? data.length} bytes)`);
  return {
    key: String(d.key),
    name: d.name || name,
    size: Number(d.size ?? data.length),
    mime: d.mimetype || 'application/octet-stream',
  };
}
