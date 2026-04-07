import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const upstream = await fetchControlApi("/cron/jobs", { method: "GET" });
  const data = await upstream.json().catch(() => ({ jobs: [] }));
  return Response.json(data, { status: upstream.status });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const upstream = await fetchControlApi("/cron/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to create job" }));
  return Response.json(data, { status: upstream.status });
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({}));
  const upstream = await fetchControlApi("/cron/jobs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to update job" }));
  return Response.json(data, { status: upstream.status });
}

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => ({}));
  const upstream = await fetchControlApi("/cron/jobs", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to delete job" }));
  return Response.json(data, { status: upstream.status });
}
