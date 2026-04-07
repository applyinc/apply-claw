import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const body = await req.text();
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/display-field`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to update display field" }));
  return Response.json(data, { status: upstream.status });
}
