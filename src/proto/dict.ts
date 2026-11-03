import {
  type DescField,
  type DescMessage,
  fromJson,
  isFieldSet,
  type JsonValue,
  type Message,
  ScalarType,
} from '@bufbuild/protobuf';
import { PyFloat } from '../pyjson.js';

/**
 * protobuf message → plain object, with semantics matching protobuf3-to-dict as used by the original project:
 * only fields that were set (an explicit-presence field set to 0 counts as set), sorted by field number, keyed by proto field name;
 * enums as numbers, bytes as Uint8Array, int64 as bigint, float/double wrapped in PyFloat (keeps `.0` when serialized).
 */
export type Dict = Record<string, unknown>;

function fieldValue(msg: Message, field: DescField): unknown {
  const m = msg as unknown as Record<string, unknown>;
  if (field.oneof) {
    const o = m[field.oneof.localName] as { case?: string; value?: unknown };
    return o.case === field.localName ? o.value : undefined;
  }
  return m[field.localName];
}

function scalar(type: ScalarType, v: unknown): unknown {
  if (type === ScalarType.FLOAT || type === ScalarType.DOUBLE) return new PyFloat(v as number);
  return v;
}

function convert(field: DescField, v: unknown): unknown {
  switch (field.fieldKind) {
    case 'scalar':
      return scalar(field.scalar, v);
    case 'enum':
      return v;
    case 'message':
      return toDict(field.message, v as Message);
    case 'list': {
      const arr = v as unknown[];
      if (field.listKind === 'message') return arr.map((x) => toDict(field.message, x as Message));
      if (field.listKind === 'scalar') return arr.map((x) => scalar(field.scalar, x));
      return [...arr];
    }
    case 'map': {
      const out: Dict = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] =
          field.mapKind === 'message'
            ? toDict(field.message, x as Message)
            : field.mapKind === 'scalar'
              ? scalar(field.scalar, x)
              : x;
      }
      return out;
    }
  }
}

export function toDict(desc: DescMessage, msg: Message): Dict {
  const out: Dict = {};
  for (const field of [...desc.fields].sort((a, b) => a.number - b.number)) {
    if (!isFieldSet(msg, field)) continue;
    out[field.name] = convert(field, fieldValue(msg, field));
  }
  return out;
}

/** Object → protobuf message (equivalent to json_format.ParseDict(ignore_unknown_fields=True)): field names may be proto names or JSON names. */
export function fromDict(desc: DescMessage, data: Dict | null | undefined): Message {
  return fromJson(desc, (data ?? {}) as JsonValue, { ignoreUnknownFields: true });
}

/**
 * Parse JSON text while preserving large integers: integer literals beyond the safe integer range become strings (protobuf JSON parsing accepts strings for integer fields too),
 * so 19-digit chat/message ids don't lose precision in JSON.parse.
 */
export function parseJsonKeepingBigInts(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    const prev = out.trimEnd().slice(-1);
    if (m && (prev === '' || ',:['.includes(prev))) {
      const tok = m[0];
      out += /^-?\d+$/.test(tok) && !Number.isSafeInteger(Number(tok)) ? `"${tok}"` : tok;
      i += tok.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}
