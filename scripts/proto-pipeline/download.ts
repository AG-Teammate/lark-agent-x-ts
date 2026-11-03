import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CDN_BASE, EXTRA_BUNDLES, ensureDir, WORK_DIR } from './common.js';

/** Step 2: download all lazy-load chunks (including the base bundles) concurrently → work/chunks/; already-downloaded ones are skipped. */
const out = ensureDir(join(WORK_DIR, 'chunks'));
const chunkMap = (await Bun.file(join(WORK_DIR, 'chunk_map.json')).json()) as Record<
  string,
  string
>;
for (const [cid, hash] of Object.entries(EXTRA_BUNDLES)) chunkMap[cid] ??= hash;

type Result = [name: string, status: string, size: number];
async function fetchChunk([cid, hash]: [string, string]): Promise<Result> {
  const name = `${cid}.${hash}.js`;
  const path = join(out, name);
  if (existsSync(path) && statSync(path).size > 0) return [name, 'skip', statSync(path).size];
  try {
    const res = await fetch(`${CDN_BASE}/${name}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    await Bun.write(path, data);
    return [name, 'ok', data.length];
  } catch (err) {
    return [name, `FAIL: ${(err as Error).message}`, 0];
  }
}

const items = Object.entries(chunkMap).sort(([a], [b]) => Number(a) - Number(b));
const results: Result[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: 12 }, async () => {
    while (next < items.length) {
      const item = items[next++] as [string, string];
      results.push(await fetchChunk(item));
    }
  }),
);
const fails = results.filter(([, s]) => s.startsWith('FAIL'));
const total = results.reduce((n, [, , size]) => n + size, 0);
console.log(
  `done: ${results.length} files, ${fails.length} failures, total ${(total / 1e6).toFixed(1)} MB`,
);
for (const [name, status] of fails) console.log(' ', name, status);
