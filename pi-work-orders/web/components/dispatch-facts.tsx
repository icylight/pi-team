import type { DispatchOrder, DispatchSnapshot } from "../../core/dispatch";

const sessionLabels = {
	idle: "采样时空闲",
	busy: "采样时在忙",
	stale: "心跳过期",
	offline: "进程离线",
	unknown: "忙闲未知",
};
const notificationLabels = {
	waiting: "等待投递",
	sending: "传输中，未确认落盘",
	delivered: "消息已落盘，非已认领",
	obsolete: "交接已失效",
	failed: "失败或结果未知",
};

export function DispatchFacts({ item, snapshot }: { item: DispatchOrder; snapshot: DispatchSnapshot }) {
	const current = item.notification.current;
	const missing = snapshot.peers.state === "ok" ? "无匹配会话" : "未找到匹配记录，在线情况未知";
	return (
		<div className="mt-2 border-t pt-2 text-xs leading-relaxed text-muted-foreground" data-dispatch-order={item.id}>
			<p>
				<span className="text-foreground">业务：</span>
				{item.readiness}
			</p>
			<div>
				<span className="text-foreground">会话候选：</span>
				{item.actors.length
					? item.actors.map((actor) => (
							<div key={actor.name} className="mt-1 break-words">
								<span className="text-foreground">{actor.name}</span>
								{actor.human ? " · 人工处理" : !actor.sessions.length ? ` · ${missing}` : null}
								{actor.sessions.map((session) => (
									<div key={session.key} className="pl-2" title={session.reason}>
										{session.name} <span className="font-mono">#{session.key}</span> · {sessionLabels[session.status]}
										{session.lastSeen ? (
											<span> · 心跳 {new Date(session.lastSeen).toISOString()}</span>
										) : (
											<span> · 心跳未知</span>
										)}
										{session.activeOrders.length ? (
											<div>关联在做：{session.activeOrders.join("、")}</div>
										) : (
											<div>未关联在做工单</div>
										)}
									</div>
								))}
							</div>
						))
					: "未指定责任人"}
			</div>
			<p className="mt-1">
				<span className="text-foreground">当前通知：</span>
				{snapshot.notificationSource === "error"
					? "记录不可读，结果未知"
					: current
						? notificationLabels[current.status]
						: item.notification.expected
							? snapshot.notificationSource === "missing"
								? "未发现通知库，结果未知"
								: "尚无本阶段记录"
							: "当前无自动交接"}
			</p>
			{current?.reason ? <p>{current.reason}</p> : null}
			{item.notification.previous ? (
				<p>历史通知：{notificationLabels[item.notification.previous.status]}（不代表当前阶段）</p>
			) : null}
		</div>
	);
}
