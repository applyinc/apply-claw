import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/workspace/tree?${url.searchParams.toString()}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({
    tree: [],
    exists: false,
    workspaceRoot: null,
    openclawDir: null,
    workspace: null,
  }));
  return Response.json(data, { status: upstream.status });
}
