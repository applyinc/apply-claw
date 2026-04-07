import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstream = await fetchControlApi(`/workspace/link-preview?${url.searchParams.toString()}`, {
    method: "GET",
  });
  const data = await upstream.json().catch(() => ({ error: "Fetch failed" }));
  return Response.json(data, {
    status: upstream.status,
    headers: {
      "Cache-Control": upstream.headers.get("Cache-Control") ?? "public, max-age=86400",
    },
  });
}
