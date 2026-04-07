import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const upstream = await fetchControlApi("/profiles", { method: "GET" });
  const data = await upstream.json().catch(() => ({ activeWorkspace: null, workspaces: [] }));
  return Response.json(data, { status: upstream.status });
}
