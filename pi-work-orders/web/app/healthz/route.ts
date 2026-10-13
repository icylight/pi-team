import { ledgers } from "@/lib/ledger";

export const dynamic = "force-dynamic";


/** 存活探针：`/orders web` 靠它判「在没在跑」与「起来没」 */
export function GET() {
	return Response.json({ service: "pi-work-orders-web", version: 1, projects: ledgers().length });
}
