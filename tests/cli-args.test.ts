import { describe, expect, test } from 'bun:test';
import { type CommandSpec, HelpRequested, parse, UsageError, usage } from '../src/cli/args.js';

const send: CommandSpec = {
  name: 'send',
  help: '',
  positionals: [{ name: 'chat_id' }, { name: 'text', nargs: '+' }],
  options: [
    { name: 'root', kind: 'string' },
    { name: 'links', kind: 'flag' },
  ],
};
const download: CommandSpec = {
  name: 'download',
  help: '',
  positionals: [{ name: 'msg_id', nargs: '?' }],
  options: [
    { name: 'out', short: '-o', kind: 'string', required: true },
    { name: 'limit', kind: 'int', default: 50 },
    { name: 'region', kind: 'string', choices: ['feishu', 'lark'] },
  ],
};

describe('argument parsing (argparse-compatible)', () => {
  test('one-or-more positionals, flags, option values (including = syntax)', () => {
    expect(parse('lark', send, ['c1', 'hello', 'world', '--links', '--root=r1'])).toEqual({
      chat_id: 'c1',
      text: ['hello', 'world'],
      links: true,
      root: 'r1',
    });
    expect(parse('lark', send, ['c1', '-1'])).toMatchObject({ text: ['-1'] });
  });

  test('optional positionals, short aliases, integers, defaults', () => {
    expect(parse('lark', download, ['-o', 'x.png'])).toEqual({
      out: 'x.png',
      limit: 50,
      region: undefined,
    });
    expect(parse('lark', download, ['m1', '--out', 'x', '--limit', '3'])).toMatchObject({
      msg_id: 'm1',
      limit: 3,
    });
  });

  test('errors: missing required, invalid choice, non-integer, extra arguments, unknown option', () => {
    const err = (spec: CommandSpec, argv: string[]) => {
      try {
        parse('lark', spec, argv);
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        return (e as Error).message.split('\n').at(-1);
      }
      throw new Error('expected an error');
    };
    expect(err(send, [])).toBe(
      'lark send: error: the following arguments are required: chat_id, text',
    );
    expect(err(download, ['m1'])).toBe(
      'lark download: error: the following arguments are required: -o/--out',
    );
    expect(err(download, ['-o', 'x', '--region', 'xx'])).toBe(
      "lark download: error: argument --region: invalid choice: 'xx' (choose from 'feishu', 'lark')",
    );
    expect(err(download, ['-o', 'x', '--limit', 'a'])).toBe(
      "lark download: error: argument --limit: invalid int value: 'a'",
    );
    expect(err(download, ['-o', 'x', 'm1', 'm2'])).toBe(
      'lark download: error: unrecognized arguments: m2',
    );
    expect(err(send, ['c1', 't', '--nope'])).toBe(
      'lark send: error: unrecognized arguments: --nope',
    );
  });

  test('nargs * accepts zero or more positionals and leaves room for required ones', () => {
    const spec: CommandSpec = {
      name: 'mail',
      help: '',
      positionals: [{ name: 'action' }, { name: 'ids', nargs: '*' }, { name: 'target' }],
    };
    expect(parse('lark', spec, ['read', 'inbox'])).toEqual({
      action: 'read',
      ids: [],
      target: 'inbox',
    });
    expect(parse('lark', spec, ['read', 'a', 'b', 'inbox'])).toEqual({
      action: 'read',
      ids: ['a', 'b'],
      target: 'inbox',
    });
    const tail: CommandSpec = {
      name: 'mail',
      help: '',
      positionals: [{ name: 'action' }, { name: 'args', nargs: '*' }],
    };
    expect(parse('lark', tail, ['list'])).toEqual({ action: 'list', args: [] });
    expect(parse('lark', tail, ['list', 'x', '-1'])).toEqual({ action: 'list', args: ['x', '-1'] });
    expect(usage('lark', tail)).toBe('usage: lark mail [-h] action [args ...]');
    expect(() => parse('lark', tail, [])).toThrow('the following arguments are required: action');
  });

  test('-h prints help', () => {
    expect(() => parse('lark', send, ['-h'])).toThrow(HelpRequested);
  });
});
