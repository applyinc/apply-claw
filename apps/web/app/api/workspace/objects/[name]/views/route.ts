import { fetchControlApi } from "@/lib/control-api";

type Params = { params: Promise<{ name: string }> };

export async function GET(_req: Request, ctx: Params) {
  const { name } = await ctx.params;
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/views`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ views: [] }));
  return Response.json(data, { status: upstream.status });
}

export async function PUT(req: Request, ctx: Params) {
  const { name } = await ctx.params;
  const body = await req.text();
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/views`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to save views" }));
  return Response.json(data, { status: upstream.status });
}
