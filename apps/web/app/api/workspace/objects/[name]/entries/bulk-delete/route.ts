import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const body = await req.text();
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/entries/bulk-delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to bulk delete entries" }));
  return Response.json(data, { status: upstream.status });
}
