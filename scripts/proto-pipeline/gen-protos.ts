import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PyFloat } from '../../src/pyjson.js';
import { ensureDir, OUT_DIR, splitlines, WORK_DIR } from './common.js';
import { type JsObject, JsParser, type JsValue, pyStr } from './js-literal.js';

/** Step 4: schema registry → one .proto per namespace, plus a merged lark_all.proto that compiles as a whole. */

const SCALARS = new Set([
  'string',
  'bytes',
  'bool',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'float',
  'double',
]);

function sanitizeIdent(name: unknown): string {
  let s = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  if (s && /[0-9]/.test(s[0] as string)) s = `_${s}`;
  return s;
}

const obj = (v: JsValue | undefined): JsObject => (v instanceof Map ? v : new Map());

/** Integer-valued floats (e.g. 1.0) are printed as integers, matching the original. */
function intLike(v: JsValue | undefined): JsValue | undefined {
  return v instanceof PyFloat && Number.isInteger(v.value) ? v.value : v;
}

class ProtoGen {
  readonly unresolved = new Set<string>();
  readonly imports = new Set<string>();
  readonly lines: string[] = [];

  constructor(
    readonly ns: string,
    readonly allNs: Set<string>,
    readonly merged = false,
  ) {}

  resolveType(t: string, localNames: Set<string>): string {
    if (SCALARS.has(t)) return t;
    if (t.includes('.')) {
      const head = t.split('.')[0] as string;
      if (localNames.has(head)) return t;
      if (this.allNs.has(head)) {
        if (this.merged) return t; // in the merged file, resolved via the outer message scope
        this.imports.add(head);
        return `.${t}`;
      }
      this.unresolved.add(t);
      return t;
    }
    return t;
  }

  genEnum(name: string, body: JsObject, indent: number): void {
    const pad = '    '.repeat(indent);
    this.lines.push(`${pad}enum ${sanitizeIdent(name)} {`);
    const values = obj(body.get('values'));
    const hasZero = [...values.values()].some((v) => {
      const x = intLike(v);
      return x === 0 || x === false;
    });
    if (!hasZero)
      this.lines.push(
        `${pad}    ${sanitizeIdent(name).toUpperCase()}_UNSPECIFIED = 0;  // injected: proto3 requires a zero value`,
      );
    for (const [vn, vv] of values)
      this.lines.push(`${pad}    ${sanitizeIdent(vn)} = ${pyStr(intLike(vv))};`);
    this.lines.push(`${pad}}`);
  }

  genMessage(name: string, body: JsObject, indent: number): void {
    const pad = '    '.repeat(indent);
    this.lines.push(`${pad}message ${sanitizeIdent(name)} {`);
    const fields = obj(body.get('fields'));
    const nested = obj(body.get('nested'));
    const oneofs = obj(body.get('oneofs'));
    const oneofFields = new Set<string>();
    for (const odef of oneofs.values()) {
      for (const fn of (obj(odef).get('oneof') as JsValue[] | null | undefined) ?? [])
        oneofFields.add(String(fn));
    }
    const localNames = new Set(nested.keys());
    for (const [fname, fdef] of fields) {
      if (oneofFields.has(fname)) continue;
      this.genField(fname, obj(fdef), indent + 1, localNames);
    }
    for (const [oname, odef] of oneofs) {
      this.lines.push(`${pad}    oneof ${sanitizeIdent(oname)} {`);
      for (const fn of (obj(odef).get('oneof') as JsValue[] | null | undefined) ?? []) {
        const f = fields.get(String(fn));
        if (f !== undefined) this.genField(String(fn), obj(f), indent + 2, localNames, true);
      }
      this.lines.push(`${pad}    }`);
    }
    for (const [nname, nbody] of nested) {
      const b = obj(nbody);
      if (b.has('values')) this.genEnum(nname, b, indent + 1);
      else this.genMessage(nname, b, indent + 1);
    }
    this.lines.push(`${pad}}`);
  }

