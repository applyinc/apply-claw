import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const upstream = await fetchControlApi(`/cron/runs/search-transcript${url.search}`, { method: "GET" });
  const data = await upstream.json().catch(() => ({ error: "Search failed" }));
  return Response.json(data, { status: upstream.status });
}
