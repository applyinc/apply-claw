import { fetchControlApi } from "@/lib/control-api";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const upstream = await fetchControlApi("/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({ ok: true }));
  return Response.json(data, { status: upstream.status });
}