  genField(
    fname: string,
    fdef: JsObject,
    indent: number,
    localNames: Set<string>,
    inOneof = false,
  ): void {
    const pad = '    '.repeat(indent);
    const t = String(fdef.get('type') ?? 'bytes');
    const fid = pyStr(intLike(fdef.get('id')));
    const rule = fdef.get('rule');
    const keyType = fdef.get('keyType');
    const opts = obj(fdef.get('options'));
    const tname = this.resolveType(t, localNames);
    const label = rule === 'repeated' && !keyType ? 'repeated ' : '';
    const optParts: string[] = [];
    if (opts.get('deprecated')) optParts.push('deprecated = true');
    if (opts.get('packed') === false) optParts.push('packed = false');
    const comment =
      opts.has('default') && !inOneof ? `  // default: ${pyStr(opts.get('default'))}` : '';
    const optStr = optParts.length ? ` [${optParts.join(', ')}]` : '';
    if (keyType) {
      const kt = this.resolveType(String(keyType), localNames);
      this.lines.push(
        `${pad}map<${kt}, ${tname}> ${sanitizeIdent(fname)} = ${fid}${optStr};${comment}`,
      );
    } else {
      const prefix = inOneof ? '' : label || 'optional ';
      this.lines.push(
        `${pad}${prefix}${tname} ${sanitizeIdent(fname)} = ${fid}${optStr};${comment}`,
      );
    }
  }

  genAll(names: Map<string, JsObject>, indent: number): void {
    for (const name of [...names.keys()].sort()) {
      const body = names.get(name) as JsObject;
      if (body.has('values') && !body.has('fields')) this.genEnum(name, body, indent);
      else this.genMessage(name, body, indent);
      this.lines.push('');
    }
  }
}

const schemas = (await Bun.file(join(WORK_DIR, 'schemas_all.json')).json()) as Record<
  string,
  string
>;
const byNs = new Map<string, Map<string, JsObject>>();
const parseErrors: [string, string][] = [];
for (const [fullName, body] of Object.entries(schemas)) {
  const dot = fullName.indexOf('.');
  const ns = fullName.slice(0, dot);
  const name = fullName.slice(dot + 1);
  let parsed: JsValue;
  try {
    parsed = new JsParser(body).parseValue();
  } catch (err) {
    parseErrors.push([fullName, (err as Error).message]);
    continue;
  }
  if (!byNs.has(ns)) byNs.set(ns, new Map());
  byNs.get(ns)?.set(name, obj(parsed));
}
console.log('namespaces:', byNs.size, 'parse errors:', parseErrors.length);
for (const e of parseErrors.slice(0, 10)) console.log('  ERR', e);

const allNs = new Set(byNs.keys());
ensureDir(OUT_DIR);
const sortedNs = [...byNs.keys()].sort();
const stats: [string, number][] = [];
const allUnresolved = new Map<string, Set<string>>();
for (const ns of sortedNs) {
  const names = byNs.get(ns) as Map<string, JsObject>;
  const gen = new ProtoGen(ns, allNs);
  gen.genAll(names, 0);
  const header = ['syntax = "proto3";', '', `package ${sanitizeIdent(ns)};`, ''];
  header.push('// Auto-generated from Feishu web-client-next worklet schema registry (2026-07-25)');
  header.push('');
  const imports = [...gen.imports].filter((i) => i !== ns).sort();
  for (const imp of imports) header.push(`import "${sanitizeIdent(imp)}.proto";`);
  if (imports.length) header.push('');
  writeFileSync(join(OUT_DIR, `${sanitizeIdent(ns)}.proto`), [...header, ...gen.lines].join('\n'));
  stats.push([ns, names.size]);
  if (gen.unresolved.size) allUnresolved.set(ns, gen.unresolved);
}
console.log(`written ${stats.length} proto files to ${OUT_DIR}`);
for (const [ns, cnt] of stats) console.log(`  ${ns.padEnd(30)} ${cnt}`);
if (allUnresolved.size) {
  console.log('unresolved type refs (kept as-is):');
  for (const [ns, s] of allUnresolved) console.log(`  ${ns}: ${[...s].sort().slice(0, 10)}`);
}

