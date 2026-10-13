---
name: peer-config-edit
description: 编辑 pi-peer 的项目配置——`.pi/peer.json`（启用开关、项目标签、角色声明与默认模型/思考强度、流程文档、工单定时提醒 workOrders）、角色卡 `.pi/characters/*.md`、流程文档 `.pi/flows/*.md`。当用户说"改 peer 配置""加个角色""新建角色卡""改角色卡""配角色模型/思考强度""改项目标签""关掉 peer""配流程文档""配工单定时提醒""followRole"或用 /peer-config 看到兜底项想配实时使用。先访谈确认改哪份文件、改成什么，展示 diff 并取得确认后再写入；改动持久配置，不确认不写。
---

# pi-peer 配置编辑（peer-config-edit）

把用户的口头意图落成 pi-peer 的配置与角色文件。不实现固定表单——按自然语言意图逐步确认。

工具侧只读核对用 `/peer-config`（列出每个生效项与来源：配置 / 兜底 / 缺）。本 skill 只负责「问清楚 → 给 diff → 确认 → 写」。

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
        "thinkingLevel": "high"
      }
    },
    "flow": ".pi/flows/example-project.md"
  },
  "workOrders": { "followRole": "owner" }
}
```

- `enabled`：只认字面 `false` 且只在**项目根这份**生效；**缺省启用**。关掉后本扩展不注册任何东西，`/peer-config` 也不存在
- `group.name`：项目标签，同时是跨项目寻址前缀（`项目/名字`）与流程兜底的文件名
- `group.roles.<角色>.card`：角色卡路径（相对本项目）；也收字符串简写 `"owner": ".pi/characters/owner.md"`
- `group.roles.<角色>.model`：完整 `provider/model-id`
- `group.roles.<角色>.thinkingLevel`：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`
- `group.flow`：流程文档路径
- `workOrders.followRole`：工单定时提醒跟的角色名（**由 pi-work-orders 读，不由 pi-peer 读**；空 = 不开）。同段还收 `intervalMinutes` / `staleMinutes` / `repeatMinutes`（正数）

顶层 `roles` / `flow` 是不包在 `group` 里的简写，`group.*` 优先。路径一律相对**声明它的配置文件**解析。

字段写错的后果是非对称的：`enabled` 写错仍按启用（只是不生效），其余字段写错**那一项被忽略**并落进 `/peer-config` 的告警；JSON 整份解析失败则全部按兜底。所以改完务必用 `/peer-config` 核对，别只看文件写对了。

## 流程（必须遵守）

1. **先定位改哪份、改成什么**。用户意图不完整时追问：改哪个角色 / 哪个项目 / 是否要指定模型或思考强度；不要猜路径、不写占位符。
2. **读现状**：目标配置文件（可能不存在）、涉及的角色卡/流程全文（若在改）。
3. **产出 diff**：逐项列出变化（新增/修改/删除的键与值），角色卡则给精确 diff。明确写「配置无变化」或列出将写入的文件集。
4. **取得用户明确确认后写入**，用户取消则零写入。未确认前不创建目录、不写任何文件。

## 写入约定（幂等与安全）

- 改 `peer.json` 前先读并保留全部现有字段——尤其**别的扩展读的键**（如 `workOrders`）和 pi-peer 不认识的键：不得删除或改动它们。只对目标项做最小、幂等修改（目标已覆盖就不重复添加）
- 保持 JSON 合法；角色卡保持 frontmatter 的 `name` 与 `description` 两个必填字段都在（缺任一加载即报错）
- 同一文件同一时刻只改一次，不与其它会话并行争改

## 生效语义

写入后告知用户——`peer.json`、角色卡、流程都在会话加载时读，改完需 `/reload` 或重开会话；`enabled: false` 的项目里本扩展整个不注册，要恢复先改回文件并 `/reload`。本 skill 不做文件监听或热更新。