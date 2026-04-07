import { proxyControlApiResponse } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const path = segments.join("/");
  return proxyControlApiResponse(`/apps/serve/${path}`);
}
