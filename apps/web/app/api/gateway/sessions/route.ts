import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const upstream = await fetchControlApi(`/gateway/sessions${new URL(req.url).search}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ sessions: [] }));
  return Response.json(data, { status: upstream.status });
}
