import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Shared parts of the protocol-asset regeneration pipeline (ported from the fork's dev/proto_pipeline; on the same
 * messenger inputs the output is byte-identical to the original, plus the Lark Mail stage, see mail.ts). Work dir `LARK_WORK_DIR` (inputs and intermediates, default
 * scripts/proto-pipeline/work), output dir `LARK_PROTO_OUT` (.proto files and cmd table, default scripts/proto-pipeline/out).
 */
const here = import.meta.dir;
export const WORK_DIR = resolve(process.env.LARK_WORK_DIR || join(here, 'work'));
export const OUT_DIR = resolve(process.env.LARK_PROTO_OUT || join(here, 'out'));
export const ASSETS_DIR = resolve(here, '..', '..', 'assets');
export const PROTO_SRC = resolve(here, '..', '..', 'proto', 'proto.proto');

export const CDN_BASE =
  'https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/ee/web-client-next/p/static/js';

/**
 * Base worklet bundles (file names include a hash that changes with each Feishu release): 1242 js runtime, 1181 shared
 * worklet (long connection), 9174 messenger worklet, 9373 feed worklet. See README for how to get the latest file names.
 * Override with `LARK_BASE_BUNDLES=1242.xxxx,1181.xxxx,...`.
 */
export const BASE_BUNDLES = (
  process.env.LARK_BASE_BUNDLES || '1242.60b3a8cd,1181.aa6c8a55,9174.30e252dd,9373.e0426f59'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Lark Mail web app bundle (`static/js/mail/<locale>.<hash>.chunk.js` on the mail page; the hash changes with each
 * Mail release). It carries the mail cmd table the messenger bundles lack. Override with `LARK_MAIL_BUNDLE=mail/en-US.xxxx`.
 */
export const MAIL_CDN_BASE =
  'https://sf16-scmcdn.larksuitecdn.com/obj/lark-static-sg/lark/mail/online/static/js';
export const MAIL_BUNDLE = process.env.LARK_MAIL_BUNDLE || 'mail/en-US.c5353a6f';
export const mailBundlePath = (workDir: string): string =>
  join(workDir, 'mail', `${MAIL_BUNDLE.split('/').at(-1)}.chunk.js`);

/** Bundles always downloaded (chunk id → hash): the base bundles themselves and 8929; they take part in step 3 extraction even if absent from the chunk map. */
export const EXTRA_BUNDLES: Record<string, string> = {
  ...Object.fromEntries(BASE_BUNDLES.map((b) => b.split('.') as [string, string])),
  '8929': '4a638fa1',
};

export const ensureDir = (p: string): string => {
  mkdirSync(p, { recursive: true });
  return p;
};

/** Read text as UTF-8, replacing invalid bytes with U+FFFD (like Python's errors='replace'). */
export const readText = async (path: string): Promise<string> =>
  new TextDecoder('utf-8').decode(await Bun.file(path).arrayBuffer());

/** Python's str.splitlines(): recognizes all line separators; a trailing newline does not produce an empty line. */
export function splitlines(s: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: exactly the separators Python splitlines recognizes (\x1c-\x1e are file/group/record separators)
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length && parts.at(-1) === '') parts.pop();
  return parts;
}
