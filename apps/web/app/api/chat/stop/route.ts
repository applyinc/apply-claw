import { fetchControlApi } from "@/lib/control-api";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetchControlApi("/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await upstream.json().catch(() => ({ aborted: false }));
  return Response.json(data, { status: upstream.status });
}
