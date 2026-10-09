# pi-peer

同一个 `~/.pi/peers` 下的多个 pi 会话互通。典型场景：同一个项目目录开两个 pi（挂不同模型）临时互相问，或者跨项目找另一个目录里的会话通报进度。

零第三方依赖、无守护进程、无网络、不依赖 tmux —— 两个 pi 只要都加载了本扩展，就能互相发现并对话；不在同一目录的要写「项目标签/名字」。

## 安装

安装包含 pi-peer 与 pi-work-orders 的工具包：

```bash
pi install git:github.com/icylight/pi-team
```

只需 pi-peer 时，检出仓库后执行 `pi install /path/to/pi-team/pi-peer`。

重启 pi 或执行 `/reload` 生效。本地路径是原地加载，改完源码不用重装。

同一份扩展不要装两遍（比如全局一份、项目又一份）：工具名会撞，两份都不加载，报错形如 `Tool "peer_list" conflicts with ...`。

## 用法

```bash
# 终端 A：cd 到项目目录
pi

# 终端 B：同一个目录
pi --model deepseek/deepseek-flash

# 当前终端也可以直接新建一个会话（等同 pi 原生 /new，额外带上角色）：
/peer-new                    # 弹列表选角色，可选“自定义角色名…”
/peer-new --role dev         # 跳过选择，直接领 dev
```

然后：

```
/peers                 # 看同目录还有谁（/peers all 连其他项目一起列）
/peer-name reviewer     # 普通会话给自己起名
/peer-send reviewer 帮我看看 src/a.ts 的并发处理
/peer-send ipd/owner 跨项目就用「项目标签/名字」
```

角色会话按基础角色自动分配实例名：第一次是 `dev`，第二次是 `dev-2`，依次递增；所有实例都加载同一份 `.pi/characters/dev.md`。角色会话不能用 `/peer-name` 改名。

Agent 侧我会主动用 `peer_list` / `peer_send` 互相通信；收到消息会自动唤醒对方。

## 命令与工具

| 名称 | 说明 |
|---|---|
| `/peers [all]` | 列出同目录其他会话（名称、模型、id）；`all` 连其他项目一起列 |
| `/peer-config` | 看生效的项目配置从哪来：每个生效项带来源（配置 / 兜底 / 缺），以及写了但不由 pi-peer 读的键 |
| `/peer-role` | 查看当前角色与自动分配的实例名；角色只能在启动时指定 |
| `/peer-name <名字>` | 设置普通会话在 pi-peer 里的名字（持久化到 session） |
| `/peer-send <目标|项目/目标> <正文>` | 手动发消息；写「项目/名字」即跨项目 |
| `/peer-new [--role <角色>]` | 新建会话（同进程，等同原生 `/new`）；不给 `--role` 就弹列表选，可选自定义角色名。没有对应角色卡时照开，只退成普通会话，用 `/peer-name` 起名 |
| `PI_PEER_ROLE=<角色> pi` | 直接启动一个带角色的会话 |
| `peer_list` | 工具：列出同伴（含在线状态、心跳时间）；`scope="all"` 含其他项目 |
| `peer_send` | 工具：发消息（`to` 支持 名称 / 项目/名称 / name#pid / id 前缀 / pid） |
| `peer_inbox` | 工具：查看收到的历史消息 |

目标名有歧义时不会瞎猜，会返回候选列表让你补全。

## 跨项目

同一个 `~/.pi/peers` 下每个项目一个桶，默认只看本项目。要跟其他项目的会话说话，写「项目标签/名字」：

```
peer_list(scope="all")                    # 列出其他项目的在线会话
peer_send(to="example-project/owner", …)   # 项目标签/名字
```

项目标签取项目的 `group.name`，没配就用目录名（走兜底时会在配置报告里标出来，见「配置来源」）。跨项目消息的落款会带上发送方前缀（形如 `.pi/dev`），对方抄回去就能回信 —— **接收方不需要升级**，跨项目只是写到了另一个目录，监听收件箱那一侧没变。

同桶投递不带前缀，本项目内发消息照旧。同名目标不唯一时报歧义并给候选，不会猜。

## 机制

```
~/.pi/peers/<目录名>-<路径哈希>/
  members/<sessionKey>.json        会话注册表（5s 心跳，30s 无心跳即判离线）
  pending/<sessionKey>/*.json      收件箱（未投递）
  delivered/<sessionKey>/*.json    已投递存档（保留最近 200 条）
  outbox/<sessionKey>/*.json       自己发出的消息（回复链追踪）
```

- **发现**：会话启动时注册自己并持续心跳；`pid` 存活 + `lastSeen` 新鲜才算在线，过期自动清理
- **投递**：原子写（临时文件 + rename），对方 `fs.watch` 自己的收件箱触发，2s 轮询兜底
- **不重复**：投递前先把消息 `rename` 到 `delivered/`，同一条消息只会被注入一次
- **唤醒**：以 `custom_message`（customType `peer`）注入会话语境，触发一轮回复；对方忙时用 `steer` 插到当前 turn 的工具调用之后，不等整个任务跑完
- **分桶**：按工作目录分桶，默认只在本桶内发现与寻址；跨桶要显式写「项目标签/名字」，所以不会被无关项目的会话刷屏

## 配置

项目里不想让 pi-peer 生效时，在项目根放一份 `.pi/peer.json`：

```json
{ "enabled": false }
```

关掉的项目里本扩展不注册任何东西：没有 `peer_list` 等工具、没有 `/peers` 等命令、不写 `~/.pi/peers/`、不起心跳与收件箱监听。只读当前目录这一份配置，不向上递归查找 —— 同目录才算同一个桶，子目录起的会话本来就不互通。

