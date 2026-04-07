import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/apps/store${url.search}`, { method: "GET" });
  const data = await upstream.json().catch(() => ({}));
  return Response.json(data, { status: upstream.status });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const upstream = await fetchControlApi("/apps/store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ error: "Failed" }));
  return Response.json(data, { status: upstream.status });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/apps/store${url.search}`, { method: "DELETE" });
  const data = await upstream.json().catch(() => ({ error: "Failed" }));
  return Response.json(data, { status: upstream.status });
}
