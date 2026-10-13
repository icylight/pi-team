export const dynamic = "force-dynamic";


/**
 * 停掉看板：`/orders web stop` 发 POST 到这里。
 *
 * 响应写完后退出进程——Next 的独立服务无法像原来的 http.Server 那样 close() 回调收摊，
 * 直接 exit 更干脆；带 keep-alive 的连接不会拖住它。
 */
export function POST() {
	setTimeout(() => process.exit(0), 50);
	return Response.json({ stopped: true });
}
