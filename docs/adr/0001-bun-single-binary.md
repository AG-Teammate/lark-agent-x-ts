# ADR-0001 · Use Bun as the runtime and package as a single-file executable

Date: 2026-10-13 · Status: Accepted

## Context

The fork is a Python package: users must install Python and uv/pip, and install the fork repository in editable mode; callers (such as niuma) start a Python process for every `lark send`. Alongside the migration to TypeScript, we want the distribution to become "download one file and it works".

## Decision

Use Bun as the runtime and package a single-file executable with `bun build --compile`; protocol assets (descriptor sets, endpoint mapping) are embedded with `with { type: 'file' }`. Storage uses Bun's built-in `Bun.SQL`, one interface covering both SQLite and MySQL; tests use `bun test`.

## Measurements (2026-10-13, Bun 1.3.11, macOS arm64)

| Item | Result |
|---|---|
| Artifact size | macOS arm64 64MB, macOS x64 69MB, Linux arm64 102MB, Linux x64 102MB, Windows x64 118MB (including the runtime and all protocol assets) |
| Cross-compilation | One machine produces all platforms; Linux arm64 and x64-baseline verified to run in a Debian container. The default x64 build requires AVX2 and fails with `Illegal instruction` where it's unsupported (e.g. under Rosetta translation), so x64 always uses the `baseline` target |
| Startup time | `lark config` 0.05s (Python version 0.43s) |
| Long-running listener memory | ~47–62MB (Python version ~24–37MB) |
| Protocol assets | Building the registry from the full definitions (11k types) takes 102ms and ~+110MB of memory, so long-running processes load only a trimmed core subset (41KB, 7ms, ~74MB process); the full definitions load on demand only when `lark api` needs them |
| Network latency | `lark read` ~3.3s, `auth check` ~8s, mostly network round trips to the Feishu gateway, independent of language |

## Alternatives considered

- **Node.js + SEA (Single Executable Applications)**: needs extra steps such as postject, and cross-platform artifacts must be built on each platform; `node:sqlite` is still experimental in Node 22 and prints a warning, and MySQL needs a separate driver. Bun has built-ins for everything this project uses regularly (SQL, WebSocket, fetch, spawn, bundling), so dependencies are minimal.
- **Stay on Python and package with PyInstaller**: solves installation, but callers still face a cross-language black box, and we lose the ability to share types and the library with TypeScript callers.

## Costs

- Large artifacts (64–118MB); long-running memory about 25MB higher than the Python version.
- The core library uses `Bun.SQL`, `Bun.spawn` and `Bun.file` and cannot be imported directly in Node; the protocol and client parts use only Web standard APIs (fetch, WebSocket, TextDecoder) and `node:crypto`, so reusing them in Node later only requires replacing storage and subprocess handling.
