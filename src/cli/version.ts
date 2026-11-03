import pkg from '../../package.json';

declare const BUILD_COMMIT: string | undefined;

/** Injected at build time via `--define BUILD_COMMIT=...`; when running from source, read from git on the fly, or unknown if unavailable. */
function commit(): string {
  if (typeof BUILD_COMMIT === 'string' && BUILD_COMMIT) return BUILD_COMMIT;
  const r = Bun.spawnSync(['git', '-C', import.meta.dir, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return r.exitCode === 0 ? r.stdout.toString().trim() : 'unknown';
}

/** Output of `lark --version`: callers (e.g. niuma doctor) check the version via `commit=`. */
export const versionLine = (): string => `${pkg.name} ${pkg.version} commit=${commit()}`;
