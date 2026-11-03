# lark-agent-x-ts

A TypeScript implementation of a Feishu / Lark web-client messaging channel: log in with a personal account by scanning a QR code, receive all messages over a persistent connection and store them, send messages as yourself, mark messages read, generate message links, read and send Lark Mail, call any gateway endpoint, and optionally hook up a local Claude Code as a "digital twin" that auto-replies on your behalf. Bun packages it as a **single-file executable**; the library entry point can be embedded in a Node process.

## Install and build

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun run build                 # → dist/lark (single-file executable for the current platform, ~64MB)
bun run build:all             # → dist/lark-bun-<platform>: macOS arm64/x64, Linux arm64/x64, Windows x64
bun src/cli/main.ts <command> # or run directly from source
```

x64 targets use Bun's `baseline` build (no AVX2 required, so it runs on older CPUs and under translation layers). For why Bun was chosen, see [docs/adr/0001-bun-single-binary.md](docs/adr/0001-bun-single-binary.md).

Put `dist/lark` on your PATH. `lark --version` prints the version and build commit.

## Commands

| Command | Description |
|-------|------|
| `lark auth qr` | Log in by scanning a QR code (recommended; `--region lark` for Lark (international), `--region lark-jp` for the Lark Japan data center) |
| `lark auth import` | Log in by pasting a cookie |
| `lark auth check` / `status` | Check whether credentials have expired / show a credentials overview |
| `lark send <chat_id> <text>` | Send a message (`--root` replies into a thread, `--reply <msg_id>` sends a quoted reply, `--links` sends `[text](url)` as hyperlinks, `--md [--title]` sends Markdown (rendered as Markdown by the client), `--post [--title]` sends HTML rich text, `--rich <json\|@file>` sends structured rich text; `--cid` sets an idempotency key, so resending with the same cid won't send a duplicate) |
| `lark send-image <chat_id> <path>` / `lark send-file <chat_id> <path>` | Send an image / file (local files are uploaded automatically; also supports `--root` and `--reply`) |
| `lark schedule <chat_id> <text> --at <time>` / `lark scheduled <chat_id>` | Schedule a message (`--at 10m`, `--at "2026-10-15 09:30"`, `--md`; only one pending message per chat at a time) / list pending scheduled messages (`--cancel`, or `--reschedule` together with `--at`) |
| `lark translate <text>` | Translate text (`--to en`, default zh); with `--msg` the arguments are message ids and those messages are translated |
| `lark forward <msg_id> <chat_id...>` | Forward a message to one or more chats |
| `lark group create <name>` / `add` / `remove` / `rename` | Create a group (`--members`, `--desc`, `--topic` creates a topic group), add members, remove members, rename a group or change its description |
| `lark pin <chat_id> <msg_id>` / `lark pins <chat_id>` | Pin a message (`--remove` unpins) / list pinned messages in a chat |
| `lark shortcut [chat_id,...]` | Pin chats to the top of the chat list (`--remove` unpins; with no arguments, lists pinned chats) |
| `lark tags [tag]` | Chat tags (groups): list tags, or list the chats under a tag |
| `lark flag <msg_id...>` / `lark flags` | Flag messages (`--chat` flags chats, `--remove` unflags) / list my flags |
| `lark recall <msg_id...>` / `lark edit <msg_id> <text>` | Recall messages / edit a text or rich-text message you sent (`--links`, `--rich`) |
| `lark react <msg_id> <emoji>` / `lark reactions <msg_id...>` | Add an emoji reaction (e.g. `THUMBSUP`, `DONE`; `--remove` removes it) / show reactions on messages |
| `lark read-status <chat_id> <msg_id...>` | Read status of messages: read/unread counts and the unread list (sender's view, `--names`); `--me` shows whether I've read them |
| `lark read <chat_id> <msg_id...>` | Mark messages read (same as viewing them in the client; thread replies are marked per thread) |
| `lark message-link <chat_id> <msg_id...>` | Generate an official message link (one message links to that message; several produce a combined link) |
| `lark self-chat` | Print the chat_id of your chat with yourself |
| `lark listen` | Long-running: receive messages over the persistent connection and store them; after reconnecting, automatically backfills messages missed while disconnected (including thread replies); updates the local store when the other side recalls or edits a message; logs reaction changes |
| `lark listen --agent` (or `bun run agent`) | Long-running: receive messages and auto-reply through a local coding agent |
| `lark messages <chat_id>` | Read locally stored messages (`--anchor` shows only a thread; an empty string shows only the main chat) |
| `lark history <chat_id>` | Fetch message history (`--save` stores it; `--since` / `--until` fetch the latest `--count` messages in a time range, e.g. `--since 2h`, `--since 2026-10-01`) |
| `lark get <msg_id...>` | Fetch messages by id (works across chats; `--save` stores them, `--json`) |
| `lark thread <root_id>` | Fetch a thread: the root message plus recent replies (`--count`, `--save`, `--json`) |
| `lark download <msg_id> -o <path>` | Download the image/file in a message (fetched from the server if the message isn't stored locally) |
| `lark mail <action>` | Lark Mail for the logged-in account; see [Mail](#mail) |
| `lark api <type_name> '<json>'` | Call any gateway endpoint (type names are in `assets/cmd_map.json`) |
| `lark chats` / `lark sessions` | Chat list from the local store (`--remote` pulls the server-side list: direct and group chats in your inbox, most recent first, `--limit`, `--json`) / agent session table |
| `lark search <keyword>` | Search users/groups |
| `lark search-messages <keyword>` | Search messages across chats (`--chat`, `--from`, `--since`/`--until`: `3d`, `2026-10-01` or a timestamp, `--limit`, `--json`) |
| `lark unread` | Chats with unread messages; `--chat <id>` shows a chat's unread messages, `--at` shows only unread messages that @mention me in each chat (`--since`, `--names`, `--json`) |
| `lark members <chat_id>` / `lark users <user_id...>` | Chat members (id, name, user/bot) / look up user names in bulk; with `--names`, `history`, `get` and `thread` show senders by name |
| `lark config` | Show the effective configuration |
| `lark permissions` | Show which permission group each command belongs to and whether it can run now (`--json`); `edit` edits the current account's rules interactively in the terminal, `clear` clears them; see [Command permissions](#command-permissions) |

## Mail

`lark mail <action> [args]` reads and sends Lark Mail as you, over the same gateway as messages (no Open Platform app needed). Thread ids come from `list` and `search`, message ids from `thread` and `get`. Labels can be given by id or name (`inbox`, `sent`, `draft`, `archived`, `trash`, `spam`, `flagged`, or a user label or folder name as `labels` shows it). Unlike the chat commands, mail output is in English.

| Action | Description |
|-------|------|
| `labels` / `addresses` | Labels and folders with unread counts / the account's sending addresses (default first) |
| `list [label]` | Threads under a label, newest first (default `inbox`; `--limit`; `--before <time>` lists older threads, so pass the last thread's `updatedAt` from `--json` to page exactly; `--unread` keeps only the unread threads among those listed; `--json`) |
| `thread <thread_id>` / `get <message_id...>` | A whole conversation / messages by id, with bodies and attachments (`--html` prints the HTML body, `--json`) |
| `search <keyword>` | Server-side search (`--from`, `--to`, `--subject`, `--label`, `--since` / `--until`, `--attachments`, `--limit`, `--json`) |
| `download <message_id>` | Save a message's attachments (`-o <dir>`, default the current directory) |
| `send <body>` | Send a new email: `--to`, `--cc`, `--bcc` (comma-separated), `--subject`, `--attach <paths>`, `--from <address>`; `--html` treats the body as HTML, `--body-file` reads it from a file, `--draft` only saves a draft |
| `reply <message_id> <body>` | Reply in the thread, quoting the original (`--all` replies to everyone, `--no-quote`, `--attach`, `--draft`) |
| `forward <message_id> <body>` | Forward with the original's attachments (`--to` required, `--cc`, `--bcc`, `--attach`, `--draft`) |
| `send-draft <draft_id>` / `delete-draft <draft_id...>` | Send a saved draft / delete drafts |
| `read <thread_id...>` | Mark threads read (`--unread` marks them unread) |
| `flag <thread_id...>` / `label <label> <thread_id...>` | Flag threads / add a label (`--remove` undoes either) |
| `archive <thread_id...>` / `trash <thread_id...>` | Archive (`--undo` moves back to the inbox) / move to the trash (`--restore` restores) |

```bash
lark mail list --limit 10
lark mail send --to someone@example.com --subject "Weekly report" "Hi,\nthe report is attached." --attach report.pdf
lark mail reply <message_id> "Thanks, looks good." --all
lark mail search invoice --since 30d --attachments
```

Each action is its own permission item (`mail.list`, `mail.send`, ...); saving a draft (`--draft`) only needs `mail.draft`. See [Command permissions](#command-permissions).

## Configuration

Everything has a default; override with environment variables or a `.env` in the current directory (loaded automatically by Bun at startup):

```bash
LARKX_REGION=feishu          # feishu (Feishu, China) | lark (Lark international) | lark-jp (Lark Japan data center); only affects the first login when there are no credentials yet
LARKX_HOME=~/.larkx          # data directory: credentials.json, messages.db, permissions.json, login_qr.png
LARKX_STORAGE_URL=           # empty = SQLite (LARKX_HOME/messages.db); for MySQL use mysql+pymysql://<user>:<password>@<host>:3306/<db>
LARKX_CONTEXT_SCOPE=anchor   # agent context boundary: anchor (chat + thread) | chat (chat) | global (shared by everything)
LARKX_AGENT_BACKEND=claude   # claude | none
LARKX_SYSTEM_PROMPT=         # digital twin system prompt; empty uses the built-in default
LARKX_MARK_READ=true         # automatically mark received messages read; when false, the caller runs `lark read` as needed
LARKX_AGENT_REACTIONS=false  # pass reactions others add/remove on my messages to the digital twin (e.g. treat a thumbs-up as approval to proceed)
LARKX_DENY=                  # commands and groups to deny; LARKX_ALLOW lists allowed ones; see Command permissions below
LARKX_TRIGGER_PREFIX=        # only pass messages starting with this prefix to the agent; also LARKX_TRIGGER_CHAT_TYPES / _INCLUDE_CHATS / _EXCLUDE_CHATS / _INCLUDE_SENDERS / _INCLUDE_TAGS (chat tag name or id) / _KEYWORDS / _GROUP_AT_ONLY
```

Credentials don't go in `.env`; manage them with `lark auth qr` / `lark auth import`.

### Command permissions

Each command can be allowed or denied individually or by group, to limit what the digital twin can do (the agent started by `listen --agent` also calls `lark`, so it shares the same rules as you). With no configuration, everything is allowed. The same rules can also be enabled when used as a library; see [Using as a library](#using-as-a-library).

| Group | Contains |
|---|---|
| `local` | Read-only local data: `auth status`, `config`, `chats` (local list), `sessions`, `messages`, `permissions` (viewing) |
| `query` | Read-only Feishu data: `auth check`, `chats --remote`, `history`, `get`, `thread`, `search`, `search-messages`, `unread`, `members`, `users`, `reactions`, `read-status`, `pins`, `flags`, `tags`, `translate`, `message-link`, `self-chat`, `download`, plus listing with `scheduled` and `shortcut`, and reading with `mail` (`labels`, `addresses`, `list`, `thread`, `get`, `search`, `download`) |
| `outbound` | Sends new messages: `send`, `send-image`, `send-file`, `schedule`, `forward`, plus cancelling and rescheduling with `scheduled`, and `mail` `send` / `reply` / `forward` / `send-draft` |
| `modify` | Changes existing messages or state others can see: `recall`, `edit`, `react`, `pin`, `read` |
| `organize` | Personal organization that only affects you: `flag`, plus pinning and unpinning with `shortcut`, and `mail` `draft` (saving with `--draft`) / `delete-draft` / `read` / `flag` / `label` / `archive` / `trash` |
| `manage` | Group management: `group` `create` / `add` / `remove` / `rename` |
| `system` | Account- and process-level: `auth` `qr` / `import`, `listen`, `api`, `permissions` `edit` / `clear` |

Commands that mix reads and writes are split by action, named `command.action` (e.g. `group.add`, `scheduled.cancel`, `auth.qr`); `lark permissions` lists all names and their groups.

Rules are two name lists, allow and deny (comma-separated or a JSON array). A name can be `*`, a group, a command, or `command.action`. Resolution goes from most specific to broadest (`command.action` → command → group → `*`); the first level with a matching rule wins, and deny takes precedence within the same level. If nothing matches, the command is allowed.

```bash
# Read-only, plus sending text messages; deny everything else
LARKX_DENY='*'
LARKX_ALLOW=local,query,send

