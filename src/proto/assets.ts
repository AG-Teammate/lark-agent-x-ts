import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type AssetName = 'proto.binpb' | 'core.binpb' | 'lark_all.binpb' | 'cmd_map.json';

// Both the source (src/proto/) and the library build output (lib/proto/) sit two levels below the repo root, so the same relative path points to the root assets/
let locate = (name: AssetName): string =>
  fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));

/** Single-file executables embed assets in the binary and call this at startup to swap in the embedded paths; not needed when running directly under Node / Bun. */
export function setAssetPaths(paths: Record<AssetName, string>): void {
  locate = (name) => paths[name];
}

export function readAsset(name: AssetName): Uint8Array {
  return readFileSync(locate(name));
}
