import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const body = await req.text();
  const upstream = await fetchControlApi(`/workspace/objects/${encodeURIComponent(name)}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  if (!upstream.ok) {
    const data = await upstream.json().catch(() => ({ error: "Failed to execute action" }));
    return Response.json(data, { status: upstream.status });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Cache-Control": upstream.headers.get("Cache-Control") ?? "no-cache",
      Connection: upstream.headers.get("Connection") ?? "keep-alive",
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
    },
  });
}
