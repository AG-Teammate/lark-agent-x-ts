import { HttpError } from '../http.js';
import { PyFloat, pyBytesRepr, pyDumps } from '../pyjson.js';

/** Equivalent to the original project's `_print_json`: indent 2, non-ASCII (e.g. Chinese) left unescaped; unserializable values printed like Python `str()` (bytes as b'...'). */
export function printJson(obj: unknown): void {
  process.stdout.write(
    `${pyDumps(obj, {
      indent: 2,
      fallback: (o) =>
        o instanceof Uint8Array ? pyBytesRepr(o) : o instanceof PyFloat ? o.value : String(o),
    })}\n`,
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Timestamp in seconds → local time `MM-DD HH:MM`; empty value gives an empty string. */
export function shortTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(Number(ts) * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Timestamp in ms → local time `YYYY-MM-DD HH:MM:SS`, the same shape as DateTime strings from the DB; 0 gives `None`. */
export function localDatetime(ms: number): string {
  if (!ms) return 'None';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** DateTime strings from the DB are printed like Python `str(datetime)`: no fractional part when microseconds are 0. */
export const pyDatetime = (s: string | null | undefined): string =>
  s ? String(s).replace(/\.0{6}$/, '') : 'None';

/** Error text: when the gateway gives a failure reason, append it (in parentheses) to help tell whether it is an argument, permission, or chat-type problem. */
export function errorText(e: unknown): string {
  const msg = (e as Error).message;
  return e instanceof HttpError && e.reason ? `${msg} (${e.reason})` : msg;
}
