import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pyDumps } from '../../src/pyjson.js';
import { BASE_BUNDLES, CDN_BASE, ensureDir, readText, WORK_DIR } from './common.js';

/** Step 1: extract webpack's lazy-load chunk map (chunk id → hash) from the base bundle → work/chunk_map.json. */
const chunkMap = new Map<number, string>();
const pattern = /\.u=\w+=>"static\/js\/"\+\w+\+"\."\+\{([^{}]+)\}\[\w+\]\+"\.js"/g;
ensureDir(WORK_DIR);
for (const name of BASE_BUNDLES) {
  const path = join(WORK_DIR, `${name}.js`);
  if (!existsSync(path)) {
    const res = await fetch(`${CDN_BASE}/${name}.js`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok)
      throw new Error(
        `下载基础包 ${name}.js 失败: HTTP ${res.status}（文件名可能已随发版变化，见 README）`,
      );
    await Bun.write(path, await res.arrayBuffer());
  }
  const src = await readText(path);
  for (const m of src.matchAll(pattern)) {
    for (const kv of (m[1] as string).matchAll(/(\d+):"([0-9a-f]+)"/g))
      chunkMap.set(Number(kv[1]), kv[2] as string);
  }
}
console.log('chunks found:', chunkMap.size);
const sorted = Object.fromEntries([...chunkMap.entries()].sort(([a], [b]) => a - b));
await Bun.write(join(WORK_DIR, 'chunk_map.json'), pyDumps(sorted, { indent: 0 }));
console.log(pyDumps(sorted));
