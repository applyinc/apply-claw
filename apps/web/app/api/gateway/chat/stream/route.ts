import { proxyControlApiStream } from "@/lib/control-api";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  return proxyControlApiStream(`/gateway/chat/stream${url.search}`, { method: "GET" });
}
