import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const upstream = await fetchControlApi("/memories", { method: "GET" });
  const data = await upstream.json().catch(() => ({ mainMemory: null, dailyLogs: [] }));
  return Response.json(data, { status: upstream.status });
}
