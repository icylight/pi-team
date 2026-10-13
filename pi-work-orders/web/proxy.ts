import { NextResponse, type NextRequest } from "next/server";

/**
 * 只认本机名：浏览器里的恶意页面可能把请求指到 localhost，别给它读到台账。
 * 原 serve.ts 里同一道检查，搬到 Next 的 proxy（Next 16 的 middleware 新名）。
 */
export function proxy(request: NextRequest) {
	const host = (request.headers.get("host") ?? "").split(":")[0].replace(/^\[|\]$/g, "");
	if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
		return NextResponse.json({ error: "只接受来自本机 localhost 的请求" }, { status: 403 });
	}
	return NextResponse.next();
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};