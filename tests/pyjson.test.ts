import { describe, expect, test } from 'bun:test';
import { parseJsonKeepingBigInts } from '../src/proto/dict.js';
import { floatRepr, PyFloat, pyBytesRepr, pyDumps } from '../src/pyjson.js';
import { head, preview } from '../src/text.js';

// Expected values taken from Python 3 repr / json.dumps(ensure_ascii=False)
describe('Python 兼容的序列化', () => {
  test('float repr', () => {
    const cases: [number, string][] = [
      [1, '1.0'],
      [0.1, '0.1'],
      [1e16, '1e+16'],
      [1e-5, '1e-05'],
      [0.0001, '0.0001'],
      [-2.5, '-2.5'],
      [1.7976931348623157e308, '1.7976931348623157e+308'],
      [0, '0.0'],
    ];
    for (const [n, s] of cases) expect(floatRepr(n)).toBe(s);
  });

  test('json.dumps：分隔符、转义、bigint、缩进', () => {
    expect(pyDumps({ a: [1, 2, { b: null }], c: '中"\\\n\u0001' })).toBe(
      '{"a": [1, 2, {"b": null}], "c": "中\\"\\\\\\n\\u0001"}',
    );
    expect(pyDumps({ a: [1, {}], e: [] }, { indent: 2 })).toBe(
      '{\n  "a": [\n    1,\n    {}\n  ],\n  "e": []\n}',
    );
    expect(pyDumps({ id: 7300000000000000009n, f: new PyFloat(3) })).toBe(
      '{"id": 7300000000000000009, "f": 3.0}',
    );
    expect(() => pyDumps(new Uint8Array(1))).toThrow('not JSON serializable');
    expect(
      pyDumps(new Uint8Array(2), { fallback: (o) => `<${(o as Uint8Array).length} bytes>` }),
    ).toBe('"<2 bytes>"');
  });

  test('bytes repr', () => {
    const cases: [number[], string][] = [
      [[], "b''"],
      [[97, 98, 99], "b'abc'"],
      [[105, 116, 39, 115], 'b"it\'s"'],
      [[115, 97, 121, 32, 34, 104, 105, 34], 'b\'say "hi"\''],
      [[98, 111, 116, 104, 32, 39, 32, 97, 110, 100, 32, 34], "b'both \\' and \"'"],
      [[0, 1, 10, 13, 9, 92, 127, 128, 255], "b'\\x00\\x01\\n\\r\\t\\\\\\x7f\\x80\\xff'"],
      [[228, 184, 173], "b'\\xe4\\xb8\\xad'"],
    ];
    for (const [bytes, s] of cases) expect(pyBytesRepr(Uint8Array.from(bytes))).toBe(s);
  });

  test('解析 JSON 时保住超出安全整数的 id（转成字符串），其余数字与字符串不动', () => {
    expect(
      parseJsonKeepingBigInts(
        '{"chatIds": [7300000000000000001, "7300000000000000002"], "n": 12, "s": "a 7300000000000000001, b", "f": -1.5e3}',
      ),
    ).toEqual({
      chatIds: ['7300000000000000001', '7300000000000000002'],
      n: 12,
      s: 'a 7300000000000000001, b',
      f: -1500,
    });
    expect(parseJsonKeepingBigInts('[{"a":"x\\"y"},9007199254740993]')).toEqual([
      { a: 'x"y' },
      '9007199254740993',
    ]);
  });

  test('按码点截取（Python 切片），不切断代理对', () => {
    expect(head('😀ab', 2)).toBe('😀a');
    expect(preview('月报导出能加筛选', 4)).toBe('月报导出…');
    expect(preview('短', 4)).toBe('短');
  });
});
