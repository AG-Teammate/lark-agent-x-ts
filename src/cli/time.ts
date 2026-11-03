/**
 * Command-line time argument → millisecond timestamp:
 * a relative duration (`30m`, `2h`, `3d`, `1w`: when future is false, that long ago; when true, that long from now),
 * a date or date-time (`2026-10-01`, `2026-10-01 09:30`, local time), or a seconds or milliseconds timestamp (10 / 13 digits). Throws if unrecognized.
 */
export function parseTimeArg(s: string, now = Date.now(), future = false): number {
  const v = s.trim();
  const rel = /^(\d+)\s*([smhdw])$/i.exec(v);
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[
      (rel[2] as string).toLowerCase() as 's' | 'm' | 'h' | 'd' | 'w'
    ];
    return now + (future ? 1 : -1) * Number(rel[1]) * unit * 1000;
  }
  if (/^\d{10}$/.test(v)) return Number(v) * 1000;
  if (/^\d{13}$/.test(v)) return Number(v);
  const dt = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (dt) {
    const [, y, mo, d, h = '0', mi = '0', se = '0'] = dt;
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(se),
    ).getTime();
  }
  throw new Error(`无法识别的时间: ${s}(可用 30m/2h/3d/1w、2026-10-01、2026-10-01 09:30 或时间戳)`);
}
