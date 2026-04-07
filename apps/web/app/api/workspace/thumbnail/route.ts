import { proxyControlApiResponse } from "@/lib/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  return proxyControlApiResponse(`/workspace/thumbnail${url.search}`);
}
