import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const upstream = await fetchControlApi(
    `/workspace/objects/${encodeURIComponent(name)}/actions/runs${new URL(req.url).search}`,
    { method: "GET" },
  );
  const data = await upstream.json().catch(() => ({ runs: [] }));
  return Response.json(data, { status: upstream.status });
}
