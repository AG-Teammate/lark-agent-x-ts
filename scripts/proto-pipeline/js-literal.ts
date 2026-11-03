import { floatRepr, PyFloat } from '../../src/pyjson.js';

/**
 * JS object literal parser (for the protobufjs-style descriptors in the schema registry). To stay byte-identical
 * with the original Python output: objects use a Map to keep the original key order (plain objects move numeric
 * keys first), floats are wrapped in PyFloat to tell 1 from 1.0, identifiers are recorded as { __raw__: name },
 * and `!0`/`!1` become true/false.
 */
export type JsValue = string | number | boolean | null | PyFloat | Raw | JsValue[] | JsObject;
export type JsObject = Map<string, JsValue>;
export interface Raw {
  __raw__: string;
}

export class JsParser {
  private i = 0;
  constructor(private readonly s: string) {}

  private skipWs(): void {
    while (this.i < this.s.length && ' \t\r\n'.includes(this.s[this.i] as string)) this.i += 1;
  }

  private ch(): string {
    return this.s[this.i] ?? '';
  }

  parseValue(): JsValue {
    this.skipWs();
    const c = this.ch();
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"' || c === "'") return this.parseString();
    if (c === '!') {
      const two = this.s.slice(this.i, this.i + 2);
      if (two === '!0' || two === '!1') {
        this.i += 2;
        return two === '!0';
      }
      throw new Error(`bad ! at ${this.i}`);
    }
    const rest = this.s.slice(this.i, this.i + 64);
    const num = /^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num) {
      const tok = num[0];
      this.i += tok.length;
      if (/^-?0x/.test(tok)) return Number.parseInt(tok, 16);
      return /[.eE]/.test(tok) ? new PyFloat(Number(tok)) : Number(tok);
    }
    const ident = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(this.s.slice(this.i, this.i + 256));
    if (ident) {
      const tok = ident[0];
      this.i += tok.length;
      if (tok === 'true') return true;
      if (tok === 'false') return false;
      if (tok === 'undefined' || tok === 'null' || tok === 'void') return null;
      return { __raw__: tok };
    }
    throw new Error(`unexpected '${this.s.slice(this.i, this.i + 20)}' at ${this.i}`);
  }

  private parseString(): string {
    const q = this.ch();
    this.i += 1;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      if (c === '\\') {
        const nxt = this.s[this.i + 1] as string;
        if (nxt === 'n') out += '\n';
        else if (nxt === 't') out += '\t';
        else if (nxt === 'r') out += '\r';
        else if (nxt === 'u') {
          out += String.fromCharCode(Number.parseInt(this.s.slice(this.i + 2, this.i + 6), 16));
          this.i += 4;
        } else if (nxt === 'x') {
          out += String.fromCharCode(Number.parseInt(this.s.slice(this.i + 2, this.i + 4), 16));
          this.i += 2;
        } else out += nxt;
        this.i += 2;
        continue;
      }
      if (c === q) {
        this.i += 1;
        return out;
      }
      out += c;
      this.i += 1;
    }
    throw new Error('unterminated string');
  }

  private parseKey(): string {
    this.skipWs();
    const c = this.ch();
    if (c === '"' || c === "'") return this.parseString();
    const m = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+)/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) throw new Error(`bad key at ${this.i}: '${this.s.slice(this.i, this.i + 20)}'`);
    this.i += m[0].length;
    return m[0];
  }

  private parseObject(): JsObject {
    const obj: JsObject = new Map();
    this.i += 1;
    for (;;) {
      this.skipWs();
      if (this.ch() === '}') {
        this.i += 1;
        return obj;
      }
      const key = this.parseKey();
      this.skipWs();
      if (this.ch() !== ':') throw new Error(`expected : at ${this.i}`);
      this.i += 1;
      obj.set(key, this.parseValue());
      this.skipWs();
      if (this.ch() === ',') this.i += 1;
    }
  }

  private parseArray(): JsValue[] {
    const arr: JsValue[] = [];
    this.i += 1;
    for (;;) {
      this.skipWs();
      if (this.ch() === ']') {
        this.i += 1;
        return arr;
      }
      arr.push(this.parseValue());
      this.skipWs();
      if (this.ch() === ',') this.i += 1;
    }
  }
}

/** Python's repr (used to write values such as default verbatim into comments). */
export function pyRepr(v: JsValue | undefined): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (v instanceof PyFloat) return floatRepr(v.value);
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let s = '';
    for (const ch of v) {
      const code = ch.codePointAt(0) as number;
      if (ch === '\\') s += '\\\\';
      else if (ch === q) s += `\\${q}`;
      else if (ch === '\n') s += '\\n';
      else if (ch === '\r') s += '\\r';
      else if (ch === '\t') s += '\\t';
      else if (code < 0x20 || code === 0x7f) s += `\\x${code.toString(16).padStart(2, '0')}`;
      else s += ch;
    }
    return `${q}${s}${q}`;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (v instanceof Map)
    return `{${[...v].map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
  return `{'__raw__': ${pyRepr(v.__raw__)}}`;
}

/** Python's str(): strings as-is, everything else like repr. */
export const pyStr = (v: JsValue | undefined): string => (typeof v === 'string' ? v : pyRepr(v));
