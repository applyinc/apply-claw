import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const upstream = await fetchControlApi("/workspace/context", {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ exists: false }));
  return Response.json(data, { status: upstream.status });
}
