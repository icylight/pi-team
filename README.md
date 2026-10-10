# pi-team

pi 的多会话协作工具：用 pi-peer 沟通，用 pi-work-orders 记录任务状态。

- **[pi-peer](pi-peer/README.md)**：同机会话发现、消息投递、角色卡与流程加载。
- **[pi-work-orders](pi-work-orders/README.md)**：SQLite 工单台账、依赖、交接依据与停滞提醒。

两个包通过 pi 的事件总线协作，没有相互导入源码。未加载 pi-peer 时，工单仍可读写；消息唤醒不可用。

## 安装

需要 pi 和 Node.js 22.19 或更新版本。

```bash
pi install git:github.com/icylight/pi-team
```

安装根包会同时加载两个扩展和工单操作 skill。现有会话执行 `/reload`，或重启 pi。

开发检出可直接安装本地目录：

```bash
pi install /path/to/pi-team
```

只需其中一个包时，可安装检出目录下的 `pi-peer/` 或 `pi-work-orders/`。同一个扩展只保留一种安装方式，避免根包与子包重复加载。

## 使用

在同一项目目录打开多个 pi 会话：

```text
/peer-name owner
/peers
/peer-send dev 请接手接口实现
/orders
```

角色卡、流程和定时提醒由使用方项目的 `.pi/peer.json` 配置，不随本包提供。配置与完整用法见各子包 README。

Agent 可用 `peer_list`、`peer_send`、`peer_inbox` 通信，用 `orders_*` 工具建单、认领、交付和复核。

工单 skill 只规定台账操作。角色分工、派工判断与验收标准由使用方项目确定；本包不要求安装额外的管理类 skill。

## 数据与边界

消息默认保存在 `~/.pi/peers/`，工单默认保存在使用方项目的 `.work-orders/`。安装目录变化不搬迁这些数据；项目移动会改变 peer 的工作目录分桶。

项目应将 `.work-orders/` 加入 `.gitignore`，消息、会话、工单数据库和凭证不提交到代码仓库。

pi-peer 使用本机文件邮箱，面向相互信任的会话，不是跨用户隔离或权限控制机制。收到消息会唤醒 agent；防止互相重复确认与消息循环由项目协作规则约束。

## 开发与贡献

```bash
git clone https://github.com/icylight/pi-team.git
cd pi-team
npm install --ignore-scripts
npm test
```

运行时依赖由 pi 宿主提供，以 `peerDependencies` 声明；独立运行测试时，npm 安装这些 peer 依赖。测试使用临时目录和测试替身，不访问实际消息邮箱或项目台账。

代码检查由本仓库的 `biome.json` 和 `tsconfig.json` 管理，不继承外部仓库配置。`npm run check` 只读，`npm run fix` 会改写文件；Promise 规则属于 Biome 的实验性规则，不能代替运行测试。`npm run check:types` 检查运行时代码，测试替身由测试执行验证。

检查命令要求环境提供 Biome、TypeScript 和 Node 类型声明；在 pi-config 中检出时由父仓库已有开发依赖提供，独立检出时需另行准备工具。

问题与改动通过 [GitHub Issues](https://github.com/icylight/pi-team/issues) 和 Pull Request 提交。改动跨包事件协议时，两端实现与测试一起更新。

## 许可证

[MIT](LICENSE)，版权归 icylight。
