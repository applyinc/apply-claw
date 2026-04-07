import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const upstream = await fetchControlApi("/skills", { method: "GET" });
  const data = await upstream.json().catch(() => ({ skills: [] }));
  return Response.json(data, { status: upstream.status });
}
