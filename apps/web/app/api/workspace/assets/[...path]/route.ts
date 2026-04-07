import { proxyControlApiResponse } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/workspace/assets/<path>
 * Serves an image file from the workspace's assets/ directory.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path;
  if (!segments || segments.length === 0) {
    return new Response("Not found", { status: 404 });
  }
  return proxyControlApiResponse(`/workspace/assets/${segments.join("/")}`, {
    method: "GET",
  });
}
