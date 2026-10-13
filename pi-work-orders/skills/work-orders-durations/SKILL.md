---
name: work-orders-durations
description: 只读查询工单库，回答「这条单各阶段花了多久」——阶段时间线、各状态累计耗时（跨打回轮次）、建单到终态总耗时。当用户或角色说「这条单耗时」「阶段耗时」「建单到收口多久」「哪段最慢」「耗时统计」「哪个环节卡得久」时使用。只查不改；查状态、改状态走 work-orders 的 orders_* 工具，不用本 skill。
---

# 工单阶段耗时查询

目的：把 events 表里的状态转换时间戳算成阶段耗时，回答「时间花在哪了」。库不存物化的阶段区间，这份数据全靠推导，查完不留痕。

## 打开库

```bash
sqlite3 -header "file:<项目>/.work-orders/work-orders.sqlite?mode=ro" "<SQL>"
```

- `mode=ro` 只读打开：查询不碰 WAL，不影响正在写库的会话
- 报 `no such table: events`：库是 v2 之前的旧版，CLI 不会触发迁移；先用 orders_* 工具做一次任意写入（或让用户确认后用可写方式打开一次）再查

## 数据依据

- `events` 表每次动作一行；`kind IN ('create','state')` 的行带 `to_state` 和 `at`（ISO 时间戳），连续两行之间就是一段
- 状态名由项目声明（`meta.states`，默认：待认领/在做/待复核/被打回/阻塞/已收口/已取消）。查询不按状态名过滤；按名字筛时先查 `SELECT value_json FROM meta WHERE key='states'` 确认实际用名
- 终态（已收口/已取消）的「耗时」无意义——单已经停了，看阶段效率时排除这两行

## 查询

以下三条都已验证。`<单号>` 换成具体 ID；去掉 `WHERE order_id=...` 就是全库。

**1. 阶段时间线**（每段一行：进入、离开、耗时）

```sql
WITH t AS (SELECT order_id, to_state, at, id FROM events WHERE kind IN ('create','state')),
seg AS (SELECT order_id, to_state, at AS started, LEAD(at) OVER (PARTITION BY order_id ORDER BY id) AS ended FROM t)
SELECT order_id AS 单号, to_state AS 阶段, started AS 进入, COALESCE(ended,'now') AS 离开,
       printf('%.0f m', (julianday(COALESCE(ended,'now')) - julianday(started))*1440) AS 耗时
FROM seg WHERE order_id='<单号>' ORDER BY started;
```

**2. 各状态累计**（打回重做会来回多轮，按状态加总）

```sql
WITH t AS (SELECT order_id, to_state, at, id FROM events WHERE kind IN ('create','state')),
seg AS (SELECT order_id, to_state, at AS started, LEAD(at) OVER (PARTITION BY order_id ORDER BY id) AS ended FROM t)
SELECT order_id AS 单号, to_state AS 阶段,
       printf('%.0f m', SUM((julianday(COALESCE(ended,'now')) - julianday(started))*1440)) AS 累计,
       COUNT(*) AS 轮次
FROM seg WHERE order_id='<单号>' GROUP BY to_state ORDER BY 累计 DESC;
```

**3. 总耗时**（建单 → 进入终态；未到终态的按 now 算）

```sql
SELECT o.id AS 单号, o.created_at AS 建单,
       MAX(CASE WHEN e.to_state IN ('已收口','已取消') THEN e.at END) AS 终态时刻,
       printf('%.0f m', (julianday(COALESCE(MAX(CASE WHEN e.to_state IN ('已收口','已取消') THEN e.at END),'now')) - julianday(o.created_at))*1440) AS 总耗时
FROM orders o LEFT JOIN events e ON e.order_id=o.id AND e.kind='state'
WHERE o.id='<单号>';
```

查询 3 的终态名是默认状态集；项目覆盖过状态名时按 `meta.states` 替换。

## 汇报口径

- 分钟数超过 60 就换算成小时，超过一天换算成天，别报「1440 m」
- 在途单（还没到终态）标注「至今」，和已收口的总耗时分开说
- 用户问「哪段最慢」时用查询 2 排序回答，指出具体状态与轮次；想深挖某一段再上查询 1
