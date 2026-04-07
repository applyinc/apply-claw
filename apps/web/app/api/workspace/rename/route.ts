import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetchControlApi("/workspace/rename", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Rename failed" }));
  return Response.json(data, { status: upstream.status });
}