# Deny only group management and recall
LARKX_DENY=manage,recall

# Deny group management but allow renaming groups (the more specific rule wins)
LARKX_DENY=manage
LARKX_ALLOW=group.rename
```

- **Per account**: `lark permissions edit` opens a group tree in the terminal to set rules for the currently logged-in account: arrow keys move, left/right collapse and expand, and each item toggles between inherit / allow / deny (space cycles, or `a` / `d` / `i`). Each row shows live whether the command can run and which rule decides it; `s` saves, `q` quits (asking for confirmation if there are unsaved changes). Rules are stored next to the credentials (i.e. in the data directory) in `permissions.json` (keyed by user_id), and while that account is logged in they fully replace the global rules above; if the account has no rules of its own yet, editing starts from a copy of the global rules. `lark permissions clear` removes them, falling back to the global rules. To change rules from a script, write the environment variables or `permissions.json` directly.
- **When denied**: exit code 126, and stderr says which rule denied it; `-h` is never restricted. If the rules contain an unknown name or `permissions.json` is corrupt, every command fails (exit code 1) rather than being let through.
- If the rules deny `system`, `lark permissions edit` / `clear` are denied too; to undo, edit `permissions.json` or the environment variables directly.
- This is a guardrail against mistakes, not a security boundary: the agent runs with `--dangerously-skip-permissions`, so anything that can change the environment variables or the data directory can bypass it.

## Using as a library

The library entry point works under both Node (≥ 22.19) and Bun, and exports login credentials, the gateway client, the persistent message connection, resource downloads, and Lark Mail. The message store (`Bun.SQL`) and local agent (`Bun.spawn`) depend on Bun and are only used by the CLI. When installed as a git dependency, Node loads `lib/` compiled by `prepare`, while Bun loads `src/` directly (TypeScript projects can set `customConditions: ["bun"]` in tsconfig to type-check against the source directly, without depending on `lib/`). When bundling this library into your own Bun single-file executable, `import 'lark-agent-x-ts/bun-assets'` at your entry point so the protocol assets get embedded.

```ts
import { LarkAuth, LarkClient, PermissionDenied, setLogSink } from 'lark-agent-x-ts';

