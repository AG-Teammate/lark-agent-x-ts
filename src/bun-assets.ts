/// <reference path="./assets.d.ts" />
// Single-file executable: protocol assets are embedded in the binary via `with { type: 'file' }`; importing this module swaps the library's asset paths for the embedded ones.
// This repo's CLI entry imports it; when embedding this library in your own Bun single-file executable, add `import 'lark-agent-x-ts/bun-assets'` at the entry point.
// The library entry does not go through here, so Node never sees the Bun-only import attributes.
import cmdMap from '../assets/cmd_map.json' with { type: 'file' };
import core from '../assets/core.binpb' with { type: 'file' };
import larkAll from '../assets/lark_all.binpb' with { type: 'file' };
import proto from '../assets/proto.binpb' with { type: 'file' };
import { setAssetPaths } from './proto/assets.js';

setAssetPaths({
  'proto.binpb': proto,
  'core.binpb': core,
  'lark_all.binpb': larkAll,
  // TS infers this import's type as JSON; with `type: 'file'` it is actually a path
  'cmd_map.json': cmdMap as unknown as string,
});
