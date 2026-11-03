/**
 * Terminal editor for `lark permissions edit`: a grouped tree where each item toggles between inherit / allow / deny, with each row showing live whether it can ultimately run.
 * State and rendering (PermissionEditor) are separate from terminal key reading (editInTerminal); the former does not depend on a terminal and can be tested directly.
 * Built on node:readline keypress events: common prompt libraries only offer two-state checkboxes, not a three-state tree.
 */
import { emitKeypressEvents } from 'node:readline';
import {
  decide,
  GROUPS,
  type Group,
  match,
  PERMISSIONS,
  type Permission,
  type Rules,
  type Verdict,
} from '../permissions.js';

export type State = 'inherit' | 'allow' | 'deny';

const LABEL: Record<State, string> = { inherit: 'inherit', allow: 'allow', deny: 'deny' };
const NEXT: Record<State, State> = { inherit: 'allow', allow: 'deny', deny: 'inherit' };
const HELP =
  '↑↓ move  ←→ collapse/expand  space toggle  a allow  d deny  i inherit  s save  q quit';

/** Fields used from readline keypress events. */
export interface Key {
  name?: string | undefined;
  ctrl?: boolean | undefined;
}

interface Row {
  key: string;
  group?: Group;
  /** Permission items under a group; group rows and the `*` row have none. */
  item?: Permission;
}

const paint = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
// Fixed column widths so the state and result columns line up whatever the label lengths.
const STATE_WIDTH = Math.max(...Object.values(LABEL).map((l) => l.length));
const VERDICT_WIDTH = Math.max(LABEL.allow.length, LABEL.deny.length);
const verdictText = (v: Verdict) =>
  v.allowed
    ? paint('32', LABEL.allow.padEnd(VERDICT_WIDTH))
    : paint('31', LABEL.deny.padEnd(VERDICT_WIDTH));
const stateText = (st: State) =>
  st === 'allow'
    ? paint('32', LABEL.allow.padEnd(STATE_WIDTH))
    : st === 'deny'
      ? paint('31', LABEL.deny.padEnd(STATE_WIDTH))
      : paint('2', LABEL.inherit.padEnd(STATE_WIDTH));

