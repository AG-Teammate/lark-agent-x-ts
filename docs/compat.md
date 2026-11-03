# 与 fork 版（Python）的兼容性

目标是**可直接替换**：命令、参数、标准输出、退出码、数据目录、`credentials.json`、`messages.db` 的表结构与内容格式都与 fork 版一致，调用方（如解析 `已发送 msg_id=…`、`OK …/EXPIRED …`、历史行首 position 的程序）不用改。

## 模块对照

fork 版的全部功能都已重写；新增功能见下面差异表的“新增”一行。

| 模块 | 原文件（fork 版） | 本仓库 | 验证 |
|---|---|---|---|
| 协议资产：网关包、长连接帧、全量网关定义、接口映射 | `larkx/proto/*.proto`、`lark_all_pb2.py`、`cmd_map.json` | `assets/`、`proto/proto.proto` | 由下面的管线重建；全量定义与接口映射与原版逐字节一致，`proto.proto` 在原版基础上补了编辑版本与 Markdown 字段（见下面的差异表） |
| 登录与凭证：扫码、cookie 导入、凭证校验 | `larkx/auth.py`、`region.py` | `src/auth.ts`、`src/region.ts` | 实测导入/校验/扫码初始化，凭证字段与原版一致 |
| 网关客户端与消息长连接 | `larkx/client.py` | `src/client.ts` | 实测发送 5 种消息、标已读、消息链接、搜索、拉历史、长连接收回显 |
| 消息解码（25 种类型）/ 请求构造 | `larkx/proto/decoders.py`、`builders.py` | `src/proto/` | 用原版 Python 生成的对照样本逐项比对 |
| 本地存储（SQLite / MySQL） | `larkx/storage/` | `src/storage/` | 同一套测试跑 SQLite 与 MySQL 8.4；读 Python 版的库输出逐字节一致 |
| 数字人（触发规则、会话队列、Claude Code 后端） | `larkx/agent/` | `src/agent/` | 单测（假的 claude 命令）；未用真实 Claude 端到端跑 |
| 命令行（fork 版的 14 个子命令） | `larkx/cli.py`、`main.py` | `src/cli/` | 只读命令与原版输出逐字节对比 |
| 资源下载 | `larkx/media.py` | `src/media.ts` | 实测下载的图片与原版逐字节一致 |
| 协议资产再生成管线 | `dev/proto_pipeline/` | `scripts/proto-pipeline/` | 同一批输入，全部中间产物与资产与原版逐字节一致 |
| 数字人链路演示 | `dev/demo_*.py` | `scripts/demo-agent.ts` | 默认只打印提示词，`--live` 才调真实后端 |

## 已逐字节核对

- `lark config`、`auth status`、`auth check`、`chats`、`sessions`、`messages`（含 `--json`、`--anchor`）、`history`（含 `--json`）、`api`（含原始字节的 `b'...'` 打印）、`search`、`self-chat`：同一份数据下两版输出相同（2026-10-13，读 Python 版写下的 `~/.larkx`）。
- 消息内容解码（18 种类型 + 解析失败文案）、推送帧解析、全部发送包构造与响应解码：`tests/parity.test.ts` 对照原版生成的样本。
- 入库格式：`content_data` 与 Python `json.dumps(ensure_ascii=False)` 一致（分隔符、转义、int64 不丢精度、浮点 `1.0`、字节换成 `<n bytes>`、截断到 2 万个字符）；时间列为 SQLAlchemy 的 `YYYY-MM-DD HH:MM:SS.ffffff`。
- 资源下载的文件、终端二维码字符画、agent 会话 id（uuid5）、协议资产与管线的全部中间产物（`proto.proto` 之后补的字段除外：`entities.Message` 的 `editVersion` / `editTimeMs`、`RichText` 的 `markdownIds`，以及随之重建的 `proto.binpb`、`core.binpb`）。

## 有意保留的差异