setLogSink((level, module, msg) => myLogger.log(level, `${module} - ${msg}`)); // optional: route to the host's logger; defaults to stderr
const client = await LarkClient.create(new LarkAuth('/path/to/credentials.json')); // defaults to ~/.larkx/credentials.json; validates online
await client.sendMsg('Hello', '<chat_id>');
await client.sendMessage('<chat_id>', { markdown: '## Conclusion\n- Ship on Friday' }); // Markdown rich text
await client.sendMessage('<chat_id>', { image: readFileSync('shot.png'), name: 'shot.png' }); // images/files are uploaded automatically; file: bytes + name sends a file
await client.api('chats.PullChatsByIdsRequest', { chatIds: ['<chat_id>'] });
await client.connectWebsocket(async (msg) => console.log(msg.chat_id, msg.from_id, msg.content), undefined, undefined, async (ev) => console.log(ev.message_id, ev.reaction_type)); // the 4th argument receives reaction changes
const groupId = await client.createGroup('Project team', ['<user_id>']); // also addMembers, removeMembers, updateGroup
await client.scheduleMessage('<chat_id>', { text: 'Weekly meeting reminder' }, Date.now() + 3_600_000); // scheduled send; scheduledMessages / rescheduleMessage / cancelScheduledMessage
const [zh] = await client.translateText(['Ship on Friday'], 'zh'); // translateMessages(ids, 'zh') translates messages
await client.forwardMessage('<msg_id>', ['<chat_id>']); // forward; returns chat → new message id
await client.readStates('<chat_id>', ['<msg_id>']); // who has and hasn't read it; myReadStates shows whether I've read it
await client.addReaction('<msg_id>', 'DONE'); // also editMessage, recallMessage, removeReaction, reactions
const names = await client.userNames(['<user_id>']); // id → name (batched, cached); chatMembers(chatId) lists group members
const today = await client.historyRange('<chat_id>', { since: Date.now() - 3_600_000 }); // fetch chat history in a time range
const mentions = await client.unreadMentions(); // unread @mentions of me; unreadChats() / unreadMessages(chatId)
const inbox = await client.listChats(200); // server-side chat list: direct and group chats, newest first, direct chats named after the other member
const hits = await client.searchMessages('monthly report', { since: Date.now() - 7 * 86_400_000 }); // search messages across chats
const [quoted] = await client.getMessages(['<msg_id>']); // fetch messages by id; threadMessages(rootId) fetches a whole thread
const missed = await client.missedMessages(Date.now() - 10 * 60_000); // backfill after reconnecting: messages that arrived after a given time (including thread replies)

