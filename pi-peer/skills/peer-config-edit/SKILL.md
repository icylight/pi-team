---
name: peer-config-edit
description: 编辑 pi-peer 的项目配置——`.pi/peer.json`（启用开关、项目标签、角色声明与默认模型/思考强度、流程文档、工单定时提醒 workOrders）、角色卡 `.pi/characters/*.md`、流程文档 `.pi/flows/*.md`。当用户说"改 peer 配置""加个角色""新建角色卡""改角色卡""配角色模型/思考强度""改项目标签""关掉 peer""配流程文档""配工单定时提醒""followRole""交接唤醒""wakeOnHandoff""角色隐身""visibleTo"或用 /peer-config 看到兜底项想配实时使用。按自然语言意图落成配置：意图不完整时先追问改哪份、改成什么，然后直接写入并告知改动；不做写入前批准。
---

# pi-peer 配置编辑（peer-config-edit）

把用户的口头意图落成 pi-peer 的配置与角色文件。不实现固定表单——按自然语言意图定位要改的项，直接写入。

工具侧只读核对用 `/peer-config`（列出每个生效项与来源：配置 / 兜底 / 缺）。本 skill 只负责「问清楚 → 写 → 告知」。

## 配置面：三份文件

| 文件 | 管什么 |
| --- | --- |
| `<项目>/.pi/peer.json` | 启用开关、项目标签、角色声明（卡路径 + 默认模型 + 思考强度）、流程文档、工单定时提醒 |
| `<项目>/.pi/characters/<角色>.md` | 角色卡：frontmatter（name/description）+ 正文 prompt |
| `<项目>/.pi/flows/<名字>.md` | 流程文档：注入当前角色会话的 Markdown 参考 |

三份都可被项目配置显式指向别处；不写就按下面的兜底规则算。

## 生效规则（先看这条，避免配了不生效）

来源只有三种，`/peer-config` 逐项标注：

- **配置**：`peer.json` 里显式写的
- **兜底**：没写，按规则算出来的 —— 项目标签取目录名；角色扫 `.pi/characters/*.md`；角色卡取 `.pi/characters/<角色>.md`；流程按 `group.name` 找 `.pi/flows/<项目标签>.md`
- **缺**：没写且兜底也没命中（角色卡不存在 → 角色不加载）

据此决定改哪份：只在项目里加角色通常**放一份角色卡即可**（走兜底），要指定模型/思考强度或改路径才需要写 `peer.json`。

## peer.json 字段

```json
{
  "enabled": true,
  "group": {
    "name": "example-project",
    "roles": {
      "owner": { "card": ".pi/characters/owner.md" },
      "dev": {
        "card": ".pi/characters/dev.md",
        "model": "feizhi/deepseek-flash",
        "thinkingLevel": "high",
        "visibleTo": ["owner"]
      }
    },
    "flow": ".pi/flows/example-project.md"
  },
  "workOrders": { "followRole": "owner" },
  "wakeOnHandoff": true
}
```

- `enabled`：只认字面 `false` 且只在**项目根这份**生效；**缺省启用**。关掉后本扩展不注册任何东西，`/peer-config` 也不存在
- `group.name`：项目标签，同时是跨项目寻址前缀（`项目/名字`）与流程兜底的文件名
- `group.roles.<角色>.card`：角色卡路径（相对本项目）；也收字符串简写 `"owner": ".pi/characters/owner.md"`
- `group.roles.<角色>.model`：完整 `provider/model-id`
- `group.roles.<角色>.thinkingLevel`：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`
- `group.roles.<角色>.canAssignRoles`：布尔值，默认 `false`；设为 `true` 后该角色可用 `peer_assign_role` 给同项目其他在线会话分配角色（包括具备调度权限的角色）；目标在跑一轮时排队，这一轮结束后立即切换。授权范围由用户决定，不能因派工自行授予
- `group.roles.<角色>.canStartSessions`：布尔值，默认 `false`；用户明确授权后可为同项目其他空闲 agent 新建会话并派发任务，与 `canAssignRoles` 独立；行为与失败核实见包 README「让已有 agent 新建会话」
- `group.roles.<角色>.visibleTo`：角色名数组，默认不写（人人可见）。写了就让该角色在项目内隐身，只有名单里的基础角色在 `peer_list` 里看得到它、能给它发消息（含工单派工与交接）；跨项目不算名单内。实例名按基础角色算，`dev` 覆盖 `dev-2`
- `group.flow`：流程文档路径
- `wakeOnHandoff`：收到工单交接时是否额外注入一条唤醒消息把目标叫醒；**缺省关闭**，只把交接正文落进会话、不替目标开新一轮。写错时按关闭处理并告警
- `workOrders.followRole`：工单定时提醒跟的角色名（**由 pi-work-orders 读，不由 pi-peer 读**；空 = 不开）。同段还收 `intervalMinutes` / `staleMinutes` / `repeatMinutes`（正数）与 `digest`（布尔，每轮往系统提示注入台账摘要，缺省关闭）

顶层 `roles` / `flow` 是不包在 `group` 里的简写，`group.*` 优先。路径一律相对**声明它的配置文件**解析。

字段写错的后果是非对称的：`enabled` 写错仍按启用（只是不生效），其余字段写错**那一项被忽略**并落进 `/peer-config` 的告警；JSON 整份解析失败则全部按兜底。所以改完务必用 `/peer-config` 核对，别只看文件写对了。

## 流程

1. 用户意图不完整时追问：改哪个角色 / 哪个项目 / 是否要指定模型或思考强度；不要猜路径、不写占位符。意图完整就直接动手。
2. 读现状：目标配置文件（可能不存在）、涉及的角色卡/流程全文。
3. 直接写入，按下面「写入约定」做最小改动。
4. 告知改了哪些文件、哪些键；没有变化时说明无变化。

## 写入约定（幂等与安全）

- 改 `peer.json` 前先读并保留全部现有字段——尤其**别的扩展读的键**（如 `workOrders`）和 pi-peer 不认识的键：不得删除或改动它们。只对目标项做最小、幂等修改（目标已覆盖就不重复添加）
- 保持 JSON 合法；角色卡保持 frontmatter 的 `name` 与 `description` 两个必填字段都在（缺任一加载即报错）
- 同一文件同一时刻只改一次，不与其它会话并行争改

## 生效语义

模型与思考强度只在会话加载时套用（含 `/peer-role` 中途领取）；远程 `peer_assign_role` 只换角色卡与实例名，不改目标的模型与思考强度。

写入后告知用户——`canAssignRoles` 与 `canStartSessions` 每次调用时读取，修改权限无需重载；其他 `peer.json` 字段、角色卡与流程都在会话加载时读，改完需 `/reload`，或用 `/peer-reload` 开一个继承当前角色与模型的新会话；`enabled: false` 的项目里本扩展整个不注册，要恢复先改回文件并 `/reload`。本 skill 不做文件监听或热更新。