| 方面 | fork 版 | 本仓库 | 原因 |
|---|---|---|---|
| protobuf map 字段的遍历顺序 | upb 哈希表槽位顺序（同一组键在各进程间固定，但与插入或线上顺序都无关） | 线上顺序 | 原顺序没有含义，复刻 upb 哈希表既脆弱又无收益。影响：`content_data` 里 map 字段的键顺序（JSON 语义不变）；系统消息摘要里多段文字的拼接顺序；同一推送包里多条消息的处理顺序；发送包里 map 条目的线上顺序（服务端不依赖） |
| 同一推送包里的多条消息 | 投递到另一个事件循环并发处理 | 按到达顺序串行处理 | 入库顺序确定，调用方按自增 id 读取时不会乱序 |
| 网络层错误文案 | requests 的异常文本（如 `HTTPSConnectionPool(...): Read timed out.`） | `网络请求失败(<host>): <原因>` | 运行时不同，文案无法一致；保留"网络"二字，调用方按"网络 / timed out"识别网络问题的规则仍然成立。HTTP 非 2xx 的文案（`400 Client Error: Bad Request for url: …`）与 requests 一致 |
| 网关报错的原因 | 只有 requests 的 `400 Client Error: …` | 文案不变，网关在响应里给了原因时在末尾附 ` (<原因>)`（`lark api` 与未捕获异常）；库里放在 `HttpError.reason` | 原因（如 `chat not in thread mode`）能直接说明是参数、权限还是会话类型的问题 |
| 未捕获的异常 | 打印 Python 调用栈，退出码 1 | 只打印一行 `<错误类型>: <消息>`，退出码 1 | 调用方通常取最后一行做提示，结果相同 |
| 日志行 | `时间 \| 级别 \| 模块:函数:行号 - 消息` | `时间 \| 级别 \| 模块 - 消息` | 只少了函数名与行号 |
| `.env` 的位置 | python-dotenv 从包所在目录向上找（可编辑安装时即仓库根） | 当前工作目录（Bun 自动加载） | 单文件可执行没有"包所在目录"；需要时在调用方的工作目录放 `.env` 或直接传环境变量 |
| 凭证失效时的交互菜单 | questionary 方向键选择（不可用时退回数字菜单） | 数字菜单 | 少一个交互依赖，选项与行为相同 |
| 登录区域 | `feishu`、`lark` | 多一个 `lark-jp`（Lark 日本数据中心）：登录域 `*.jp.larksuite.com`，网关 / 长连接 / 文件主机按 messenger 页面 `window.__domains` 固定为 `internal-api-lark-api-jp` / `msg16-frontier-jp` / `internal-api-lark-file-jp.larksuite.com`，`Region.hosts` 可覆盖按 `domain` 推导的主机 | 日本数据中心的业务主机不遵循 `<服务>.<domain>` 规则，原版无法登录；凭证里 `region` 字段写 `lark-jp`，原版读到会报未知区域 |
| 库入口 | `larkx/__init__.py` 导出客户端、凭证、存储与 agent | 只导出 Node 与 Bun 都能运行的部分（凭证、客户端、长连接、资源下载、日志接口） | 存储与 agent 依赖 Bun，进程内嵌入（如 niuma）用不到它们；命令行照旧全部可用 |
| 长连接保活 | websockets 默认：握手 10 秒超时；协议层 ping 每 20 秒，20 秒无 pong 断开 | 握手 15 秒超时；应用层心跳每 30 秒，65 秒内收不到任何帧断开 | Node 的 WebSocket 没有协议层 ping；服务端对每次应用层心跳都回一帧，可据此判断连接是否还活着 |
| 断线重连 | 直接重连，断线期间的消息丢失 | 重连后按收件箱里有变动的会话补收断线期间的消息（会话消息与话题回复），按 msg_id 去重后入库并交给数字人 | 数字人不能漏掉有人找它的消息 |
| 数字人提示词 | `<message>` 里只有会话、发送者、时间与内容 | 回复别人（引用或话题回复）时多一行 `<quote>`，带被引用消息的发送者与原文；没有引用时与原版一致 | 只看到“可以”“同意”这类回复，数字人不知道对方在接哪句话 |
| 表情事件 | 不处理表情推送 | 长连接解出表情变化（谁对哪条消息加 / 取消了哪个表情），`listen` 记日志；`LARKX_AGENT_REACTIONS=true` 时别人对我的消息的表情变化交给数字人（`<reaction>`）；`lark config` 多一项 `agent_reactions` | 把点赞当作“同意执行”这类轻量确认 |
| 发送失败 | 直接失败（`sendMsg` 返回 None） | 网络错误、5xx、拿不到消息 id 时用同一个消息 cid 自动重试 2 次（服务端按 cid 去重，不会发重）；仍失败才返回 null / 抛错，`SendUnconfirmed` 带回 cid | 数字人的回复不该因为一次网络抖动丢掉，也不能重试出两条 |
| Markdown 元素 | 富文本里的 MARKDOWN 元素（tag 49，机器人消息常用）不计入摘要；`content_data` 里没有 `markdownIds` | 摘要里按原文取出它的内容；`content_data` 的 `richText` 多出 `markdownIds` | 机器人发的 Markdown 消息，原版摘要为空，数字人看不到内容 |
| 撤回与编辑 | 长连接重推的同一条消息按重复忽略 | 消息带 `recalled` / `edited` 标记（只在为真时出现）；`listen` 把库里被撤回的消息内容换成 `[已撤回]`（`content_data` 清空），被编辑的换成新内容；排队中的撤回消息不再交给数字人，编辑过的换成新内容，已处理过的带 `<edited>true</edited>` 再交给它 | 对方撤回或改了问题，数字人不能还按旧内容回答 |
| 命令权限 | 没有，所有命令都能执行 | 执行前按 `LARKX_ALLOW` / `LARKX_DENY` 或当前账号在 `permissions.json` 里的规则检查，不允许时退出码 126；规则配置有误时报错退出（退出码 1）。不配置时与原版一致。库的 `LarkClient.create` 可用 `permissions` 选项开启同一套检查（抛 `PermissionDenied`），不传时不检查 | 限定数字人能做什么，如只读、不拉人不撤回 |
| 新增 | — | `lark --version`（版本与构建 commit）；`lark permissions`；`lark send-image` / `send-file`、`lark get`、`lark thread`、`lark members`、`lark users`、`--names`、`lark recall` / `edit` / `react` / `reactions`、`lark search-messages`、`lark send --md` / `edit --md`、`lark unread`、`history --since/--until`、发送命令的 `--cid`、`lark read-status`、`lark forward`、`lark group`、`lark flag` / `flags`、`lark pin` / `pins` / `shortcut`、`lark tags`、`lark schedule` / `scheduled`、`lark translate`、触发规则 `LARKX_TRIGGER_INCLUDE_TAGS`（`lark config` 的 triggers 多一项 `include_tags`），库的 `getMessages` / `threadMessages` / `chatMembers` / `userNames`、`recallMessage` / `editMessage` / `addReaction` / `removeReaction` / `reactions` / `searchMessages` / `unreadChats` / `unreadMessages` / `unreadMentions` / `historyRange` / `positionAt` / `readStates` / `myReadStates` / `forwardMessage` / `createGroup` / `addMembers` / `removeMembers` / `updateGroup` / `flagMessages` / `flagChats` / `flags` / `pinMessage` / `unpinMessage` / `chatPins` / `shortcuts` / `addShortcuts` / `removeShortcuts` / `feedGroups` / `feedGroupChats` / `scheduleMessage` / `scheduledMessages` / `rescheduleMessage` / `cancelScheduledMessage` / `translateText` / `translateMessages`（这些新接口拉回的消息按被 @ 名单算 `at_me`；`history` 仍与原版一致，拉取的消息 `at_me` 为 false），库的 `sendMessage` 支持图片与文件、`uploadImage` / `uploadFile`；库的 `setLogSink`、`LarkClient.create` 的 `permissions` 选项与 `PermissionDenied`、`recentChats`（收件箱里某时刻之后有变动的会话）、`connectWebsocket` 的 `onOpen` 与 `onReaction` | 单文件构建没有 git 仓库可查 commit；嵌入别的进程时日志由宿主接管，并在重连后据此补收断线期间的消息；其余为数字人需要的能力（发附件等） |
