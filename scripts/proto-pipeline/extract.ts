import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pyDumps } from '../../src/pyjson.js';
import { readText, WORK_DIR } from './common.js';

/** Step 3: extract the schema registry and cmd map from all chunks → work/schemas_all.json, work/cmd_map.json. */
const REG = /register\("([a-zA-Z0-9_.]+)","([a-zA-Z0-9_.]+)",\{/g;
const CMD = /"(-?\d+(?:\|[A-Za-z0-9_.]*)+)"/g;

/** Raw object-literal source of each register(ns, name, {...}) (matched by bracket pairing, skipping brackets inside strings). */
function extractRegs(src: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const m of src.matchAll(REG)) {
    let i = (m.index ?? 0) + m[0].length - 1;
    const start = i;
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let esc = false;
    while (i < src.length) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === strCh) inStr = false;
      } else if (c === '"' || c === "'") {
        inStr = true;
        strCh = c;
      } else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    out.push([m[1] as string, m[2] as string, src.slice(start, i + 1)]);
  }
  return out;
}

const chunks = join(WORK_DIR, 'chunks');
const files = readdirSync(chunks)
  .filter((f) => f.endsWith('.js'))
  .sort();
const allRegs = new Map<string, { ns: string; name: string; body: string }>();
const cmdMap = new Map<string, string>();
for (const file of files) {
  const src = await readText(join(chunks, file));
  for (const [ns, name, body] of extractRegs(src)) {
    const key = `${ns}\u0000${name}`;
    if (!allRegs.has(key)) allRegs.set(key, { ns, name, body });
  }
  for (const m of src.matchAll(CMD))
    if (!cmdMap.has(m[1] as string)) cmdMap.set(m[1] as string, file);
}
console.log('files:', files.length);
console.log('schemas:', allRegs.size);
console.log('cmd mappings:', cmdMap.size);

// Same as Python's sorted((ns, name)): by namespace first, then by name
const sorted = [...allRegs.values()].sort((a, b) =>
  a.ns === b.ns ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.ns < b.ns ? -1 : 1,
);
await Bun.write(
  join(WORK_DIR, 'schemas_all.json'),
  pyDumps(Object.fromEntries(sorted.map((r) => [`${r.ns}.${r.name}`, r.body])), { indent: 1 }),
);
await Bun.write(join(WORK_DIR, 'cmd_map.json'), pyDumps(Object.fromEntries(cmdMap), { indent: 1 }));

const nsCount = new Map<string, number>();
for (const r of allRegs.values()) nsCount.set(r.ns, (nsCount.get(r.ns) ?? 0) + 1);
console.log(
  'namespaces:',
  Object.fromEntries([...nsCount].sort((a, b) => b[1] - a[1]).slice(0, 40)),
);
