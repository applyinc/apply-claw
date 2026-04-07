import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; name: string }> };

export async function GET(_req: Request, ctx: Params) {
  const { id, name } = await ctx.params;
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/entries/${encodeURIComponent(id)}/content`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ content: "", exists: false }));
  return Response.json(data, { status: upstream.status });
}

export async function PUT(req: Request, ctx: Params) {
  const { id, name } = await ctx.params;
  const body = await req.text();
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/entries/${encodeURIComponent(id)}/content`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to write content" }));
  return Response.json(data, { status: upstream.status });
}
