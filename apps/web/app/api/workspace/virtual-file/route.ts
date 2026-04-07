import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/workspace/virtual-file?${url.searchParams.toString()}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ error: "Read failed" }));
  return Response.json(data, { status: upstream.status });
}

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetchControlApi("/workspace/virtual-file", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const data = await upstream.json().catch(() => ({ error: "Write failed" }));
  return Response.json(data, { status: upstream.status });
}
