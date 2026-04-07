import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/entries/options?${url.searchParams.toString()}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ options: [] }));
  return Response.json(data, { status: upstream.status });
}
