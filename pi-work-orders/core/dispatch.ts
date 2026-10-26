// AI(TAG): [联合调度] 关联业务 ready、责任候选与会话观察；投影不构成派工、认领或可用性承诺。
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { type ObservedSession, observePeers, type PeerObservation } from "../../pi-peer/observe.ts";
import {
	handoffSnapshot,
	listNotifications,
	type Notification,
	notificationPath,
	openNotifications,
} from "./notifications.ts";
import { statesOf } from "./schema.ts";
import { listOrders, readyOrders } from "./store.ts";
import { isHumanActor, type ListedOrder, type StateDef } from "./types.ts";
import { loadWatchConfig, watchConfigFile } from "./watch.ts";

export interface DispatchSession extends ObservedSession {
	activeOrders: string[];
}
export interface DispatchActor {
	name: string;
	human: boolean;
	sessions: DispatchSession[];
}
export interface DispatchOrder {
	id: string;
	ready: boolean;
	readiness: string;
	actors: DispatchActor[];
	notification: { expected: boolean; current?: Notification; previous?: Notification };
}
export interface DispatchSnapshot {
	observedAt: number;
	peers: PeerObservation;
	sessions: DispatchSession[];
	notificationSource: "ok" | "missing" | "error";
	notificationError?: string;
	orders: DispatchOrder[];
}
export function projectDispatch(
	orders: readonly ListedOrder[],
	states: readonly StateDef[],
	readyIds: ReadonlySet<string>,
	peers: PeerObservation,
	currentHandoffs: ReadonlyMap<string, string>,
	notifications: readonly Notification[],
): Pick<DispatchSnapshot, "sessions" | "orders"> {
	const def = (name: string) => states.find((state) => state.name === name);
	const done = states.find((state) => state.terminal === "done")?.name;
	const cancelledState = states.find((state) => state.terminal === "cancelled")?.name;
	const sessions: DispatchSession[] = peers.sessions.map((session) => ({
		...session,
		activeOrders: orders
			.filter(
				(o) =>
					def(o.state)?.singleOwner === true &&
					o.nextActors.some((actor) => actor === session.name || actor === session.roleSlot),
			)
			.map((o) => o.id),
	}));
	const byId = new Map(orders.map((o) => [o.id, o]));
	return {
		sessions,
		orders: orders.map((order) => {
			const ready = readyIds.has(order.id);
			const unresolved = order.dependsOn.filter((id) => !done || byId.get(id)?.state !== done);
			const cancelled = cancelledState ? unresolved.some((id) => byId.get(id)?.state === cancelledState) : false;
			const phase = currentHandoffs.get(order.id);
			const records = notifications.filter((n) => n.orderId === order.id);
			return {
				id: order.id,
				ready,
				readiness: ready
					? def(order.state)?.waiting && def(order.state)?.execution
						? "依赖就绪，可接手"
						: "依赖就绪，非待接手阶段"
					: cancelled
						? "前置取消，需裁定"
						: unresolved.length
							? `等依赖 ${unresolved.join("、")}`
							: "非可开工范围",
				actors: order.nextActors.map((name) => ({
					name,
					human: isHumanActor(name),
					sessions: isHumanActor(name)
						? []
						: sessions.filter(
								(session) => session.name === name || session.roleSlot === name || session.role === name,
							),
				})),
				notification: {
					expected: !!phase,
					current: records.find((n) => n.id === phase),
					previous: records.filter((n) => n.id !== phase).at(-1),
				},
			};
		}),
	};
}

/** 接收只读连接；不迁移业务库、不生成通知记录、不清理 peer 注册表。 */
export function readDispatch(
	db: DatabaseSync,
	ledgerPath: string,
	cwd: string,
	peerRoot: string,
	at = Date.now(),
): DispatchSnapshot {
	const peers = observePeers(peerRoot, cwd, at);
	let notifications: Notification[] = [];
	let notificationSource: DispatchSnapshot["notificationSource"] = "missing";
	let notificationError: string | undefined;
	const file = notificationPath(ledgerPath);
	let queue: DatabaseSync | undefined;
	if (fs.existsSync(file)) {
		try {
			queue = openNotifications(file, true);
			notifications = listNotifications(queue);
			notificationSource = "ok";
		} catch {
			notificationSource = "error";
			notificationError = "通知记录不可读取，结果未知";
		} finally {
			queue?.close();
		}
	}
	// 交接默认不发：没开 workOrders.handoff 就没有「应该有通知」这回事，
	// 否则看板会拿一条永远不会来的交接报缺
	const handoffOn = loadWatchConfig(watchConfigFile(cwd)).config.handoff;
	const current = new Map(handoffOn ? handoffSnapshot(db).map((h) => [h.orderId, h.id]) : []);
	return {
		observedAt: at,
		peers,
		notificationSource,
		notificationError,
		...projectDispatch(
			listOrders(db, { history: true }),
			statesOf(db),
			new Set(readyOrders(db).map((o) => o.id)),
			peers,
			current,
			notifications,
		),
	};
}
