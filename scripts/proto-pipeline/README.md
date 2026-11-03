# Protocol asset regeneration pipeline (for maintainers)

After Feishu updates its web protocol, follow this process to re-extract the full proto definitions and endpoint mapping and rebuild `assets/`. Migrated from `dev/proto_pipeline` in the LarkAgentX fork; on the same messenger inputs its outputs are byte-identical to the original (verified 2026-10-13); the Lark Mail stage described below is an addition on top. The original compiled with grpcio-tools; this uses `buf` instead (a devDependency, same semantics as protoc), so Python is no longer needed.

## Prerequisite: file names of the base worklet bundles

The file names contain a hash and change whenever Feishu ships a release. To get them: open `open-dev.feishu.cn/next/messenger` in a browser, hook the `SharedWorker` constructor in the developer tools, and record the `importScripts` URLs in the blob loader passed to it. This yields 4 base bundles: `1242.*.js` (js runtime), `1181.*.js` (shared worklet, persistent connection), `9174.*.js` (messenger worklet), `9373.*.js` (feed worklet).

```bash
export LARK_BASE_BUNDLES=1242.<hash>,1181.<hash>,9174.<hash>,9373.<hash>   # if unset, the 2026-07-25 version is used
```

### The Lark Mail bundle

The messenger bundles already carry the mail schemas but not the cmd numbers of the core mail requests (thread list, message bodies, search, and the change log that drafts, sends and label edits go through). Those come from the Lark Mail web app's main bundle, `static/js/mail/<locale>.<hash>.chunk.js`, whose hash also changes with each Mail release. To get the current name: open the mail page (`<tenant>.larksuite.com/mail`) and look for that script in the page source or the developer tools' network tab.

```bash
export LARK_MAIL_BUNDLE=mail/en-US.<hash>   # if unset, the 2026-11-03 version is used
```

Step 2 downloads it to `work/mail/`; step 3 extracts its schema registrations and its cmd table (`scripts/proto-pipeline/mail.ts`) after the messenger chunks, so messenger definitions win wherever both define the same name.

## Running

```bash
bun run proto:fetch   # 1. resolve the webpack chunk map (missing base bundles are downloaded from the CDN automatically) → work/chunk_map.json
                      # 2. download all lazy-loaded chunks concurrently (360+, ~13MB) → work/chunks/, plus the Lark Mail bundle → work/mail/
bun run proto:build   # 3. extract the schema registry and cmd mapping (messenger chunks, then the mail bundle) → work/schemas_all.json, work/cmd_map.json
                      # 4. generate .proto → out/<namespace>.proto and the fully compilable out/lark_all.proto
                      # 5. generate the endpoint reference table out/cmd_table.md and assets/cmd_map.json
                      # 6. compile with buf → assets/proto.binpb, assets/lark_all.binpb, assets/core.binpb
bun test              # the decode/build parity tests should all pass
```

Directories can be overridden with environment variables: `LARK_WORK_DIR` (inputs and intermediate files, default `work/` in this directory), `LARK_PROTO_OUT` (.proto files and the reference table, default `out/` in this directory).

## Outputs

- `assets/proto.binpb`: `proto/proto.proto` (the hand-written core protocol: gateway packets, persistent-connection frames, message content, etc.). To change protocol details, edit this .proto and rerun step 6.
- `assets/lark_all.binpb`: the full gateway definitions (~11k types), loaded only when a type outside the core subset is needed (e.g. `lark api` with an arbitrary request).
- `assets/core.binpb`: the core subset that long-running processes load exclusively; its scope is set by `CORE_REQUESTS` / `CORE_TYPES` in `build-assets.ts`. Add new gateway requests there when a new feature uses them.

If you only changed `proto/proto.proto` or the core subset scope, there's no need to rerun the earlier steps: just run `bun scripts/proto-pipeline/build-assets.ts`. Without `out/lark_all.proto`, it keeps the existing `assets/lark_all.binpb` and rebuilds only `proto.binpb` and `core.binpb`.
- `assets/cmd_map.json`: request type name → cmd number and response type; both `lark api` and the client rely on it to look up cmds.
- `out/cmd_table.md`: endpoint reference table (for reference, not committed).
