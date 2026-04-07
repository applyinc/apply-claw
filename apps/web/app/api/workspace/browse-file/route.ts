import { fetchControlApi, proxyControlApiResponse } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
	const url = new URL(req.url);
	if (url.searchParams.get("raw") === "true") {
		return proxyControlApiResponse(`/workspace/browse-file?${url.searchParams.toString()}`, {
			method: "GET",
		});
	}
	const upstream = await fetchControlApi(`/workspace/browse-file?${url.searchParams.toString()}`, {
		method: "GET",
	});
	const data = await upstream.json().catch(() => ({ error: "Cannot read file" }));
	return Response.json(data, { status: upstream.status });
}