文件不存在、或 `enabled` 缺失时按启用处理；JSON 解析失败、`enabled` 不是布尔值时也按启用处理，但会在交互会话里发一条警告。

| 配置 | 作用 |
|---|---|
| `<项目根>/.pi/peer.json` | 项目级开关，`{"enabled": false}` 关闭本项目 |
| `PI_PEER_OFF=1` | 进程级开关，关掉这个 pi 进程（不分目录） |
| `PI_PEER_ROOT` | 改共享目录根（默认 `~/.pi/peers`） |
| `PI_PEER_ROLE` | 启动时加载的基础角色名；角色卡默认取 `.pi/characters/<角色>.md` |

## 配置来源

配置文件里写了什么、哪些字段真的生效，不靠猜：`/peer-config` 把每个生效项连来源一起列。

```
项目配置：/path/to/example-project/.pi/peer.json（不存在（全部按兜底））
项目标签：example-project ｜ 兜底：group.name 没写，按目录名
可用角色：owner、qa ｜ 兜底：roles 没写，扫 .pi/characters/
角色卡（owner）：.pi/characters/owner.md ｜ 兜底：roles 里没声明 owner，按 .pi/characters/owner.md 命中
流程文档：.pi/flows/example-project.md ｜ 缺：flow 没写，按 group.name 找 .pi/flows/example-project.md，文件不在或为空
```

来源只有三种，所有项共用：**配置**（文件里显式写的）、**兜底**（没写，按规则算出来的）、**缺**（没写且兜底也没命中）。新增字段走同一个模型，报告与会话提示都不用改。

会话启动时会主动说三件事，其余时候安静：

- 配置文件本身有问题：JSON 解析不了、或字段写错（写错的字段不生效，一处一条）
- 除项目标签外，有东西按兜底生效了 —— 典型是同事 clone 下来只有 `.pi/characters/*.md`、没有配置文件；会话照样跑得起来，但得知道跑的是兜底
- 项目标签走兜底且配置文件存在（有人在配，那就是没配全）

项目标签单独的兜底不吭声：没配置文件、也没角色的项目本来不需要配，每次都为它弹一句是噪声。

`enabled: false` 的项目里扩展整个不注册，所以 `/peer-config` 也不存在 —— 那种项目要看配置只有直接读文件。

## 测试

```bash
npm test        # node --test，67 个用例覆盖角色认领、跨项目寻址、配置来源、发现/解析/投递/去重/截断/清理
```

## 角色与流程配置

项目配置可以声明角色卡和 Markdown 流程；不配置角色时，`/peer-new --role dev` 默认读取 `.pi/characters/dev.md`。角色卡不存在时不挡新建：会话照开，只是没有卡，也就不是角色会话（不占实例名、不上报角色），用 `/peer-name` 自己起名即可。

`group.name` 同时也是跨项目寻址的项目标签（见「跨项目」）。

```json
{
  "enabled": true,
  "group": {
    "name": "example-project",
    "roles": {
      "owner": { "card": ".pi/characters/owner.md" },
      "dev": { "card": ".pi/characters/dev.md" },
      "qa": { "card": ".pi/characters/qa.md" }
    },
    "flow": ".pi/flows/ipd.md"
  }
}
```

`flow` 只作为当前角色会话的 Markdown 参考注入，不自动修改工单或执行交接。角色的第一个实例名保留基础名，后续实例使用 `-2`、`-3`；会话退出后实例名可复用 —— `/peer-new` 会先结束当前会话再领号，所以同一会话反复换角色仍拿基础名，只有并行会话才会递增到 `dev-2`。

## 已知边界

- 对方忙时的投递会插进它当前的作业链（`steer`），可能让它偏题；真被卡在一个长命令里，仍要等那条命令跑完
- 没有防互刷的硬刹车：消息一到就起一轮，两个 agent 万一互相客套刷屏，只能人工中断或改 prompt 约束
- 目标离线时消息不发（`resolve` 回 `offline`）：写进一个没人取的 key 里，信会永远躺着，发件方却以为送达了。要等人回来就等，别改成写死信箱
- 同毫秒内跨进程的消息顺序不保证（进程内用序号保证）
- 单条消息上限 32 KB，超出截断

## 代其他扩展投递

其他扩展（如 `pi-work-orders` 建单后叫人）走事件总线，不调 `peer_send` 工具：不占一次工具调用，也不触发权限询问。

| 频道 | 方向 | 载荷 |
|---|---|---|
| `peer:deliver` | 调用方 → peer | `{ id, targets: string[], text, requireIdle? }` |
| `peer:deliver:result` | peer → 调用方 | `{ id, ok, to?, detail }` |
| `peer:whoami` | 调用方 → peer | `{ id }` |
| `peer:whoami:result` | peer → 调用方 | `{ id, name }` |

`targets` 是有序候选，peer 投给第一个可投的；都不行就回 `ok: false`（失败也必回，否则调用方等超时）。调用方没有 peer 时应按「没叫到人」处理，不应当成业务失败。

`requireIdle: true` 时跳过正在跑一轮的会话（`在忙`），派工用：投递会 steer 插进对方当前这轮，把正在做事的人带偏。手动发消息不传它。

库层面的同一件事是 `PeerStore.deliverTo(target, { from, fromName, text }, { idleOnly })`——扫描器这类没有会话的调用方走它。

## 忙闲

成员带着 `busy` / `busySince`：`agent_start` 到 `agent_end` 之间算在忙，心跳会把它刷给其他会话。`peer_list` 显示成 `在线·空闲` / `在线·在忙`。

忙会按超时兜底（`BUSY_STALE_MS`，30 分钟）：`agent_end` 在中断路径上是否必发还没验证过，卡住的 busy 到点就作废，免得一次异常让某个会话永远收不到派工。
