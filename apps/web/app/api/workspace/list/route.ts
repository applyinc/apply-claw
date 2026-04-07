import { fetchControlApi } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const response = await fetchControlApi("/workspace/list", {
    method: "GET",
  });
  const data = await response.json().catch(() => ({
    activeWorkspace: null,
    workspaces: [],
  }));

  return Response.json(data, {
    status: response.status,
  });
}
