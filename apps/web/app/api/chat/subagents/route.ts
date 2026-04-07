import { fetchControlApi } from "@/lib/control-api";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/chat/subagents${url.search}`, { method: "GET" });
  const data = await upstream.json().catch(() => ({ subagents: [] }));
  return Response.json(data, { status: upstream.status });
}
