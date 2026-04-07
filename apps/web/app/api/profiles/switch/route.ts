import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetchControlApi("/profiles/switch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Failed to switch profile" }));
  return Response.json(data, { status: upstream.status });
}
