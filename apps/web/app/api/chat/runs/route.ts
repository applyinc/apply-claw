import { fetchControlApi } from "@/lib/control-api";

export const runtime = "nodejs";

export async function GET() {
  const upstream = await fetchControlApi("/chat/runs", { method: "GET" });
  const data = await upstream.json().catch(() => ({ parentRuns: [], subagents: [] }));
  return Response.json(data, { status: upstream.status });
}
