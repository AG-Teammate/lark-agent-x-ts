/**
 * Subcommand argument parsing, matching the original project's argparse behavior: positionals support exactly 1, optional (?), or one or more (+);
 * options support values, flags, choices, integers, required, and short aliases; `-h/--help` prints help; on error, prints usage and exits with 2.
 */
export interface Positional {
  name: string;
  nargs?: '?' | '+' | '*';
  choices?: readonly string[];
  help?: string;
}

export interface Option {
  name: string;
  short?: string;
  kind: 'string' | 'int' | 'flag';
  choices?: readonly string[];
  required?: boolean;
  default?: string | number | boolean;
  help?: string;
  metavar?: string;
}

export interface CommandSpec {
  name: string;
  help: string;
  positionals?: Positional[];
  options?: Option[];
}

export type Parsed = Record<string, string | string[] | number | boolean | undefined>;

export class UsageError extends Error {}

/** Help request: the message is the help text; it is printed and the process exits with 0. */
export class HelpRequested extends Error {}

const optKey = (o: Option) => o.name.replace(/-/g, '_');
const metavar = (o: Option) =>
  o.metavar ?? (o.choices ? `{${o.choices.join(',')}}` : optKey(o).toUpperCase());

export function usage(prog: string, spec: CommandSpec): string {
  const parts = [`usage: ${prog} ${spec.name} [-h]`];
  for (const o of spec.options ?? []) {
    const flag = o.short ?? `--${o.name}`;
    const s = o.kind === 'flag' ? flag : `${flag} ${metavar(o)}`;
    parts.push(o.required ? s : `[${s}]`);
  }
  for (const p of spec.positionals ?? []) {
    const n = p.choices ? `{${p.choices.join(',')}}` : p.name;
    parts.push(
      p.nargs === '?'
        ? `[${n}]`
        : p.nargs === '+'
          ? `${n} [${n} ...]`
          : p.nargs === '*'
            ? `[${n} ...]`
            : n,
    );
  }
  return parts.join(' ');
}

/** One help row, like argparse: names padded to the help column, or the help on its own line when the names are too long. */
const helpLine = (names: string, text = '') =>
  names.length < 20 || !text
    ? `  ${names.padEnd(20)}${text}`
    : `  ${names}\n${' '.repeat(22)}${text}`;

export function help(prog: string, spec: CommandSpec): string {
  const lines = [usage(prog, spec), ''];
  if (spec.positionals?.length) {
    lines.push('positional arguments:');
    for (const p of spec.positionals) lines.push(helpLine(p.name, p.help));
    lines.push('');
  }
  lines.push('options:');
  lines.push(`  ${'-h, --help'.padEnd(20)}show this help message and exit`);
  for (const o of spec.options ?? []) {
    const names = [o.short, `--${o.name}`].filter(Boolean).join(', ');
    const s = o.kind === 'flag' ? names : `${names} ${metavar(o)}`;
    lines.push(helpLine(s, o.help));
  }
  return lines.join('\n');
}

export function parse(prog: string, spec: CommandSpec, argv: string[]): Parsed {
  const out: Parsed = {};
  const fail = (msg: string): never => {
    throw new UsageError(`${usage(prog, spec)}\n${prog} ${spec.name}: error: ${msg}`);
  };
  const options = spec.options ?? [];
  for (const o of options) out[optKey(o)] = o.default ?? (o.kind === 'flag' ? false : undefined);
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h' || a === '--help') throw new HelpRequested(help(prog, spec));
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const [flag, inline] = a.includes('=')
        ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
        : [a, undefined];
      const o = options.find((x) => `--${x.name}` === flag || x.short === flag);
      if (!o) fail(`unrecognized arguments: ${a}`);
      const opt = o as Option;
      if (opt.kind === 'flag') {
        out[optKey(opt)] = true;
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined) fail(`argument ${flag}: expected one argument`);
      const v = value as string;
      if (opt.choices && !opt.choices.includes(v))
        fail(
          `argument ${flag}: invalid choice: '${v}' (choose from ${opt.choices.map((c) => `'${c}'`).join(', ')})`,
        );
      if (opt.kind === 'int') {
        if (!/^-?\d+$/.test(v)) fail(`argument ${flag}: invalid int value: '${v}'`);
        out[optKey(opt)] = Number.parseInt(v, 10);
      } else out[optKey(opt)] = v;
      continue;
    }
    rest.push(a);
  }
  const positionals = spec.positionals ?? [];
  const optional = (p: Positional) => p.nargs === '?' || p.nargs === '*';
  const required = positionals.filter((p) => !optional(p));
  let idx = 0;
  for (let pi = 0; pi < positionals.length; pi++) {
    const p = positionals[pi] as Positional;
    const remainingRequired = positionals.slice(pi + 1).filter((x) => !optional(x)).length;
    if (p.nargs === '*') {
      const take = Math.max(0, rest.length - idx - remainingRequired);
      out[p.name] = rest.slice(idx, idx + take);
      idx += take;
    } else if (p.nargs === '+') {
      const take = rest.length - idx - remainingRequired;
      if (take < 1) break;
      out[p.name] = rest.slice(idx, idx + take);
      idx += take;
    } else if (p.nargs === '?') {
      if (rest.length - idx > remainingRequired) out[p.name] = rest[idx++];
    } else if (idx < rest.length) out[p.name] = rest[idx++];
  }
  const missing = required.filter((p) => out[p.name] === undefined).map((p) => p.name);
  for (const o of options)
    if (o.required && out[optKey(o)] === undefined)
      missing.push(o.short ? `${o.short}/--${o.name}` : `--${o.name}`);
  if (missing.length) fail(`the following arguments are required: ${missing.join(', ')}`);
  if (idx < rest.length) fail(`unrecognized arguments: ${rest.slice(idx).join(' ')}`);
  for (const p of positionals) {
    const v = out[p.name];
    if (p.choices && typeof v === 'string' && !p.choices.includes(v))
      fail(
        `argument ${p.name}: invalid choice: '${v}' (choose from ${p.choices.map((c) => `'${c}'`).join(', ')})`,
      );
  }
  return out;
}
