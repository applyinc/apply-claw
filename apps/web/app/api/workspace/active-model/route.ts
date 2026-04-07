import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const response = await fetchControlApi("/workspace/active-model", {
    method: "GET",
  });
  const data = await response.json().catch(() => ({ model: null }));

  return Response.json(data, {
    status: response.status,
  });
}
