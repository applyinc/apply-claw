import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/workspace/db/introspect?${url.searchParams.toString()}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ tables: [] }));
  return Response.json(data, { status: upstream.status });
}
