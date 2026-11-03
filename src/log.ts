/** Writes to stderr by default, with a line format matching the original project's loguru: `2026-10-13 01:23:26.491 | INFO     | module - message`. */
export type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

/** Log destination: when embedded as a library in another program, use setLogSink to route logs to the host's own logging system. */
export type LogSink = (level: Level, module: string, msg: string) => void;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const stderrSink: LogSink = (level, module, msg) => {
  process.stderr.write(`${stamp()} | ${level.padEnd(8)} | ${module} - ${msg}\n`);
};

let threshold: Level = 'INFO';
let sink: LogSink = stderrSink;

export function setLogLevel(level: Level): void {
  threshold = level;
}

/** Replace the log destination and return the previous one; level filtering is still controlled by setLogLevel, so set the level to DEBUG if the host does its own filtering. */
export function setLogSink(next: LogSink): LogSink {
  const prev = sink;
  sink = next;
  return prev;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
}

export function getLogger(module: string): Logger {
  const write = (level: Level, msg: string) => {
    if (ORDER[level] < ORDER[threshold]) return;
    sink(level, module, msg);
  };
  return {
    debug: (m) => write('DEBUG', m),
    info: (m) => write('INFO', m),
    warning: (m) => write('WARNING', m),
    error: (m) => write('ERROR', m),
  };
}
