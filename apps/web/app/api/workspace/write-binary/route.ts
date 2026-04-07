import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const formData = await req.formData();
  const upstream = await fetchControlApi("/workspace/write-binary", {
    method: "POST",
    body: formData,
  });
  const data = await upstream.json().catch(() => ({ error: "Write failed" }));
  return Response.json(data, { status: upstream.status });
}
