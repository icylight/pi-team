---
name: peer-capabilities
description: pi-peer 的能力边界——agent 可调的工具与只有人能敲的斜杠命令怎么分、几组易混操作怎么选（peer_send / peer_new_session / peer_assign_role / peer_focus、/reload 与 /peer-reload）、调度权限开关与环境变量。当 agent 要判断「这件事我能不能自己做」、要建议用户敲哪个命令、遇到 peer 命令调不到或报权限不足、或排查 peer 没生效（PI_PEER_OFF、enabled:false、角色没权限）时使用。不管消息怎么措辞，也不编辑项目配置与角色卡。
---

# pi-peer 能力地图

工具是 agent 的手，斜杠命令是人的手。判据只有一条：**你在工具列表里能看到的，你能调；`/` 开头的，只有用户敲得动。**

## 只有人能敲

agent 判断某件事该做但自己做不到，就把它写清楚交给用户敲，不要假装执行过。

| 命令 | 用途 |
| --- | --- |
| `/peers [all]` | 列会话；`all` 连其他项目 |
| `/peer-role [角色\|none]` | 查看或切换本会话角色，不带参弹列表 |
| `/peer-name <名字>` | 设本会话名字 |
| `/peer-send <目标\|项目/目标> <正文>` | 手动发消息 |
| `/peer-new [--role 角色]` | 新建会话并领角色 |
| `/peer-reload` | 新建会话，继承当前名字、角色、模型 |
| `/peer-config` | 看生效配置的来源：配置 / 兜底 / 缺 |
| `/peer-inbox-repair` | 把老会话散在多 key 目录的收件历史归组 |

## `/reload` 与 `/peer-reload` 不是一回事

| 写法 | 做什么 | 什么时候用 |
| --- | --- | --- |
| `/reload`（pi 原生） | 重载扩展代码，**上下文保留** | 改过扩展或配置，要让运行中的会话吃到新代码 |
| `/peer-reload`（pi-peer） | **新建会话**，上下文清空，身份不变 | 要一个干净上下文但保留名字与角色 |

用户说「reload 一下」而刚改过扩展，指的是前者。

## 工具之间怎么选

| 想做什么 | 用哪个 | 边界 |
| --- | --- | --- |
| 给现成会话发消息 | `peer_send` | 一律 steer，目标在忙也取走投递；只在它这一轮的工具返回后进入上下文 |
| 让某个会话从干净上下文开工 | `peer_new_session` | 不新增进程，重置目标的会话；须 `canStartSessions` |
| 换掉某个会话的角色 | `peer_assign_role` | 不清上下文、不改模型；须 `canAssignRoles`；目标在跑一轮时默认打断 |
| 自己一段时间不接话 | `peer_focus` | 仍然可见，但消息被拒发、派工与交接跳过；发出一条消息或 `peer_focus(false)` 退出 |
| 看自己收到过什么 | `peer_inbox` | 只读历史，按整段对话聚合 |

发消息前先用 `peer_list` 查目标：名字有歧义时工具不猜，会回候选。

## 调度权限

`canAssignRoles` 与 `canStartSessions` 都写在项目配置的 `roles.<角色>` 或 `group.roles.<角色>` 下，缺省为关，改完实时生效：

- `canAssignRoles`：能给别人分配角色
- `canStartSessions`：能给同项目其他空闲会话新建会话

无权时工具直接报「当前角色没有 X 权限」。这不是 bug，是没开。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_PEER_OFF=1` | 关掉这个进程的 peer（不分目录） |
| `PI_PEER_ROLE` | 启动时加载的角色名 |
| `PI_PEER_ROOT` | 改共享目录根，默认 `~/.pi/peers` |

## peer 没反应时按顺序查

1. 命令和工具都不在 → 进程被 `PI_PEER_OFF=1` 或项目 `.pi/peer.json` 的 `enabled: false` 关了
2. 工具在但发不出去 → 同目录没有别的会话；或目标专注中（发送方看到「专注中，不接收消息」，不是找不到）
3. 报权限不足 → 上面列的开关没开
4. 配置项看着没生效 → 敲 `/peer-config` 看那一项的来源是「配置」还是「兜底」