// Lark Mail: client.mail, same credentials and permission rules
const threads = await client.mail.threads('INBOX', { limit: 20 }); // newest first; pass { before: threads.at(-1).updatedAt } for the next page
const conversation = await client.mail.thread(threads[0].threadId); // messages with text, HTML and attachments
await client.mail.send({ to: ['someone@example.com'], subject: 'Hi', text: 'Hello', attachments: [{ name: 'a.pdf', data: readFileSync('a.pdf') }] });
await client.mail.reply('<message_id>', { text: 'Thanks', all: true }); // also forward, sendDraft, deleteDrafts; { draftOnly: true } saves a draft
await client.mail.markRead([threads[0].threadId]); // also flag, archive, trash, modifyThreads (labels), search, labels, downloadAttachment

// Permissions: not checked by default (everything allowed). permissions: true uses the same rules as the CLI, or pass a rule set directly
const guarded = await LarkClient.create(new LarkAuth(), { permissions: { allow: ['query', 'send'], deny: ['*'] } });
await guarded.recallMessage('<msg_id>').catch((e) => e instanceof PermissionDenied && e.permission); // 'recall'
```

**Permissions**: the `permissions` option of `LarkClient.create` enables the same [command permissions](#command-permissions) as the CLI. When omitted, nothing is checked, same as before.

- `true`: uses this account's rules from `permissions.json` next to the credentials, falling back to `LARKX_ALLOW` / `LARKX_DENY`; rules are re-read on every call, so changes take effect without a restart. You can also pass `{ allow, deny }` directly.
- Each public method maps to a permission item of the same name (classified under the closest command, e.g. `addMembers` → `group.add`, `sendMessage` maps to `send` / `send-image` / `send-file` depending on content, `api` and `gatewayPost` → `api`). `client.mail` methods map to the `mail.*` items (`threads` → `mail.list`, `send` → `mail.send`, or `mail.draft` with `draftOnly`). When not allowed, it throws `PermissionDenied` (with `permission`, `group`, `rule`).
- Only the layer the caller invokes directly is checked: methods called internally by another method (e.g. the gateway call made while sending) are not checked again. Callbacks passed to methods (e.g. the persistent connection's `onMessage`) don't count as part of the method; calls made inside them are checked as usual.
- The standalone functions `uploadImage`, `uploadFile` and `downloadMessageResource` don't go through the client and are not subject to permissions.
- `PERMISSIONS`, `GROUPS`, `decide`, `loadRules` and `saveAccountRules` are exported too, for building your own permissions UI.

## Development

```bash
bun test                    # unit tests + decoding regression tests (parity fixtures)
bun run test:node           # compile the library to lib/ and run smoke tests under Node (protocol assets, encoding/decoding, credential read/write)
bun run typecheck && bun run lint
LARKX_TEST_MYSQL_URL=mysql+pymysql://root:test@127.0.0.1:33306/larkx bun test   # also run storage tests against MySQL
```

- **Parity fixtures**: `tests/fixtures/parity.json` was originally generated from the fork's Python implementation (synthetic data, no real messages) and is now maintained in this repo, with expected texts in English. Update it only together with a deliberate decoder change.
- **Protocol updates**: when Feishu changes its protocol, rebuild `assets/` following [scripts/proto-pipeline/README.md](scripts/proto-pipeline/README.md).

## Risks and disclaimer

- This is an unofficial implementation of the Feishu web client's internal protocol, and is not affiliated with ByteDance / Feishu / Lark in any way. The protocol may change at any time and break it.
- The full gateway definitions and endpoint mapping under `assets/` (`lark_all.binpb`, `core.binpb`, `cmd_map.json`) are extracted automatically by the pipeline from scripts served by the Feishu / Lark web client and the Lark Mail web app. All rights belong to ByteDance; they are included only for interoperability and are not the work of this repository or the original author.
- Sending and receiving messages with a personal account through an unofficial client carries a risk of triggering account risk controls. Use it only on your own account and in ways whose consequences you can accept; do not use it for bulk messaging or harassing others. Comply with the Feishu / Lark terms of service and the laws of your jurisdiction.
- This project is provided as is, without any express or implied warranty; users bear all responsibility for account bans, data loss or other damage resulting from its use.
- Credentials (cookies) are equivalent to a logged-in session. They are stored only in the local data directory; do not commit or share them.
- If a rights holder believes content in this repository infringes their rights, please open an issue; this repository will address it or be taken down promptly.

## Origin and acknowledgements

- This project is a TypeScript rewrite of [cv-cat/LarkAgentX](https://github.com/cv-cat/LarkAgentX) (by CVCat). The protocol reverse engineering, message encoding/decoding, login flow and protobuf definitions come from the original project; credit for the original features and ideas belongs to the original author.
- The rewrite baseline is the `feat/message-link` branch of the fork [Thxzzzzz/LarkAgentX](https://github.com/Thxzzzzz/LarkAgentX), commit [`3e406cd`](https://github.com/Thxzzzzz/LarkAgentX/commit/3e406cd57aed7c94b058b25676522a07b2eb9818) (2026-10-13). The data directory and the `credentials.json` and `messages.db` formats match it, so credentials and message stores written by the Python version are reused as is. Command output is English rather than the original's Chinese, so it is no longer a drop-in replacement for scripts that parse that output. For the module-by-module mapping and intentional differences, see [docs/compat.md](docs/compat.md).
- The original project ships without an open-source license; copyright belongs to the original author. This repository publishes its source for learning and discussion only, **with no license and no npm release**; if the original author objects, this repository will be taken down promptly.

Thanks to [CVCat](https://github.com/cv-cat) for [LarkAgentX](https://github.com/cv-cat/LarkAgentX), which did the hardest part: reverse engineering the protocol.