// Merge into a single file (each namespace wrapped in a message, avoiding import cycles and enum value clashes); this is the version that compiles as a whole
const merged = [
  'syntax = "proto3";',
  '',
  'package lark;',
  '',
  '// Merged view of all namespaces (each namespace wrapped as a message).',
  '// Auto-generated from Feishu web-client-next worklet schema registry (2026-07-25)',
  '',
];
for (const ns of sortedNs) {
  const gen = new ProtoGen(ns, allNs, true);
  merged.push(`message ${sanitizeIdent(ns)} {`);
  gen.genAll(byNs.get(ns) as Map<string, JsObject>, 1);
  merged.push(...gen.lines, '}', '');
}
writeFileSync(join(OUT_DIR, 'lark_all.proto'), merged.join('\n'));
console.log('written merged lark_all.proto');

// Break import cycles between the per-namespace files (protoc disallows them); the merged version is unaffected
const IMPORT = /^import "(.+)\.proto";$/;
const graph = new Map<string, { path: string; lines: string[]; imps: string[] }>();
for (const ns of byNs.keys()) {
  const path = join(OUT_DIR, `${sanitizeIdent(ns)}.proto`);
  if (!existsSync(path)) continue;
  const lines = splitlines(readFileSync(path, 'utf8'));
  graph.set(ns, {
    path,
    lines,
    imps: lines
      .filter((l) => IMPORT.test(l))
      .map((l) => (IMPORT.exec(l) as RegExpExecArray)[1] as string),
  });
}

function findCycle(): string[] | null {
  const visited = new Set<string>();
  const stack: string[] = [];
  const dfs = (u: string): string[] | null => {
    visited.add(u);
    stack.push(u);
    for (const v of graph.get(u)?.imps ?? []) {
      if (!graph.has(v)) continue;
      if (stack.includes(v)) return [...stack.slice(stack.indexOf(v)), v];
      if (!visited.has(v)) {
        const r = dfs(v);
        if (r) return r;
      }
    }
    stack.pop();
    return null;
  };
  for (const u of graph.keys()) {
    if (!visited.has(u)) {
      const r = dfs(u);
      if (r) return r;
    }
  }
  return null;
}

const broken: [string, string][] = [];
for (let cyc = findCycle(); cyc; cyc = findCycle()) {
  const a = cyc.at(-2) as string;
  const b = cyc.at(-1) as string;
  let [frm, to] = a > b ? [a, b] : [b, a];
  const edges = cyc.slice(0, -1).map((x, i) => [x, cyc?.[i + 1] as string] as const);
  if (!edges.some(([x, y]) => x === frm && y === to)) [frm, to] = edges.at(-1) as [string, string];
  const g = graph.get(frm) as { path: string; lines: string[]; imps: string[] };
  const newLines = g.lines.map((l) =>
    l === `import "${to}.proto";`
      ? `// import "${to}.proto";  // removed to break an import cycle; use lark_all.proto to compile`
      : l,
  );
  writeFileSync(g.path, newLines.join('\n'));
  graph.set(frm, { path: g.path, lines: newLines, imps: g.imps.filter((i) => i !== to) });
  broken.push([frm, to]);
}
if (broken.length)
  console.log('broke import cycles:', broken.map(([x, y]) => `('${x}', '${y}')`).join(', '));

// entities <-> pan cycle: keep pan → entities and downgrade the two .pan.VisitInfo fields in entities.proto to bytes
// (field numbers unchanged), so the core namespace entities.proto compiles on its own
const entPath = join(OUT_DIR, 'entities.proto');
const panPath = join(OUT_DIR, 'pan.proto');
if (existsSync(entPath) && existsSync(panPath)) {
  const ent = readFileSync(entPath, 'utf8')
    .replaceAll('.pan.VisitInfo', 'bytes /* orig type: .pan.VisitInfo (see pan.proto) */')
    .replaceAll(
      'import "pan.proto";',
      '// import "pan.proto";  // removed to break the entities<->pan cycle',
    );
  writeFileSync(entPath, ent);
  const pan = readFileSync(panPath, 'utf8').replaceAll(
    '// import "entities.proto";  // removed to break an import cycle; use lark_all.proto to compile',
    'import "entities.proto";',
  );
  writeFileSync(panPath, pan);
  console.log('applied entities/pan cycle fixup');
}
