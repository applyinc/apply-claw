import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const upstream = await fetchControlApi("/workspace/watch", {
    method: "GET",
    cache: "no-store",
    signal: req.signal,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": upstream.headers.get("Cache-Control") ?? "no-cache, no-transform",
      Connection: upstream.headers.get("Connection") ?? "keep-alive",
      "X-Accel-Buffering": upstream.headers.get("X-Accel-Buffering") ?? "no",
    },
  });
}