/** Terminal display width: CJK characters and full-width symbols take two columns. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function clip(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (width(`${out}${ch}…`) > max) break;
    out += ch;
  }
  return max > 0 ? `${out}…` : '';
}

export class PermissionEditor {
  cursor = 0;
  /** Modified and not yet saved. */
  dirty = false;
  /** Quit was pressed with unsaved changes; awaiting confirmation. */
  confirming = false;
  private offset = 0;
  private readonly allow: string[];
  private readonly deny: string[];
  private readonly items = Object.keys(PERMISSIONS) as Permission[];
  private readonly expanded = new Set<Group>();

  constructor(
    rules: Rules,
    private readonly title: string,
    private readonly note = '',
  ) {
    this.allow = [...rules.allow];
    this.deny = [...rules.deny];
  }

  rows(): Row[] {
    const out: Row[] = [{ key: '*' }];
    for (const group of Object.keys(GROUPS) as Group[]) {
      out.push({ key: group, group });
      if (this.expanded.has(group))
        for (const item of this.items.filter((p) => PERMISSIONS[p] === group))
          out.push({ key: item, group, item });
    }
    return out;
  }

  rules(): Rules {
    return { allow: [...this.allow], deny: [...this.deny] };
  }

  stateOf(key: string): State {
    return this.deny.includes(key) ? 'deny' : this.allow.includes(key) ? 'allow' : 'inherit';
  }

  set(key: string, st: State): void {
    if (this.stateOf(key) === st) return;
    for (const list of [this.allow, this.deny]) {
      const i = list.indexOf(key);
      if (i >= 0) list.splice(i, 1);
    }
    if (st !== 'inherit') (st === 'allow' ? this.allow : this.deny).push(key);
    this.dirty = true;
  }

  /** Rules not in the tree (e.g. command-level `scheduled`, whose actions belong to different groups) are preserved as-is on save. */
  extras(): string[] {
    const shown = new Set(['*', ...Object.keys(GROUPS), ...this.items]);
    return [
      ...this.deny.filter((k) => !shown.has(k)).map((k) => `deny ${k}`),
      ...this.allow.filter((k) => !shown.has(k)).map((k) => `allow ${k}`),
    ];
  }

  verdict(row: Row): Verdict {
    const rules = this.rules();
    if (row.item) return decide(rules, row.item);
    return match(rules, row.group ? [row.group, '*'] : ['*']);
  }

  /** Handle one keypress; editing ends when it returns save / quit. */
  handle(key: Key): 'save' | 'quit' | undefined {
    if (key.ctrl && key.name === 'c') return 'quit';
    if (this.confirming) {
      this.confirming = false;
      if (key.name === 's') return 'save';
      if (key.name === 'q' || key.name === 'y') return 'quit';
      return undefined;
    }
    const rows = this.rows();
    const row = rows[this.cursor] as Row;
    const isGroupRow = row.group !== undefined && !row.item;
    switch (key.name) {
      case 'up':
      case 'k':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'down':
      case 'j':
        this.cursor = Math.min(rows.length - 1, this.cursor + 1);
        break;
      case 'right':
      case 'l':
        if (isGroupRow) this.expanded.add(row.group as Group);
        break;
      case 'left':
      case 'h':
        if (row.group) {
          this.expanded.delete(row.group);
          this.cursor = this.rows().findIndex((r) => r.key === row.group && !r.item);
        }
        break;
      case 'return':
        if (isGroupRow) {
          const g = row.group as Group;
          if (this.expanded.has(g)) this.expanded.delete(g);
          else this.expanded.add(g);
        } else this.set(row.key, NEXT[this.stateOf(row.key)]);
        break;
      case 'space':
        this.set(row.key, NEXT[this.stateOf(row.key)]);
        break;
      case 'a':
        this.set(row.key, 'allow');
        break;
      case 'd':
        this.set(row.key, 'deny');
        break;
      case 'i':
        this.set(row.key, 'inherit');
        break;
      case 's':
        return 'save';
      case 'q':
      case 'escape':
        if (!this.dirty) return 'quit';
        this.confirming = true;
        break;
    }
    return undefined;
  }

  /** Full-screen content (one row per item, with colors); at most `height` lines, scrolling with the cursor when the list doesn't fit. */
  render(columns: number, height: number): string[] {
    const head = [paint('1', this.title)];
    if (this.note) head.push(paint('2', this.note));
    const extras = this.extras();
    if (extras.length)
      head.push(paint('2', `rules not in the tree (kept as-is on save): ${extras.join(', ')}`));
    head.push(paint('2', HELP), '');
    const foot = [
      '',
      this.confirming
        ? paint('33', 'unsaved changes: s save and quit · q discard · any other key to go back')
        : this.dirty
          ? paint('33', 'modified, not saved')
          : '',
    ];

    const rows = this.rows();
    const nameWidth =
      Math.max(
        ...this.items.map((p) => p.length + 4),
        ...Object.keys(GROUPS).map((g) => g.length + 2),
      ) + 2;
    const room = Math.max(1, height - head.length - foot.length);
    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + room) this.offset = this.cursor - room + 1;
    this.offset = Math.min(this.offset, Math.max(0, rows.length - room));

    const body = rows.slice(this.offset, this.offset + room).map((row, i) => {
      const at = this.offset + i === this.cursor;
      const isGroupRow = row.group !== undefined && !row.item;
      const marker = isGroupRow
        ? this.expanded.has(row.group as Group)
          ? '▾ '
          : '▸ '
        : row.item
          ? '    '
          : '  ';
      const name = `${marker}${row.key}`.padEnd(nameWidth);
      const st = this.stateOf(row.key);
      const v = this.verdict(row);
      const note = isGroupRow
        ? GROUPS[row.group as Group]
        : row.item
          ? st === 'inherit'
            ? v.rule
              ? `decided by ${v.rule}`
              : 'no rule, allowed by default'
            : ''
          : 'all commands';
      // Leading columns: cursor 2 + name + state + arrow 4 + result + gap 2
      const rest = columns - 1 - (2 + nameWidth + STATE_WIDTH + 4 + VERDICT_WIDTH + 2);
      const pointer = at ? paint('36', '› ') : '  ';
      return `${pointer}${at ? paint('1', name) : name}${stateText(st)}  → ${verdictText(v)}  ${paint('2', clip(note, rest))}`;
    });
    return [...head, ...body, ...foot];
  }
}

/** Run the editor in the terminal (alternate screen, raw key mode); returns the new rules on save, null on discard. */
export async function editInTerminal(editor: PermissionEditor): Promise<Rules | null> {
  const { stdin, stdout } = process;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write('\x1b[?1049h\x1b[?25l');
  // In raw mode \n does not return to column 0, so newlines must be written as \r\n
  const draw = () =>
    stdout.write(
      `\x1b[H\x1b[2J${editor.render(stdout.columns || 80, stdout.rows || 24).join('\r\n')}`,
    );
  try {
    draw();
    return await new Promise<Rules | null>((resolve) => {
      const onKey = (_: string, key: Key | undefined) => {
        const done = editor.handle(key ?? {});
        if (!done) {
          draw();
          return;
        }
        stdin.off('keypress', onKey);
        stdout.off('resize', draw);
        resolve(done === 'save' ? editor.rules() : null);
      };
      stdin.on('keypress', onKey);
      stdout.on('resize', draw);
    });
  } finally {
    stdout.write('\x1b[?25h\x1b[?1049l');
    stdin.setRawMode(false);
    stdin.pause();
  }
}
