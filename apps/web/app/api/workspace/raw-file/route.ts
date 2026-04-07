import { fetchControlApi, proxyControlApiResponse } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/workspace/raw-file?path=...
 * Serves a workspace file with the correct Content-Type for inline display.
 * Used by the chain-of-thought component to render images, videos, and PDFs.
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	return proxyControlApiResponse(`/workspace/raw-file?${url.searchParams.toString()}`, {
		method: "GET",
	});
}

/**
 * POST /api/workspace/raw-file?path=...
 * Saves binary data to a workspace file. Used by the spreadsheet editor
 * to write XLSX and other binary formats back to disk.
 */
export async function POST(req: Request) {
	const url = new URL(req.url);
	const upstream = await fetchControlApi(`/workspace/raw-file?${url.searchParams.toString()}`, {
		method: "POST",
		headers: {
			"Content-Type": req.headers.get("Content-Type") ?? "application/octet-stream",
		},
		body: await req.arrayBuffer(),
	});
	const data = await upstream.json().catch(() => ({ error: "Write failed" }));
	return Response.json(data, { status: upstream.status });
}
