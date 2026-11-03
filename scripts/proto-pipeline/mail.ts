/**
 * Lark Mail web app bundle: it ships its own schema registrations and its own cmd table, separate from the
 * messenger worklets. The schemas mostly duplicate the messenger ones; what the messenger bundles lack is the cmd
 * number of the core mail requests (thread list, message bodies, search, the change log that drafts, sends and
 * label edits go through). Step 3 merges both after the messenger chunks, so messenger definitions always win.
 */

/** Schema registrations look like `Object(x.a)("ns","Name",{...})`, or pass a variable defined earlier (`i={...}`). */
const INLINE = /\("([a-z_][a-zA-Z0-9_.]*)","([A-Za-z0-9_.]+)",\{/g;
const BY_VAR = /\("([a-z_][a-zA-Z0-9_.]*)","([A-Za-z0-9_.]+)",(\$?[A-Za-z_][\w$]*)\)/g;

/** The balanced {...} literal starting at src[start], skipping braces inside strings. */
function braces(src: string, start: number): string {
  let depth = 0;
  let inStr = '';
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = '';
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

const isSchema = (body: string) =>
  body.includes('fields') || body.includes('values') || body.includes('nested');

/** `ns.Name` → raw object literal, first occurrence wins. */
export function extractMailSchemas(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(INLINE)) {
    const body = braces(src, (m.index ?? 0) + m[0].length - 1);
    const key = `${m[1]}.${m[2]}`;
    if (isSchema(body) && !out.has(key)) out.set(key, body);
  }
  for (const m of src.matchAll(BY_VAR)) {
    const v = m[3] as string;
    if (v === 'void') continue;
    const at = src.lastIndexOf(`${v}={`, m.index ?? 0);
    // Only follow definitions in the same module, not a same-named minified variable far away
    if (at < 0 || (m.index ?? 0) - at > 200_000) continue;
    const body = braces(src, at + v.length + 1);
    const key = `${m[1]}.${m[2]}`;
    if (isSchema(body) && !out.has(key)) out.set(key, body);
  }
  return out;
}

/**
 * The cmd table: `(ft,pt.X,_t("NAME",ReqCodec,RespCodec))` entries in one module, where pt is a constants module
 * (`n.d(t,"X",(function(){return v}))` exports, then `const v=3601,...`) and the codecs are variables bound to
 * schema registrations in the table's module. Returns raw rows in step 3's `cmd|request|response` format; entries
 * whose codec can't be resolved to a schema name are skipped.
 */
export function extractMailCmds(src: string): string[] {
  const tableEnd = src.indexOf('function _t(e,t,n){return{cmd:e,request:t,response:n}}');
  if (tableEnd < 0) throw new Error('Mail bundle: cmd table not found (bundle layout changed?)');
  const tableMod = src.slice(src.lastIndexOf('function(e,t,n){"use strict"', tableEnd), tableEnd);
  const entries = [
    ...tableMod.matchAll(/\(\w+,(\w+)\.(\$?\w+),_t\("([A-Z0-9_]+)",(\$?[\w.]+),(\$?[\w.]+)\)\)/g),
  ];
  if (!entries.length) throw new Error('Mail bundle: cmd table is empty (bundle layout changed?)');
  // The constants module holds the gateway cmd numbers; it starts with the IM ones (46, 201)
  const constAt = src.search(/const \w+=46,\w+=201,/);
  if (constAt < 0) throw new Error('Mail bundle: cmd constants not found (bundle layout changed?)');
  const consts = new Map(
    [...src.slice(constAt, src.indexOf('}', constAt)).matchAll(/(\$?\w+)=(\d+)/g)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    ),
  );
  const exportsAt = src.lastIndexOf('function(e,t,n){"use strict"', constAt);
  const letters = new Map(
    [
      ...src
        .slice(exportsAt, constAt)
        .matchAll(/n\.d\(t,"(\$?\w+)",\(function\(\)\{return (\$?\w+)\}\)\)/g),
    ].map((m) => [m[1] as string, consts.get(m[2] as string)] as const),
  );
  const codecs = new Map<string, string>();
  for (const m of tableMod.matchAll(
    /(?:[,;(]|var |const |let )(\$?\w+)=\(?Object\(\w+\.\w+\)\("([\w.]+)","(\w+)"/g,
  ))
    if (!codecs.has(m[1] as string)) codecs.set(m[1] as string, `${m[2]}.${m[3]}`);
  const rows: string[] = [];
  for (const [, , letter, , req, resp] of entries) {
    const cmd = letters.get(letter as string);
    const reqName = codecs.get(req as string);
    const respName = codecs.get(resp as string);
    if (cmd && reqName && respName) rows.push(`${cmd}|${reqName}|${respName}`);
  }
  return rows;
}
