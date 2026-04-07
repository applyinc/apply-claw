import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/web-sessions${url.search}`, { method: "GET" });
  const data = await upstream.json().catch(() => ({ sessions: [] }));
  return Response.json(data, { status: upstream.status });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const upstream = await fetchControlApi("/web-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to create session" }));
  return Response.json(data, { status: upstream.status });
}
