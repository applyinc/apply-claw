import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const upstream = await fetchControlApi("/apps/cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ error: "Failed" }));
  return Response.json(data, { status: upstream.status });
}

export async function GET() {
  const upstream = await fetchControlApi("/apps/cron", { method: "GET" });
  const data = await upstream.json().catch(() => ({}));
  return Response.json(data, { status: upstream.status });
}
