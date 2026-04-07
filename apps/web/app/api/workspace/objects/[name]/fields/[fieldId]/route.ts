import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string; fieldId: string }> },
) {
  const { name, fieldId } = await params;
  const body = await req.text();
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/fields/${encodeURIComponent(fieldId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to rename field" }));
  return Response.json(data, { status: upstream.status });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string; fieldId: string }> },
) {
  const { name, fieldId } = await params;
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/fields/${encodeURIComponent(fieldId)}`, {
    method: "DELETE",
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to delete field" }));
  return Response.json(data, { status: upstream.status });
}
