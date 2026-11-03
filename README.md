# lark-agent-x-ts

飞书 / Lark 网页版消息通道的 TypeScript 实现：以个人账号扫码登录，长连接接收全部消息并入库，以本人身份发消息、标已读、生成消息链接、调任意网关接口，可选接入本地 Claude Code 做"数字人"自动回复。用 Bun 打包成**单文件可执行**；库入口可在 Node 进程内嵌入。

## 安装与构建

需要 [Bun](https://bun.sh) ≥ 1.3。

```bash
bun install
bun run build                 # → dist/lark（当前平台的单文件可执行，约 64MB）
bun run build:all             # → dist/lark-bun-<平台>：macOS arm64/x64、Linux arm64/x64、Windows x64
bun src/cli/main.ts <命令>    # 或直接从源码运行
```

x64 目标用的是 Bun 的 `baseline` 构建（不要求 AVX2，老 CPU 与转译环境也能跑）。为什么选 Bun 见 [docs/adr/0001-bun-single-binary.md](docs/adr/0001-bun-single-binary.md)。

把 `dist/lark` 放进 PATH 即可。`lark --version` 打印版本与构建 commit。

## 命令

| 命令 | 说明 |
|-------|------|
| `lark auth qr` | 扫码登录（推荐；`--region lark` 登录 Lark 国际版，`--region lark-jp` 登录 Lark 日本数据中心） |
| `lark auth import` | 粘贴 cookie 登录 |
| `lark auth check` / `status` | 校验凭证是否过期 / 查看凭证概况 |
| `lark send <chat_id> <text>` | 发送消息（`--root` 回复进话题，`--reply <msg_id>` 引用回复，`--links` 把 `[文字](url)` 发成超链接，`--md [--title]` 发 Markdown（客户端按 Markdown 渲染），`--post [--title]` 发 HTML 富文本，`--rich <json\|@file>` 发结构化富文本；`--cid` 指定幂等键，同一个 cid 重发不会发重） |
| `lark send-image <chat_id> <路径>` / `lark send-file <chat_id> <路径>` | 发送图片 / 文件（本地文件自动上传；同样支持 `--root`、`--reply`） |
| `lark schedule <chat_id> <text> --at <时间>` / `lark scheduled <chat_id>` | 定时发送（`--at 10m`、`--at "2026-10-15 09:30"`，`--md`；每个会话同时只能有一条待发）/ 列出待发的定时消息（`--cancel`、`--reschedule` 配合 `--at`） |
| `lark translate <文本>` | 翻译文本（`--to en`，默认 zh）；`--msg` 时参数是消息 id，翻译这些消息 |
| `lark forward <msg_id> <chat_id...>` | 把一条消息转发到一个或多个会话 |
| `lark group create <群名>` / `add` / `remove` / `rename` | 建群（`--members`、`--desc`、`--topic` 建话题群）、拉人、移出、改群名或描述 |
| `lark pin <chat_id> <msg_id>` / `lark pins <chat_id>` | Pin 消息（`--remove` 取消） / 列出会话里被 Pin 的消息 |
| `lark shortcut [chat_id,...]` | 在会话列表里置顶会话（`--remove` 取消，不带参数列出已置顶的） |
| `lark tags [标签]` | 会话标签（分组）：列出标签，或列出某标签里的会话 |
| `lark flag <msg_id...>` / `lark flags` | 标记消息（`--chat` 标记会话，`--remove` 取消） / 列出我的标记 |
| `lark recall <msg_id...>` / `lark edit <msg_id> <text>` | 撤回消息 / 编辑自己发的文本或富文本消息（`--links`、`--rich`） |
| `lark react <msg_id> <表情>` / `lark reactions <msg_id...>` | 加表情回复（如 `THUMBSUP`、`DONE`，`--remove` 去掉） / 查看消息上的表情 |
| `lark read-status <chat_id> <msg_id...>` | 消息的已读情况：已读/未读人数与未读名单（发送方视角，`--names`）；`--me` 看我自己是否读过 |
| `lark read <chat_id> <msg_id...>` | 把消息标为已读（同客户端看过；话题回复按话题标记） |
| `lark message-link <chat_id> <msg_id...>` | 生成官方消息链接（单条定位到该消息；多条为合并链接） |
| `lark self-chat` | 打印与自己的会话 chat_id |
| `lark listen` | 常驻：长连接收消息入库；断线重连后自动补收断线期间的消息（含话题回复）；对方撤回或编辑消息时同步更新本地库；表情变化记日志 |
| `lark listen --agent`（或 `bun run agent`） | 常驻：收消息并接本地 coding agent 自动回复 |
| `lark messages <chat_id>` | 读本地消息记录（`--anchor` 只看话题，空串只看主会话） |
| `lark history <chat_id>` | 拉历史消息（`--save` 入库；`--since` / `--until` 按时间范围取最新的 `--count` 条，如 `--since 2h`、`--since 2026-10-01`） |
| `lark get <msg_id...>` | 按 id 取消息（可跨会话；`--save` 入库，`--json`） |
| `lark thread <root_id>` | 拉取一个话题：根消息加最近的回复（`--count`、`--save`、`--json`） |
| `lark download <msg_id> -o <路径>` | 下载消息里的图片/文件（本地没有该消息时向服务端取） |
| `lark api <类型名> '<json>'` | 调任意网关接口（类型名见 `assets/cmd_map.json`） |
| `lark chats` / `lark sessions` | 会话列表 / agent 会话表 |
| `lark search <关键词>` | 搜索用户/群 |
| `lark search-messages <关键词>` | 跨会话搜消息（`--chat`、`--from`、`--since`/`--until`：`3d`、`2026-10-01` 或时间戳，`--limit`、`--json`） |
| `lark unread` | 有未读的会话；`--chat <id>` 看某会话的未读消息，`--at` 只看各会话里 @我 的未读消息（`--since`、`--names`、`--json`） |
| `lark members <chat_id>` / `lark users <user_id...>` | 会话成员（id、名字、user/bot） / 批量查用户名字；`history`、`get`、`thread` 加 `--names` 时发送者显示为名字 |
| `lark config` | 查看生效配置 |
| `lark permissions` | 每个命令归哪个权限分组、现在能否执行（`--json`）；`edit` 在终端里交互编辑当前账号的规则，`clear` 清除，见[命令权限](#命令权限) |

## 配置

全部有默认值，用环境变量或当前目录的 `.env` 覆盖（Bun 启动时自动加载）：

```bash
LARKX_REGION=feishu          # feishu(飞书国内版) | lark(Lark 国际版) | lark-jp(Lark 日本数据中心)；只影响还没有凭证时的首次登录
LARKX_HOME=~/.larkx          # 数据目录：credentials.json、messages.db、permissions.json、login_qr.png
LARKX_STORAGE_URL=           # 留空=SQLite(LARKX_HOME/messages.db)；MySQL 填 mysql+pymysql://<user>:<password>@<host>:3306/<db>
LARKX_CONTEXT_SCOPE=anchor   # agent 上下文边界: anchor(会话+话题) | chat(会话) | global(全部共享)
LARKX_AGENT_BACKEND=claude   # claude | none
LARKX_SYSTEM_PROMPT=         # 数字人系统提示词，留空用内置默认
LARKX_MARK_READ=true         # 收到消息自动标已读；false 时由调用方在需要时 `lark read`
LARKX_AGENT_REACTIONS=false  # 别人对我的消息加/取消表情时交给数字人（如把点赞当作同意执行）
LARKX_DENY=                  # 拒绝执行的命令与分组，LARKX_ALLOW 为允许的，见下面的命令权限
LARKX_TRIGGER_PREFIX=        # 只把以此前缀开头的消息交给 agent；另有 LARKX_TRIGGER_CHAT_TYPES / _INCLUDE_CHATS / _EXCLUDE_CHATS / _INCLUDE_SENDERS / _INCLUDE_TAGS（会话标签名或 id）/ _KEYWORDS / _GROUP_AT_ONLY
```

凭证不放 `.env`，用 `lark auth qr` / `lark auth import` 管理。

### 命令权限

每个命令都可以单独或按分组允许 / 拒绝执行，用来限定数字人能做什么（`listen --agent` 起的 agent 调的也是 `lark`，与你共用同一份规则）。不配置时全部允许。作为库使用时同一套规则也能开启，见[作为库使用](#作为库使用)。

| 分组 | 包含 |
|---|---|
| `local` | 只读本机数据：`auth status`、`config`、`chats`、`sessions`、`messages`、`permissions`（查看） |
| `query` | 只读飞书数据：`auth check`、`history`、`get`、`thread`、`search`、`search-messages`、`unread`、`members`、`users`、`reactions`、`read-status`、`pins`、`flags`、`tags`、`translate`、`message-link`、`self-chat`、`download`，以及 `scheduled`、`shortcut` 的列出 |
| `outbound` | 发出新消息：`send`、`send-image`、`send-file`、`schedule`、`forward`，以及 `scheduled` 的取消与改时间 |
| `modify` | 改动已有消息或别人看得见的状态：`recall`、`edit`、`react`、`pin`、`read` |
| `organize` | 只影响自己的整理：`flag`，以及 `shortcut` 的置顶与取消 |
| `manage` | 群管理：`group` 的 `create` / `add` / `remove` / `rename` |
| `system` | 账号与进程级：`auth` 的 `qr` / `import`、`listen`、`api`、`permissions` 的 `edit` / `clear` |

读写混用的命令按动作细分，名字写作 `命令.动作`（如 `group.add`、`scheduled.cancel`、`auth.qr`）；`lark permissions` 列出全部名字与归属。

规则是允许和拒绝两个名字列表（逗号分隔或 JSON 数组），名字可以是 `*`、分组、命令或 `命令.动作`。判定时从具体到宽泛逐级找（`命令.动作` → 命令 → 分组 → `*`），第一级命中的规则生效，同一级上拒绝优先；都没命中则允许。

```bash
# 只读，再加发文本消息；其余一律拒绝
LARKX_DENY='*'
LARKX_ALLOW=local,query,send

# 只禁群管理和撤回
LARKX_DENY=manage,recall

# 禁群管理，但允许改群名（更具体的规则优先）
LARKX_DENY=manage
LARKX_ALLOW=group.rename
```

- **跟随账号**：`lark permissions edit` 在终端里打开分组树，给当前登录的账号设置规则：方向键移动、左右折叠展开，每一项在继承 / 允许 / 拒绝之间切换（空格轮换，或 `a` / `d` / `i`），每行实时显示最终能否执行、由哪条规则决定，`s` 保存、`q` 退出（有未保存的修改时先确认）。规则存在凭证旁边（即数据目录）的 `permissions.json`（以 user_id 为键），这个账号登录时整体替代上面的全局规则；账号还没有自己的规则时，编辑从全局规则的副本开始。`lark permissions clear` 清除，回到全局规则。脚本里改规则就直接写环境变量或 `permissions.json`。
- **被拒绝时**：退出码 126，stderr 说明是哪条规则拒绝的；`-h` 不受限制。规则里有不认识的名字、或 `permissions.json` 损坏时，所有命令都报错退出（退出码 1），不会放行。
- 规则拒绝了 `system` 时 `lark permissions edit` / `clear` 也会被拒，要改回请直接编辑 `permissions.json` 或环境变量。
- 这是防误操作的护栏，不是安全边界：agent 以 `--dangerously-skip-permissions` 运行，能改环境变量或数据目录就能绕过。

## 作为库使用

库入口在 Node（≥ 22.19）与 Bun 下都能用，导出登录凭证、网关客户端、消息长连接与资源下载；消息库（`Bun.SQL`）与本地 agent（`Bun.spawn`）依赖 Bun，只在命令行里用。作为 git 依赖安装时，Node 加载 `prepare` 编译出的 `lib/`，Bun 直接加载 `src/`（TypeScript 项目在 tsconfig 里设 `customConditions: ["bun"]` 即可直接用源码做类型检查，不依赖 `lib/`）。把本库打进自己的 Bun 单文件可执行时，在入口处 `import 'lark-agent-x-ts/bun-assets'`，协议资产随之嵌入。

```ts
import { LarkAuth, LarkClient, PermissionDenied, setLogSink } from 'lark-agent-x-ts';

setLogSink((level, module, msg) => myLogger.log(level, `${module} - ${msg}`)); // 可选：接到宿主日志，默认写 stderr
const client = await LarkClient.create(new LarkAuth('/path/to/credentials.json')); // 默认 ~/.larkx/credentials.json；联网校验
await client.sendMsg('你好', '<chat_id>');
await client.sendMessage('<chat_id>', { markdown: '## 结论\n- 周五上线' }); // Markdown 富文本
await client.sendMessage('<chat_id>', { image: readFileSync('shot.png'), name: 'shot.png' }); // 图片/文件自动上传；file: 字节 + name 发文件
await client.api('chats.PullChatsByIdsRequest', { chatIds: ['<chat_id>'] });
await client.connectWebsocket(async (msg) => console.log(msg.chat_id, msg.from_id, msg.content), undefined, undefined, async (ev) => console.log(ev.message_id, ev.reaction_type)); // 第 4 个参数收表情变化
const groupId = await client.createGroup('项目协作群', ['<user_id>']); // 另有 addMembers、removeMembers、updateGroup
await client.scheduleMessage('<chat_id>', { text: '周会提醒' }, Date.now() + 3_600_000); // 定时发送；scheduledMessages / rescheduleMessage / cancelScheduledMessage
const [en] = await client.translateText(['周五上线'], 'en'); // translateMessages(ids, 'zh') 翻译消息
await client.forwardMessage('<msg_id>', ['<chat_id>']); // 转发，返回会话 → 新消息 id
await client.readStates('<chat_id>', ['<msg_id>']); // 谁读了、谁没读；myReadStates 看自己是否读过
await client.addReaction('<msg_id>', 'DONE'); // 另有 editMessage、recallMessage、removeReaction、reactions
const names = await client.userNames(['<user_id>']); // id → 名字（批量、缓存）；chatMembers(chatId) 列群成员
const today = await client.historyRange('<chat_id>', { since: Date.now() - 3_600_000 }); // 按时间范围拉会话历史
const mentions = await client.unreadMentions(); // 未读的 @我；unreadChats() / unreadMessages(chatId)
const hits = await client.searchMessages('月报', { since: Date.now() - 7 * 86_400_000 }); // 跨会话搜消息
const [quoted] = await client.getMessages(['<msg_id>']); // 按 id 取消息；threadMessages(rootId) 取整个话题
const missed = await client.missedMessages(Date.now() - 10 * 60_000); // 断线重连后补收：某时刻之后到达的消息（含话题回复）

// 权限：默认不检查（全部允许）。permissions: true 按与命令行相同的规则，也可以直接给一份规则
const guarded = await LarkClient.create(new LarkAuth(), { permissions: { allow: ['query', 'send'], deny: ['*'] } });
await guarded.recallMessage('<msg_id>').catch((e) => e instanceof PermissionDenied && e.permission); // 'recall'
```

**权限**：`LarkClient.create` 的 `permissions` 选项开启与命令行同一套[命令权限](#命令权限)，不传时不检查，与以前一致。

- `true`：用凭证旁 `permissions.json` 里这个账号的规则，没有则用 `LARKX_ALLOW` / `LARKX_DENY`；每次调用时重新读取，改了规则不用重启。也可以直接传 `{ allow, deny }`。
- 每个公开方法归到一个同名的权限项上（按最接近的命令归类，如 `addMembers` → `group.add`、`sendMessage` 按内容归到 `send` / `send-image` / `send-file`、`api` 与 `gatewayPost` → `api`），不允许时抛 `PermissionDenied`（带 `permission`、`group`、`rule`）。
- 只检查调用方直接调的那一层：方法内部再调其他方法（如发送时内部调网关）不再检查；传给方法的回调（如长连接的 `onMessage`）不算在内，回调里的调用照常检查。
- 独立函数 `uploadImage`、`uploadFile`、`downloadMessageResource` 不经过客户端，不受权限控制。
- `PERMISSIONS`、`GROUPS`、`decide`、`loadRules`、`saveAccountRules` 也一并导出，可用来做自己的权限界面。

## 开发

```bash
bun test                    # 单测 + 与 Python 版的对照测试
bun run test:node           # 编译库到 lib/，在 Node 下跑冒烟测试（协议资产、编解码、凭证读写）
bun run typecheck && bun run lint
LARKX_TEST_MYSQL_URL=mysql+pymysql://root:test@127.0.0.1:33306/larkx bun test   # 存储测试同时跑 MySQL
```

- **对照样本**：`tests/fixtures/parity.json` 由 `scripts/gen-parity-fixtures.py` 用 fork 版的 Python 实现生成（合成数据，不含真实消息），改了编解码逻辑时在装有 fork 版的 Python 环境里重新生成。
- **协议更新**：飞书改协议后按 [scripts/proto-pipeline/README.md](scripts/proto-pipeline/README.md) 重建 `assets/`。

## 风险提示与免责声明

- 这是对飞书网页版内部协议的非官方实现，与字节跳动 / 飞书 / Lark 无任何关联。协议随时可能变化导致失效。
- `assets/` 下的全量网关定义与接口映射（`lark_all.binpb`、`core.binpb`、`cmd_map.json`）由管线从飞书网页客户端下发的脚本中自动提取生成，相关权利归字节跳动所有，收录仅为实现互通，不属于本仓库或原作者的作品。
- 以个人账号经非官方客户端收发消息存在账号风控风险，请只在自己的账号上、以自己能承担后果的方式使用；不要用于批量发送或骚扰他人。使用时请遵守飞书 / Lark 的服务条款与所在地法律法规。
- 本项目按现状提供，不作任何明示或默示的担保；因使用本项目造成的账号封禁、数据丢失或其他损失，由使用者自行承担。
- 凭证（cookie）等同于账号登录态，只保存在本机数据目录，请勿提交或分享。
- 权利人如认为本仓库的内容侵犯其权益，请提 issue 联系，本仓库会随即处理或下线。

## 来源与致谢

- 本项目是 [cv-cat/LarkAgentX](https://github.com/cv-cat/LarkAgentX)（作者 CVCat）的 TypeScript 重写：协议逆向、消息编解码、登录流程与 protobuf 定义来自原项目，功能与思路的原创归原作者所有。
- 重写基线是 fork [Thxzzzzz/LarkAgentX](https://github.com/Thxzzzzz/LarkAgentX) 的 `feat/message-link` 分支，commit [`3e406cd`](https://github.com/Thxzzzzz/LarkAgentX/commit/3e406cd57aed7c94b058b25676522a07b2eb9818)（2026-10-13）。命令行用法、数据目录、`credentials.json` 与 `messages.db` 格式与它一致，可直接替换 `lark` 命令，Python 版写下的凭证和消息库原样沿用；逐模块对照与有意差异见 [docs/compat.md](docs/compat.md)。
- 原项目未附带开源许可证，版权归原作者。本仓库公开源码仅供学习与交流，**不附带许可证、不发布到 npm**；原作者如有异议，本仓库会随即下线。

感谢 [CVCat](https://github.com/cv-cat) 的 [LarkAgentX](https://github.com/cv-cat/LarkAgentX) 完成了协议逆向这项最难的工作。
